/* Chhotu's tool executors — the browser half of the assistant.

   Runs against `ChhotuRuntime`, which is built from the live `useLiveTable`
   snapshot plus the existing api-client. Every write therefore lands on the
   SAME endpoints the UI uses (so `fire_order()`, the table capability and the
   one-active-order rule still apply), and every read is the freshest data the
   diner's phone already has.

   Pure enough to unit-test with a fake runtime: no React, no SDK, no browser
   globals. */

import type { CartLine, MenuItem, Order } from "@/lib/api/types";
import { ALLERGY_CAVEAT, scanDishAllergies } from "./allergy";
import { findDish, normalizeDishName, searchDishes } from "./dish-search";
import { recommendDishes, type DietPreference } from "./recommend";
import type { ChhotuAction, ChhotuRuntime, ToolError, ToolExecution } from "./types";
import { estimateWaitTime } from "./wait-time";

const MAX_TOOL_ITEMS = 30;
const SPICE_LABELS = ["Mild", "Medium", "Hot", "Very hot"] as const;
const DIETS: DietPreference[] = ["any", "vegetarian", "non_vegetarian", "jain", "vegan"];

// ---- Argument parsing -------------------------------------------------
// Gemini's structured output is a request, not a guarantee: coerce what is
// usable, reject the rest with a message the model can act on.

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asInteger(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function ok(data: Record<string, unknown>, actions: ChhotuAction[] = [], mutated = false): ToolExecution {
  return { response: { ok: true, data }, actions, mutated };
}

/** Read tools attach the dishes they just talked about, so the sheet can show
 *  them as photo cards. The photos are resolved in the UI (`DishPhoto`), which
 *  is why this passes the MenuItem through untouched. Capped because a card
 *  strip stops being readable past a handful. */
const MAX_CARDS = 6;

function dishCards(items: MenuItem[], label: string): ChhotuAction[] {
  if (items.length === 0) return [];
  return [{ kind: "info", label, ok: true, dishes: items.slice(0, MAX_CARDS) }];
}

function fail(error: ToolError, actions: ChhotuAction[] = [], mutated = false): ToolExecution {
  return { response: { ok: false, error }, actions, mutated };
}

/** Normalise an api-client ApiError (or anything) into a tool error. */
function errorFromException(err: unknown): ToolError {
  if (err && typeof err === "object") {
    const candidate = err as {
      error?: unknown;
      message?: unknown;
      soldOut?: unknown;
      fields?: unknown;
    };
    const message =
      typeof candidate.message === "string" && candidate.message.trim()
        ? candidate.message
        : "That didn't go through. Please try again.";

    if (typeof candidate.error === "string") {
      return {
        code: candidate.error,
        message,
        ...(Array.isArray(candidate.soldOut) && candidate.soldOut.length > 0
          ? { sold_out: candidate.soldOut }
          : {}),
        ...(candidate.fields && typeof candidate.fields === "object" ? { fields: candidate.fields } : {}),
      };
    }
    if (typeof candidate.message === "string" && candidate.message.trim()) {
      return { code: "INTERNAL_ERROR", message };
    }
  }
  return { code: "INTERNAL_ERROR", message: "That didn't go through. Please try again." };
}

function spiceLabel(level: number): string {
  return SPICE_LABELS[Math.min(Math.max(level, 0), 3)] ?? SPICE_LABELS[0];
}

function publicDish(item: MenuItem): Record<string, unknown> {
  const level = item.spice_level ?? 0;
  return {
    menu_item_id: item.id,
    name: item.name,
    price: item.price,
    category: item.category,
    description: item.description,
    vegetarian: item.vegetarian,
    is_available: item.is_available,
    spice_level: level,
    spice_label: spiceLabel(level),
    portion: item.portion_description ?? "",
    diet_tags: item.diet_tags ?? [],
    allergens: item.allergens ?? [],
    ingredients: item.ingredients ?? [],
    metadata_recorded: Boolean(item.ingredients?.length || item.allergens?.length),
  };
}

function ambiguousDish(query: string, candidates: MenuItem[]): ToolExecution {
  return fail({
    code: "AMBIGUOUS_ITEM",
    message: `"${query}" could mean more than one dish. Ask the guest which one they meant.`,
    candidates: candidates.map((item) => ({ menu_item_id: item.id, name: item.name, price: item.price })),
  });
}

function resolveOrFail(
  runtime: ChhotuRuntime,
  query: string,
): { item: MenuItem } | { failure: ToolExecution } {
  const lookup = findDish(runtime.menu, query);
  if (lookup.item) return { item: lookup.item };
  if (lookup.candidates.length > 1) return { failure: ambiguousDish(query, lookup.candidates) };
  return {
    failure: fail({
      code: "MENU_ITEM_NOT_FOUND",
      message: `We don't have "${query}" on today's menu.`,
      suggestions: lookup.candidates.map((item) => item.name),
    }),
  };
}

/** Cart lines for one dish, preferring the caller's own attribution. */
function cartLinesFor(runtime: ChhotuRuntime, menuItemId: string): CartLine[] {
  const all = runtime.cart.filter((line) => line.menu_item_id === menuItemId);
  const own = all.filter((line) => line.added_by.trim().toLowerCase() === runtime.userName.trim().toLowerCase());
  return own.length > 0 ? own : all;
}

function billSplits(runtime: ChhotuRuntime): Record<string, number> {
  const splits: Record<string, number> = {};

  for (const order of runtime.orders) {
    if (order.status === "denied") continue; // refused food is never billed
    for (const item of order.items) {
      const who = item.added_by?.trim() || "Guest";
      splits[who] = (splits[who] ?? 0) + item.price * item.quantity;
    }
  }

  const prices = new Map(runtime.menu.map((item) => [item.id, item.price]));
  for (const line of runtime.cart) {
    const who = line.added_by?.trim() || "Guest";
    splits[who] = (splits[who] ?? 0) + (prices.get(line.menu_item_id) ?? 0) * line.quantity;
  }

  return splits;
}

function summariseCart(runtime: ChhotuRuntime): {
  lines: Record<string, unknown>[];
  item_count: number;
  total: number;
  by_guest: Record<string, number>;
} {
  const prices = new Map(runtime.menu.map((item) => [item.id, item.price]));
  const names = new Map(runtime.menu.map((item) => [item.id, item.name]));

  const lines = runtime.cart.map((line) => ({
    cart_item_id: line.id,
    menu_item_id: line.menu_item_id,
    name: names.get(line.menu_item_id) ?? "Unknown dish",
    quantity: line.quantity,
    unit_price: prices.get(line.menu_item_id) ?? 0,
    line_total: (prices.get(line.menu_item_id) ?? 0) * line.quantity,
    added_by: line.added_by,
    allergy_note: line.allergy_note,
    request_note: line.request_note,
  }));

  const total = lines.reduce((sum, line) => sum + (line.line_total as number), 0);
  const itemCount = lines.reduce((sum, line) => sum + (line.quantity as number), 0);
  const byGuest = lines.reduce<Record<string, number>>((acc, line) => {
    const who = (line.added_by as string) || "Guest";
    acc[who] = (acc[who] ?? 0) + (line.line_total as number);
    return acc;
  }, {});

  return { lines, item_count: itemCount, total, by_guest: byGuest };
}

function latestOrder(orders: Order[]): Order | null {
  return [...orders].sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ?? null;
}

// ---- Executor ---------------------------------------------------------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  runtime: ChhotuRuntime,
): Promise<ToolExecution> {
  switch (name) {
    // ---- Menu -------------------------------------------------------
    case "get_menu": {
      const category = asString(args.category);
      const query = asString(args.query);
      const vegetarian = asBoolean(args.vegetarian);
      const maxPrice = asNumber(args.max_price);

      let dishes = query ? searchDishes(runtime.menu, query, MAX_TOOL_ITEMS) : runtime.menu.slice(0, MAX_TOOL_ITEMS);
      if (category) {
        const needle = normalizeDishName(category);
        dishes = dishes.filter((item) => normalizeDishName(item.category).includes(needle));
      }
      if (vegetarian === true) dishes = dishes.filter((item) => item.vegetarian);
      if (maxPrice !== null) dishes = dishes.filter((item) => item.price <= maxPrice);

      return ok(
        {
          count: dishes.length,
          dishes: dishes.map((item) => ({
            menu_item_id: item.id,
            name: item.name,
            price: item.price,
            category: item.category,
            vegetarian: item.vegetarian,
            is_available: item.is_available,
            spice_level: item.spice_level ?? 0,
            spice_label: spiceLabel(item.spice_level ?? 0),
            portion: item.portion_description ?? "",
          })),
        },
        dishCards(
          dishes,
          dishes.length === 0 ? "Nothing left in that list" : `${dishes.length} on the menu`,
        ),
      );
    }

    case "get_dish_details": {
      const query = asString(args.dish);
      if (!query) return fail({ code: "VALIDATION_ERROR", message: "Which dish should I look up?" });

      const resolved = resolveOrFail(runtime, query);
      if ("failure" in resolved) return resolved.failure;

      return ok(
        {
          dish: publicDish(resolved.item),
          allergy_caveat: ALLERGY_CAVEAT,
          metadata_note: (resolved.item.ingredients?.length ?? 0) === 0 && (resolved.item.allergens?.length ?? 0) === 0
            ? "The kitchen has not recorded ingredients or allergens for this dish. Do not guess them."
            : "",
        },
        dishCards([resolved.item], resolved.item.name),
      );
    }

    case "recommend_dishes": {
      const rawDiet = asString(args.diet);
      const diet = (rawDiet && DIETS.includes(rawDiet as DietPreference) ? rawDiet : "any") as DietPreference;
      const spice = asInteger(args.spice_level);
      const budget = asNumber(args.max_price_per_person);
      const partySize = asInteger(args.party_size);

      const dishes = recommendDishes(runtime.menu, {
        query: asString(args.query) ?? undefined,
        diet,
        spice_level: spice !== null && spice >= 0 ? Math.min(spice, 3) : undefined,
        max_price_per_person: budget !== null && budget >= 0 ? budget : undefined,
        party_size: partySize ?? undefined,
      });

      return ok(
        {
          count: dishes.length,
          criteria: { diet, spice_level: spice, max_price_per_person: budget, party_size: partySize },
          dishes: dishes.map(publicDish),
          note: dishes.length === 0 ? "Nothing on today's menu fits all of those constraints. Offer to relax one." : "",
        },
        dishCards(
          dishes,
          dishes.length === 1 ? "One dish fits" : `${dishes.length} dishes that fit`,
        ),
      );
    }

    case "compare_dishes": {
      const queries = asStringList(args.dishes);
      if (queries.length < 2) {
        return fail({ code: "VALIDATION_ERROR", message: "Give me at least two dishes to compare." });
      }

      const resolved: MenuItem[] = [];
      const missing: string[] = [];
      for (const query of queries) {
        const found = findDish(runtime.menu, query);
        if (found.item) resolved.push(found.item);
        else missing.push(query);
      }
      if (resolved.length < 2) {
        return fail({
          code: missing.length ? "MENU_ITEM_NOT_FOUND" : "AMBIGUOUS_ITEM",
          message: `I couldn't match ${missing.length ? missing.join(", ") : "those dishes"} on today's menu.`,
        });
      }

      return ok(
        {
          dishes: resolved.map(publicDish),
          not_found: missing,
          cheapest: resolved.reduce((best, item) => (item.price < best.price ? item : best)).name,
          priciest: resolved.reduce((best, item) => (item.price > best.price ? item : best)).name,
        },
        dishCards(resolved, `Comparing ${resolved.length}`),
      );
    }

    // ---- Cart -------------------------------------------------------
    case "get_cart": {
      const summary = summariseCart(runtime);
      return ok({
        ...summary,
        line_count: runtime.cart.length,
        bill_status: runtime.billStatus,
      });
    }

    case "add_to_cart": {
      if (!runtime.userName.trim()) {
        return fail({ code: "NAME_REQUIRED", message: "Tell me your name first so the table knows who added it." });
      }

      const query = asString(args.item);
      if (!query) return fail({ code: "VALIDATION_ERROR", message: "Which dish should I add?" });

      const resolved = resolveOrFail(runtime, query);
      if ("failure" in resolved) return resolved.failure;

      const item = resolved.item;
      if (!item.is_available) {
        return fail(
          { code: "ITEM_UNAVAILABLE", message: `${item.name} just ran out — the kitchen has taken it off today.` },
          [{ kind: "cart", label: `${item.name} is out of stock`, ok: false }],
        );
      }

      const quantity = asInteger(args.quantity) ?? 1;
      if (quantity < 1 || quantity > 99) {
        return fail({ code: "VALIDATION_ERROR", message: "Quantity must be between 1 and 99." });
      }

      const allergyNote = asString(args.allergy_note) ?? "";
      const requestNote = asString(args.request_note) ?? "";

      let totalTableQuantity = quantity;
      try {
        const line = await runtime.addCartItem({
          menu_item_id: item.id,
          quantity,
          added_by: runtime.userName,
          ...(allergyNote ? { allergy_note: allergyNote } : {}),
          ...(requestNote ? { request_note: requestNote } : {}),
        });
        totalTableQuantity = line.total_table_quantity ?? quantity;

        /* Keep the runtime's snapshot in step for the REST of this turn: a
           model that adds a dish and then reads the cart must not be told the
           cart is unchanged. The server row is authoritative (it may have
           merged into a note-identical line). */
        const nextLine: CartLine = {
          id: line.id,
          table_id: line.table_id,
          menu_item_id: line.menu_item_id,
          quantity: line.quantity,
          request_note: line.request_note,
          allergy_note: line.allergy_note,
          added_by: line.added_by,
        };
        runtime.cart = runtime.cart.some((existing) => existing.id === line.id)
          ? runtime.cart.map((existing) => (existing.id === line.id ? nextLine : existing))
          : [...runtime.cart, nextLine];
      } catch (err) {
        return fail(errorFromException(err));
      }

      const notes = [allergyNote && `allergy: ${allergyNote}`, requestNote].filter(Boolean).join(", ");
      const label = `Added ${quantity}× ${item.name}${notes ? ` (${notes})` : ""} to the table cart`;

      return ok(
        {
          added: { menu_item_id: item.id, name: item.name, quantity, unit_price: item.price },
          allergy_note: allergyNote,
          request_note: requestNote,
          added_by: runtime.userName,
          cart_total_quantity: totalTableQuantity,
        },
        [{ kind: "cart", label, ok: true }],
        true,
      );
    }

    case "update_cart_item": {
      const query = asString(args.item);
      if (!query) return fail({ code: "VALIDATION_ERROR", message: "Which cart line should I change?" });

      const resolved = resolveOrFail(runtime, query);
      if ("failure" in resolved) return resolved.failure;

      const lines = cartLinesFor(runtime, resolved.item.id);
      if (lines.length === 0) {
        return fail({
          code: "CART_ITEM_NOT_FOUND",
          message: `${resolved.item.name} is not in the table cart yet.`,
        });
      }
      if (lines.length > 1) {
        return fail({
          code: "AMBIGUOUS_CART_LINE",
          message: `There are ${lines.length} separate lines of ${resolved.item.name}. Ask which one to change.`,
          candidates: lines.map((line) => ({
            cart_item_id: line.id,
            quantity: line.quantity,
            added_by: line.added_by,
            allergy_note: line.allergy_note,
            request_note: line.request_note,
          })),
        });
      }

      const line = lines[0] as CartLine;
      const quantity = asInteger(args.quantity);
      const delta = asInteger(args.quantity_delta);
      const requestNote = asString(args.request_note);
      const allergyNote = asString(args.allergy_note);

      if (quantity !== null && (quantity < 1 || quantity > 99)) {
        return fail({ code: "VALIDATION_ERROR", message: "Quantity must be between 1 and 99." });
      }
      if (delta !== null && (delta === 0 || delta < -99 || delta > 99)) {
        return fail({ code: "VALIDATION_ERROR", message: "A change of quantity must be between -99 and 99, and not 0." });
      }
      if (quantity === null && delta === null && requestNote === null && allergyNote === null) {
        return fail({ code: "VALIDATION_ERROR", message: "Say what should change: quantity, request note or allergy note." });
      }

      try {
        const updated = await runtime.updateCartItem(line.id, {
          ...(quantity !== null ? { quantity } : {}),
          ...(delta !== null ? { quantity_delta: delta } : {}),
          ...(requestNote !== null ? { request_note: requestNote } : {}),
          ...(allergyNote !== null ? { allergy_note: allergyNote } : {}),
        });
        runtime.cart = runtime.cart.map((existing) =>
          existing.id === updated.id
            ? {
                id: updated.id,
                table_id: updated.table_id,
                menu_item_id: updated.menu_item_id,
                quantity: updated.quantity,
                request_note: updated.request_note,
                allergy_note: updated.allergy_note,
                added_by: updated.added_by,
              }
            : existing,
        );
      } catch (err) {
        return fail(errorFromException(err));
      }

      return ok(
        {
          updated: {
            cart_item_id: line.id,
            name: resolved.item.name,
            quantity: quantity ?? line.quantity + (delta ?? 0),
            allergy_note: allergyNote ?? line.allergy_note,
            request_note: requestNote ?? line.request_note,
          },
        },
        [{ kind: "cart", label: `Updated ${resolved.item.name} in the table cart`, ok: true }],
        true,
      );
    }

    case "remove_from_cart": {
      const query = asString(args.item);
      if (!query) return fail({ code: "VALIDATION_ERROR", message: "Which dish should I remove?" });

      const resolved = resolveOrFail(runtime, query);
      if ("failure" in resolved) return resolved.failure;

      const lines = cartLinesFor(runtime, resolved.item.id);
      if (lines.length === 0) {
        return fail({
          code: "CART_ITEM_NOT_FOUND",
          message: `${resolved.item.name} is not in the table cart.`,
        });
      }
      if (lines.length > 1) {
        return fail({
          code: "AMBIGUOUS_CART_LINE",
          message: `There are ${lines.length} separate lines of ${resolved.item.name}. Ask which one to take off.`,
          candidates: lines.map((line) => ({
            cart_item_id: line.id,
            quantity: line.quantity,
            added_by: line.added_by,
            allergy_note: line.allergy_note,
            request_note: line.request_note,
          })),
        });
      }

      const line = lines[0] as CartLine;
      try {
        await runtime.removeCartItem(line.id);
        runtime.cart = runtime.cart.filter((existing) => existing.id !== line.id);
      } catch (err) {
        return fail(errorFromException(err));
      }

      return ok(
        { removed: { cart_item_id: line.id, name: resolved.item.name, quantity: line.quantity } },
        [{ kind: "cart", label: `Removed ${resolved.item.name} from the table cart`, ok: true }],
        true,
      );
    }

    case "clear_cart": {
      if (runtime.cart.length === 0) {
        return ok({ removed: 0, failed: 0 }, [], false);
      }

      let removed = 0;
      const failed: string[] = [];
      for (const line of [...runtime.cart]) {
        try {
          await runtime.removeCartItem(line.id);
          removed += 1;
        } catch {
          failed.push(line.id);
        }
      }

      if (failed.length > 0) {
        runtime.cart = runtime.cart.filter((line) => failed.includes(line.id));
        return fail(
          {
            code: "PARTIAL_CLEAR",
            message: `I cleared ${removed} of the table cart's lines. Some could not be removed.`,
            failed,
          },
          [{ kind: "cart", label: `Cleared ${removed} lines; ${failed.length} failed`, ok: false }],
          removed > 0,
        );
      }

      runtime.cart = [];
      return ok(
        { removed, failed: 0 },
        [{ kind: "cart", label: `Cleared ${removed} ${removed === 1 ? "line" : "lines"} from the table cart`, ok: true }],
        true,
      );
    }

    // ---- Orders -----------------------------------------------------
    case "review_and_fire_order": {
      if (runtime.cart.length === 0) {
        return fail({ code: "EMPTY_CART", message: "The table cart is empty — there is nothing to send." });
      }

      /* ONE ROUND AT A TIME: the database allows a single active ticket per
         table, so a second fire can never succeed. Detecting it here means the
         guest hears the reason and the way out instead of a bare 409 — and the
         lines they added stay in the table cart for the next round. */
      const activeOrder = runtime.orders.find((order) =>
        ["pending", "preparing", "ready"].includes(order.status),
      );
      if (activeOrder) {
        return fail({
          code: "ORDER_IN_PROGRESS",
          message: `Table ${activeOrder.table_code} already has a round with the kitchen (${activeOrder.status}). One order goes to the kitchen at a time, so this cart cannot be fired yet. Everything added is safe in the table cart — fire again as soon as that order is served.`,
          active_order: { order_id: activeOrder.id, status: activeOrder.status },
          cart_lines: runtime.cart.length,
        });
      }

      const summary = summariseCart(runtime);

      try {
        const order = await runtime.fireOrder();
        // fire_order() drains the cart server-side; mirror that for this turn.
        runtime.cart = [];
        return ok(
          {
            order_id: order.order_id,
            status: order.status,
            item_count: summary.item_count,
            total: summary.total,
            message: order.message,
          },
          [{ kind: "order", label: `Fired ${summary.item_count} ${summary.item_count === 1 ? "item" : "items"} to the kitchen`, ok: true }],
          true,
        );
      } catch (err) {
        const error = errorFromException(err);

        // Another device fired between our read and the write: same guidance,
        // and the server did not drain this cart.
        if (error.code === "DUPLICATE_ORDER") {
          return fail({
            code: "ORDER_IN_PROGRESS",
            message:
              "This table already has a round with the kitchen, and one order goes at a time. Everything added is safe in the table cart — fire again as soon as that order is served.",
            cart_lines: runtime.cart.length,
          });
        }

        // INVENTORY_FAILURE purges the sold-out lines server-side, so the cart
        // on screen is stale even though the fire failed.
        const mutated = error.code === "INVENTORY_FAILURE";
        return fail(error, [{ kind: "order", label: error.message, ok: false }], mutated);
      }
    }

    case "get_order_status": {
      const order = latestOrder(runtime.orders);
      if (!order) {
        return ok({
          active_order: null,
          cart_lines: runtime.cart.length,
          message:
            runtime.cart.length > 0
              ? `${runtime.cart.length} ${runtime.cart.length === 1 ? "line is" : "lines are"} staged; nothing has been fired yet.`
              : "Nothing has been ordered for this table yet.",
        });
      }

      const now = runtime.now?.() ?? Date.now();
      const elapsed = Math.max(0, Math.round((now - new Date(order.created_at).getTime()) / 60_000));

      return ok({
        order: {
          order_id: order.id,
          status: order.status,
          is_active: ["pending", "preparing", "ready"].includes(order.status),
          denial_reason: order.denial_reason || "",
          created_at: order.created_at,
          elapsed_minutes: elapsed,
          items: order.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            added_by: item.added_by,
            allergy_note: item.allergy_note,
          })),
        },
        cart_lines: runtime.cart.length,
        ...(["pending", "preparing", "ready"].includes(order.status)
          ? {
              next_round_note:
                "This table already has a round with the kitchen. Lines added now stay in the cart and can be fired once that order is served.",
            }
          : {}),
      });
    }

    case "get_estimated_wait_time": {
      const estimate = estimateWaitTime(runtime.orders, runtime.cart, runtime.menu);
      return ok({ ...estimate });
    }

    case "request_bill": {
      const splits = billSplits(runtime);

      if (runtime.billStatus !== "unrequested") {
        return ok({
          bill_status: runtime.billStatus,
          already_requested: true,
          splits,
          message:
            runtime.billStatus === "paid"
              ? "This bill is already settled."
              : "The bill has already been requested for this table.",
        });
      }

      try {
        const bill = await runtime.requestBill();
        runtime.billStatus = bill.bill_status;
        return ok(
          {
            bill_status: bill.bill_status,
            bill_requested_at: bill.bill_requested_at,
            splits,
            message: "The floor has been asked for the bill.",
          },
          [{ kind: "bill", label: "Asked the floor for the bill", ok: true }],
          true,
        );
      } catch (err) {
        return fail(errorFromException(err));
      }
    }

    // ---- Allergy ----------------------------------------------------
    case "check_allergy_safety": {
      const dishNames = asStringList(args.dishes);
      const allergies = asStringList(args.reported_allergies);

      if (dishNames.length === 0) {
        return fail({ code: "VALIDATION_ERROR", message: "Which dishes should I screen?" });
      }
      if (allergies.length === 0) {
        return fail({ code: "VALIDATION_ERROR", message: "Which allergies should I screen for?" });
      }

      const results: Record<string, unknown>[] = [];
      const unresolved: { query: string; candidates: string[] }[] = [];

      for (const query of dishNames) {
        const found = findDish(runtime.menu, query);
        if (!found.item) {
          unresolved.push({ query, candidates: found.candidates.map((item) => item.name) });
          continue;
        }
        const scan = scanDishAllergies(found.item, allergies);
        results.push({
          dish: scan.dish,
          menu_item_id: found.item.id,
          status: scan.status,
          matched_terms: scan.matches,
          declared_allergens: found.item.allergens ?? [],
          ingredients: found.item.ingredients ?? [],
        });
      }

      return ok({
        results,
        unresolved,
        reported_allergies: allergies,
        can_confirm_safe: false,
        caveat: ALLERGY_CAVEAT,
      });
    }

    // ---- Feedback ---------------------------------------------------
    case "leave_feedback": {
      const rating = asInteger(args.rating);
      if (rating === null || rating < 1 || rating > 5) {
        return fail({ code: "VALIDATION_ERROR", message: "Ask for a rating from 1 to 5 stars." });
      }

      const comment = (asString(args.comment) ?? "").slice(0, 500);

      try {
        const saved = await runtime.leaveFeedback({ rating, ...(comment ? { comment } : {}) });
        return ok(
          { feedback_id: saved.feedback_id, rating: saved.rating, comment },
          [{ kind: "info", label: `Thanks — saved your ${rating}-star feedback`, ok: true }],
          true,
        );
      } catch (err) {
        return fail(errorFromException(err));
      }
    }

    default:
      return fail({ code: "UNKNOWN_TOOL", message: `Unknown tool "${name}".` });
  }
}

/** Exposed for the sheet's human-readable activity label. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "add_to_cart": {
      const dish = asString(args.item) ?? "a dish";
      const quantity = asInteger(args.quantity) ?? 1;
      return `Adding ${quantity}× ${dish}…`;
    }
    case "update_cart_item": return `Updating ${asString(args.item) ?? "the cart"}…`;
    case "remove_from_cart": return `Removing ${asString(args.item) ?? "a dish"}…`;
    case "clear_cart": return "Clearing the table cart…";
    case "review_and_fire_order": return "Sending the order to the kitchen…";
    case "request_bill": return "Asking the floor for the bill…";
    case "get_menu": return "Checking today's menu…";
    case "get_dish_details": return `Looking up ${asString(args.dish) ?? "that dish"}…`;
    case "recommend_dishes": return "Finding dishes that fit…";
    case "compare_dishes": return "Comparing those dishes…";
    case "check_allergy_safety": return "Checking allergies against the recipe…";
    case "get_estimated_wait_time": return "Checking the kitchen queue…";
    case "get_order_status": return "Checking your order…";
    case "get_cart": return "Reading the table cart…";
    case "leave_feedback": return "Saving your feedback…";
    default: return "Working on it…";
  }
}
