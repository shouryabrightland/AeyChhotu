/* The manager console's tool executors.
 *
 * These are READ-ONLY on purpose. The console's AI answers questions; every
 * destructive action (archive, deactivate, clear, re-price) stays behind a
 * button a human presses. A model that can talk itself into "clear table 4"
 * is a liability, and the admin token is the most powerful credential in the
 * product.
 *
 * The credential is NOT a tool argument: `AdminRuntime` is built by the
 * component from api-client calls that attach the role:"admin" JWT, so a
 * prompt can never point a query at a wider scope than the session already
 * has. The backend independently re-checks the role (requireRole("admin")),
 * which is what makes this safe even if the UI is bypassed.
 *
 * Pure enough to unit-test with a fake runtime. */

import type {
  AdminBestSeller,
  AdminCatalogItem,
  AdminFeedback,
  AdminInventory,
  AdminOccupancy,
  AdminPendingOrder,
  AdminSalesSummary,
} from "@/lib/api-client";
import type { ChhotuAction, ToolError, ToolExecution } from "./types";

export interface AdminRuntime {
  salesSummary(): Promise<AdminSalesSummary>;
  bestSelling(limit: number, days: number): Promise<AdminBestSeller[]>;
  pendingOrders(): Promise<AdminPendingOrder[]>;
  occupancy(): Promise<AdminOccupancy>;
  inventory(): Promise<AdminInventory>;
  feedback(limit: number): Promise<AdminFeedback[]>;
  /** Every live dish with its ingredients, allergens, spice and diet tags. */
  catalog(): Promise<AdminCatalogItem[]>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function ok(data: Record<string, unknown>, actions: ChhotuAction[] = []): ToolExecution {
  return { response: { ok: true, data }, actions, mutated: false };
}

function fail(code: string, message: string): ToolExecution {
  const error: ToolError = { code, message };
  return { response: { ok: false, error }, actions: [], mutated: false };
}

function clamped(value: number | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Percent change, or null when there is no baseline to compare against. */
function delta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function executeAdminTool(
  name: string,
  args: Record<string, unknown>,
  runtime: AdminRuntime,
): Promise<ToolExecution> {
  switch (name) {
    case "get_daily_sales_summary": {
      const summary = await runtime.salesSummary();
      const revenueDelta = delta(summary.revenue_today, summary.revenue_yesterday);
      const ordersDelta = delta(summary.orders_today, summary.orders_yesterday);

      return ok(
        {
          ...summary,
          revenue_change_vs_yesterday_percent: revenueDelta,
          orders_change_vs_yesterday_percent: ordersDelta,
          note:
            summary.orders_today === 0
              ? "Nothing has been served today yet. Say that plainly rather than reporting zeros as a trend."
              : "Revenue counts SERVED tickets only (sales_day), so a fired-but-unserved ticket is not in today's number.",
        },
        [
          {
            kind: "info",
            label: `Today: ₹${Math.round(summary.revenue_today)} from ${summary.orders_today} orders`,
            ok: true,
          },
        ],
      );
    }

    case "get_best_selling_dishes": {
      const limit = clamped(asInteger(args.limit), 5, 1, 20);
      const days = clamped(asInteger(args.days), 1, 1, 90);
      const items = await runtime.bestSelling(limit, days);

      return ok(
        {
          window_days: days,
          count: items.length,
          items,
          note: items.length === 0 ? "Nothing has sold in that window." : "",
        },
        items.length > 0
          ? [{ kind: "info", label: `Top ${items.length} over ${days === 1 ? "today" : `${days} days`}`, ok: true }]
          : [],
      );
    }

    case "get_pending_orders": {
      const orders = await runtime.pendingOrders();
      const oldest = orders.reduce((max, order) => Math.max(max, order.age_minutes), 0);

      return ok(
        {
          count: orders.length,
          oldest_age_minutes: oldest,
          orders,
          note:
            orders.length === 0
              ? "The kitchen has no open tickets."
              : "Sort your answer by age: the oldest ticket is the one about to become a complaint.",
        },
        [{ kind: "info", label: `${orders.length} open ${orders.length === 1 ? "ticket" : "tickets"}`, ok: true }],
      );
    }

    case "get_table_occupancy": {
      const occupancy = await runtime.occupancy();
      const onlyFree = asBoolean(args.only_free);
      const onlyOccupied = asBoolean(args.only_occupied);
      const tables = onlyFree
        ? occupancy.tables.filter((table) => table.status !== "active")
        : onlyOccupied
          ? occupancy.tables.filter((table) => table.status === "active")
          : occupancy.tables;

      return ok(
        {
          total: occupancy.total,
          occupied: occupancy.occupied,
          free: occupancy.free,
          shown: tables.length,
          tables,
        },
        [{ kind: "info", label: `${occupancy.occupied} seated · ${occupancy.free} free`, ok: true }],
      );
    }

    case "get_inventory_status": {
      const inventory = await runtime.inventory();
      const lowOnly = asBoolean(args.low_only);
      const items = lowOnly
        ? inventory.items.filter((item) => item.state === "low" || item.state === "out")
        : inventory.items;

      return ok(
        {
          tracked: inventory.tracked,
          untracked: inventory.untracked,
          out: inventory.out,
          low: inventory.low,
          shown: items.length,
          items,
          note:
            "`untracked` means the kitchen keeps no count for that dish — say so instead of implying it is in stock. `is_available` is the 86 switch and is independent of the count.",
        },
        [
          {
            kind: "info",
            label: `${inventory.out} out · ${inventory.low} low · ${inventory.untracked} untracked`,
            ok: true,
          },
        ],
      );
    }

    case "get_low_stock_items": {
      const inventory = await runtime.inventory();
      const items = inventory.items.filter((item) => item.state === "low" || item.state === "out");

      return ok(
        {
          count: items.length,
          out: items.filter((item) => item.state === "out").length,
          low: items.filter((item) => item.state === "low").length,
          items,
          note:
            items.length === 0
              ? "Nothing is at or below its threshold right now."
              : "Suggest reordering the `out` dishes first: they are already unsellable.",
        },
        [
          {
            kind: "info",
            label: items.length === 0 ? "No low stock" : `${items.length} need restocking`,
            ok: items.length === 0,
          },
        ],
      );
    }

    case "get_guest_feedback": {
      const limit = clamped(asInteger(args.limit), 10, 1, 50);
      const feedback = await runtime.feedback(limit);
      const average =
        feedback.length === 0
          ? null
          : Math.round((feedback.reduce((sum, row) => sum + row.rating, 0) / feedback.length) * 10) / 10;

      return ok(
        {
          count: feedback.length,
          average_rating: average,
          feedback,
          note:
            feedback.length === 0
              ? "No guest has left feedback yet. Do not invent themes from silence."
              : "Quote at most one comment verbatim; summarise the rest by theme.",
        },
        feedback.length > 0
          ? [{ kind: "info", label: `Average ${average}/5 from ${feedback.length}`, ok: true }]
          : [],
      );
    }

    case "get_menu_catalog": {
      const items = await runtime.catalog();
      const query = asString(args.query)?.toLowerCase() ?? null;
      const category = asString(args.category)?.toLowerCase() ?? null;
      const availableOnly = asBoolean(args.available_only);

      const filtered = items.filter((item) => {
        if (availableOnly && !item.is_available) return false;
        if (category && !item.category.toLowerCase().includes(category)) return false;
        if (!query) return true;

        /* Structured metadata, so "which dishes have peanuts" is a real query
           rather than a guess from a description. */
        const haystack = [
          item.name,
          item.category,
          item.description,
          item.portion_description,
          ...item.ingredients,
          ...item.allergens,
          ...item.diet_tags,
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(query);
      });

      return ok(
        {
          total: items.length,
          count: filtered.length,
          items: filtered,
          note:
            filtered.length === 0
              ? "Nothing in the catalogue matches that. Say so instead of improvising a dish."
              : "Ingredients, allergens, spice and diet tags are the kitchen's own records. Never add an ingredient that is not listed; if a field is empty, say it is not recorded.",
        },
        [{ kind: "info", label: `${filtered.length} of ${items.length} dishes`, ok: true }],
      );
    }

    default:
      return fail("UNKNOWN_TOOL", `Unknown console tool "${name}".`);
  }
}

/** Activity line while a console tool runs. */
export function describeAdminToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "get_daily_sales_summary":
      return "Reading today's takings…";
    case "get_best_selling_dishes":
      return `Ranking the best sellers${asString(String(args.days ?? "")) ? ` over ${args.days} days` : ""}…`;
    case "get_pending_orders":
      return "Checking the kitchen queue…";
    case "get_table_occupancy":
      return "Checking the floor…";
    case "get_inventory_status":
    case "get_low_stock_items":
      return "Checking stock…";
    case "get_guest_feedback":
      return "Reading guest feedback…";
    case "get_menu_catalog":
      return "Checking the recipe book…";
    default:
      return "Working on it…";
  }
}
