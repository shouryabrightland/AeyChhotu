/* The kitchen assistant's tool executors.

   Everything here runs in the browser and goes through the SAME API calls the
   Kanban board uses (useLiveKds), so there is no second write path and no new
   server surface. The kitchen shift token is bound by the api-client; it is
   never a tool argument.

   TWO GUARDRAILS LIVE HERE:

   1. Tickets are resolved by TABLE CODE, not by order id, and an ambiguous
      reference (`table 4` matching two open tickets) is refused rather than
      guessed. Cooks say numbers; the board is the source of truth.
   2. Destructive actions (deny a ticket, 86 a dish) are PARKED. The model gets
      CONFIRMATION_REQUIRED and must come back through `confirm_action` after
      the chef says yes. The pending action is held in this closure, not in the
      model's context, so a hallucinated "confirmed: true" argument cannot fire
      it — only a second tool call can, and only against the action that was
      actually parked.

   Pure enough to unit-test with a fake `KitchenRuntime`. */

import type { MenuItem, Order } from "@/lib/api/types";
import type { ChhotuAction, ToolError, ToolExecution } from "./types";

export interface KitchenRuntime {
  /** The live board. Read fresh on every call — never a stale render copy. */
  tickets: Order[];
  /** The live catalogue, for resolving a spoken dish name. */
  menu: MenuItem[];
  /** Injectable clock so ticket age is testable. */
  now?: () => number;
  refresh(): Promise<void>;
  moveTicket(order: Order, next: "preparing" | "ready"): Promise<ToolResult>;
  serveTicket(order: Order): Promise<ToolResult>;
  denyTicket(order: Order, reason: string): Promise<ToolResult>;
  setAvailability(menuItemId: string, isAvailable: boolean): Promise<ToolResult>;
  startShift(): Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  message?: string;
}

export interface KitchenToolset {
  execute(name: string, args: Record<string, unknown>): Promise<ToolExecution>;
  describe(name: string, args: Record<string, unknown>): string;
  /** The parked destructive action, for the UI's "waiting for your yes" chip. */
  pendingDescription(): string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asOptionalBoolean(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function ok(data: Record<string, unknown>, actions: ChhotuAction[] = []): ToolExecution {
  return { response: { ok: true, data }, actions, mutated: false };
}

function fail(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  actions: ChhotuAction[] = [],
): ToolExecution {
  const error: ToolError = { code, message, ...extra };
  return { response: { ok: false, error }, actions, mutated: false };
}

/** Lowercase, punctuation-free comparison key for spoken names. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/^table\s*/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function digitsOf(value: string): string {
  return (value.match(/\d+/g) ?? []).join("").replace(/^0+/, "");
}

/** "T04", "4" and "table 4" all address the same ticket. */
function sameTable(code: string, reference: string): boolean {
  const left = normalize(code);
  const right = normalize(reference);
  if (!left || !right) return false;
  if (left === right) return true;

  const leftDigits = digitsOf(code);
  const rightDigits = digitsOf(reference);
  return leftDigits.length > 0 && leftDigits === rightDigits;
}

function findTicket(
  tickets: Order[],
  reference: string,
): { order: Order } | { candidates: Order[] } {
  const exact = tickets.filter((ticket) => sameTable(ticket.table_code, reference));
  if (exact.length === 1) return { order: exact[0] as Order };

  const loose = tickets.filter((ticket) => {
    const code = normalize(ticket.table_code);
    const wanted = normalize(reference);
    return (
      (code.length > 0 && wanted.length > 0 && code.includes(wanted)) ||
      (code.length > 0 && wanted.length > 0 && wanted.includes(code))
    );
  });

  if (exact.length > 1) return { candidates: exact };
  if (loose.length === 1) return { order: loose[0] as Order };
  return { candidates: loose };
}

function findDish(
  menu: MenuItem[],
  reference: string,
): { dish: MenuItem } | { candidates: MenuItem[] } {
  const wanted = normalize(reference);
  if (!wanted) return { candidates: [] };

  const exact = menu.filter((item) => normalize(item.name) === wanted);
  const exactDish = exact.at(0);
  if (exact.length === 1 && exactDish) return { dish: exactDish };

  const partial = menu.filter((item) => {
    const name = normalize(item.name);
    return name.length > 0 && (name.includes(wanted) || wanted.includes(name));
  });
  const partialDish = partial.at(0);
  if (partial.length === 1 && partialDish) return { dish: partialDish };

  return { candidates: exact.length > 1 ? exact : partial };
}

function summarizeTicket(order: Order, nowMs: number) {
  const created = Date.parse(order.created_at);
  const ageMinutes = Number.isFinite(created)
    ? Math.max(0, Math.round((nowMs - created) / 60_000))
    : null;

  const items = order.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    ...(item.request_note ? { request: item.request_note } : {}),
    ...(item.allergy_note ? { allergy: item.allergy_note } : {}),
    ...(item.added_by ? { ordered_by: item.added_by } : {}),
  }));

  const allergies = [
    ...new Set(
      order.items
        .map((item) => item.allergy_note)
        .filter((note): note is string => Boolean(note && note.trim())),
    ),
  ];

  return {
    table: order.table_code,
    status: order.status,
    age_minutes: ageMinutes,
    order_id: order.id,
    items,
    allergy_notes: allergies,
  };
}

const MOVE_ALIASES: Record<string, "preparing" | "ready"> = {
  preparing: "preparing",
  prepare: "preparing",
  cooking: "preparing",
  cook: "preparing",
  start: "preparing",
  started: "preparing",
  ready: "ready",
  done: "ready",
  cooked: "ready",
  plated: "ready",
};

interface PendingAction {
  description: string;
  run: () => Promise<ToolExecution>;
}

/** One toolset per session. The parked action lives in this closure. */
export function createKitchenToolset(runtime: KitchenRuntime): KitchenToolset {
  let pending: PendingAction | null = null;

  function clock(): number {
    return runtime.now?.() ?? Date.now();
  }

  function openTables(): string[] {
    return [...new Set(runtime.tickets.map((ticket) => ticket.table_code))];
  }

  async function runWrite(
    result: ToolResult,
    label: string,
    failureCode: string,
  ): Promise<ToolExecution> {
    if (!result.ok) {
      return fail(failureCode, result.message ?? "The board did not accept that change.");
    }
    return { response: { ok: true, data: { done: label } }, actions: [{ kind: "order", label, ok: true }], mutated: true };
  }

  async function execute(name: string, args: Record<string, unknown>): Promise<ToolExecution> {
    switch (name) {
      case "get_board_overview": {
        const tickets = runtime.tickets;
        const nowMs = clock();
        const counts = { pending: 0, preparing: 0, ready: 0 };
        for (const ticket of tickets) {
          if (ticket.status === "pending") counts.pending += 1;
          else if (ticket.status === "preparing") counts.preparing += 1;
          else if (ticket.status === "ready") counts.ready += 1;
        }

        const oldest = tickets
          .map((ticket) => summarizeTicket(ticket, nowMs))
          .reduce<(ReturnType<typeof summarizeTicket>) | null>((worst, ticket) => {
            if (!worst) return ticket;
            return (ticket.age_minutes ?? 0) > (worst.age_minutes ?? 0) ? ticket : worst;
          }, null);

        return ok(
          {
            counts,
            total: counts.pending + counts.preparing + counts.ready,
            pending_tables: tickets
              .filter((ticket) => ticket.status === "pending")
              .map((ticket) => ticket.table_code),
            ready_tables: tickets
              .filter((ticket) => ticket.status === "ready")
              .map((ticket) => ticket.table_code),
            oldest,
            note:
              tickets.length === 0
                ? "The board is empty. Say so; do not invent tickets."
                : "Read allergies first when a ticket has them.",
          },
          [
            {
              kind: "info",
              label: `${counts.pending} pending · ${counts.preparing} cooking · ${counts.ready} ready`,
              ok: true,
            },
          ],
        );
      }

      case "list_tickets": {
        const wanted = asString(args.status);
        const nowMs = clock();
        const tickets = wanted
          ? runtime.tickets.filter((ticket) => ticket.status === wanted)
          : runtime.tickets;

        return ok(
          {
            count: tickets.length,
            status: wanted ?? "all",
            tickets: tickets.map((ticket) => summarizeTicket(ticket, nowMs)),
            note:
              tickets.length === 0
                ? "Nothing in that lane. Do not invent a ticket."
                : "Mention any allergy_note before the dishes.",
          },
          tickets.length > 0
            ? [{ kind: "info", label: `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`, ok: true }]
            : [],
        );
      }

      case "move_ticket": {
        const reference = asString(args.table);
        if (!reference) {
          return fail("MISSING_TABLE", "Which table? Say the table code.", {
            open_tables: openTables(),
          });
        }

        const rawStatus = asString(args.status);
        const target = rawStatus ? MOVE_ALIASES[rawStatus.toLowerCase()] : undefined;
        if (!target) {
          return fail("INVALID_STATUS", "Move a ticket to preparing or ready.", {
            allowed: ["preparing", "ready"],
          });
        }

        const match = findTicket(runtime.tickets, reference);
        if ("candidates" in match) {
          return fail(
            "TICKET_NOT_FOUND",
            match.candidates.length > 1
              ? `More than one ticket matches "${reference}". Ask which one.`
              : `No open ticket matches table "${reference}".`,
            {
              candidates: match.candidates.map((ticket) => ({
                table: ticket.table_code,
                status: ticket.status,
              })),
              open_tables: openTables(),
            },
          );
        }

        const ticket = match.order;
        if (ticket.status === target) {
          return ok(
            { table: ticket.table_code, status: ticket.status, unchanged: true },
            [{ kind: "order", label: `${ticket.table_code} is already ${target}`, ok: true }],
          );
        }

        if (ticket.status === "ready") {
          return fail(
            "INVALID_TRANSITION",
            `Table ${ticket.table_code} is already Ready. Use serve_ticket to clear it.`,
            { current_status: "ready" },
          );
        }

        const allowed = ticket.status === "pending" ? "preparing" : "ready";
        if (target !== allowed) {
          return fail(
            "INVALID_TRANSITION",
            `Table ${ticket.table_code} is ${ticket.status}; it can only move to ${allowed}. Tickets move one lane at a time.`,
            { current_status: ticket.status, requested_status: target },
          );
        }

        const result = await runtime.moveTicket(ticket, target);
        return runWrite(result, `${ticket.table_code} → ${target}`, "UPDATE_FAILED");
      }

      case "serve_ticket": {
        const reference = asString(args.table);
        if (!reference) {
          return fail("MISSING_TABLE", "Which table is going out?", { open_tables: openTables() });
        }

        const match = findTicket(runtime.tickets, reference);
        if ("candidates" in match) {
          return fail(
            "TICKET_NOT_FOUND",
            match.candidates.length > 1
              ? `More than one ticket matches "${reference}".`
              : `No open ticket matches table "${reference}".`,
            { candidates: match.candidates.map((t) => ({ table: t.table_code, status: t.status })) },
          );
        }

        const ticket = match.order;
        if (ticket.status !== "ready") {
          return fail(
            "INVALID_TRANSITION",
            `Table ${ticket.table_code} is ${ticket.status}. Only a Ready ticket can be served — move it to Ready first.`,
            { current_status: ticket.status },
          );
        }

        const result = await runtime.serveTicket(ticket);
        return runWrite(result, `${ticket.table_code} served`, "UPDATE_FAILED");
      }

      case "deny_ticket": {
        const reference = asString(args.table);
        const reason = asString(args.reason);
        if (!reference) return fail("MISSING_TABLE", "Which table's order is being refused?");
        if (!reason) {
          return fail("MISSING_REASON", "Ask the chef why, in a few words the guest can read.");
        }

        const match = findTicket(runtime.tickets, reference);
        if ("candidates" in match) {
          return fail(
            "TICKET_NOT_FOUND",
            match.candidates.length > 1
              ? `More than one ticket matches "${reference}".`
              : `No open ticket matches table "${reference}".`,
            { candidates: match.candidates.map((t) => ({ table: t.table_code, status: t.status })) },
          );
        }

        const ticket = match.order;
        const description = `Deny table ${ticket.table_code} (${reason})`;
        pending = {
          description,
          run: async () => {
            const result = await runtime.denyTicket(ticket, reason);
            return runWrite(result, `Table ${ticket.table_code} denied`, "UPDATE_FAILED");
          },
        };

        return fail(
          "CONFIRMATION_REQUIRED",
          `Nothing has changed yet. Confirm with the chef out loud: deny table ${ticket.table_code}'s order because "${reason}". Then call confirm_action.`,
          { waiting_for: "spoken_yes", action: description },
          [{ kind: "order", label: `Waiting for your yes: ${description}`, ok: false }],
        );
      }

      case "set_dish_availability": {
        const reference = asString(args.dish);
        const available = asOptionalBoolean(args.available);
        if (!reference) return fail("MISSING_DISH", "Which dish?");
        if (available === null) {
          return fail("MISSING_FLAG", "Say whether the dish should be available or 86'd.");
        }

        const match = findDish(runtime.menu, reference);
        if ("candidates" in match) {
          if (match.candidates.length === 0) {
            return fail("DISH_NOT_FOUND", `No live dish matches "${reference}".`, {
              dishes: runtime.menu.map((item) => item.name).slice(0, 30),
            });
          }
          return fail(
            "AMBIGUOUS_DISH",
            `More than one dish matches "${reference}". Ask which one.`,
            { candidates: match.candidates.map((item) => item.name) },
          );
        }

        const dish = match.dish;
        if (dish.is_available === available) {
          return ok(
            { dish: dish.name, available, unchanged: true },
            [
              {
                kind: "info",
                label: `${dish.name} is already ${available ? "on the menu" : "86"}`,
                ok: true,
              },
            ],
          );
        }

        if (available) {
          const result = await runtime.setAvailability(dish.id, true);
          return runWrite(result, `${dish.name} back on the menu`, "UPDATE_FAILED");
        }

        const description = `Mark ${dish.name} 86`;
        pending = {
          description,
          run: async () => {
            const result = await runtime.setAvailability(dish.id, false);
            return runWrite(result, `${dish.name} marked 86`, "UPDATE_FAILED");
          },
        };

        return fail(
          "CONFIRMATION_REQUIRED",
          `Nothing has changed yet. Confirm with the chef out loud that ${dish.name} is finished (86). Then call confirm_action.`,
          { waiting_for: "spoken_yes", action: description },
          [{ kind: "info", label: `Waiting for your yes: ${description}`, ok: false }],
        );
      }

      case "confirm_action": {
        const confirmed = asOptionalBoolean(args.confirm);
        const parked = pending;
        pending = null;

        if (!parked) {
          return fail("NOTHING_TO_CONFIRM", "There is no action waiting for a yes or no.");
        }

        if (confirmed !== true) {
          return ok(
            { cancelled: parked.description },
            [{ kind: "info", label: `Cancelled: ${parked.description}`, ok: true }],
          );
        }

        return parked.run();
      }

      case "start_shift": {
        const result = await runtime.startShift();
        if (!result.ok) {
          return fail("SHIFT_FAILED", result.message ?? "The shift could not be armed.");
        }
        return ok(
          { started: true },
          [{ kind: "info", label: "Shift armed — new tickets will chime", ok: true }],
        );
      }

      default:
        return fail("UNKNOWN_TOOL", `Unknown kitchen tool "${name}".`);
    }
  }

  return {
    execute,
    pendingDescription: () => pending?.description ?? null,
    describe: (name, args) => {
      switch (name) {
        case "get_board_overview":
          return "Reading the board…";
        case "list_tickets":
          return "Reading the tickets…";
        case "move_ticket":
          return `Moving ${asString(args.table) ?? "the ticket"}…`;
        case "serve_ticket":
          return `Serving ${asString(args.table) ?? "the ticket"}…`;
        case "deny_ticket":
          return "Checking the refusal…";
        case "set_dish_availability":
          return "Checking the menu…";
        case "confirm_action":
          return "Applying that…";
        case "start_shift":
          return "Arming the shift…";
        default:
          return "Working on it…";
      }
    },
  };
}
