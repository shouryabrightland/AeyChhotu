import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The console's tools are READ-ONLY by design: they answer questions and never
   mutate. These tests pin the two things a model can get wrong — the window
   it asked for, and reading "untracked" stock as zero. */

import { executeAdminTool } from "../lib/ai/admin-tools.ts";

const SUMMARY = {
  day: "2026-10-30",
  revenue_today: 12400,
  orders_today: 14,
  items_sold_today: 41,
  average_ticket_today: 885.71,
  revenue_yesterday: 10000,
  orders_yesterday: 10,
  revenue_7d: 80000,
  orders_7d: 96,
};

const INVENTORY = {
  tracked: 2,
  out: 1,
  low: 1,
  untracked: 1,
  items: [
    { menu_item_id: "m1", name: "Paneer Butter Masala", category: "Main", price: 320, is_available: false, stock_quantity: 0, low_stock_threshold: 5, state: "out" },
    { menu_item_id: "m2", name: "Tandoori Roti", category: "Breads", price: 60, is_available: true, stock_quantity: 4, low_stock_threshold: 5, state: "low" },
    { menu_item_id: "m3", name: "Mystery Curry", category: "Main", price: 210, is_available: true, stock_quantity: null, low_stock_threshold: 5, state: "untracked" },
  ],
};

function makeRuntime(overrides = {}) {
  const calls = [];
  const runtime = {
    salesSummary: async () => SUMMARY,
    bestSelling: async (limit, days) => {
      calls.push({ limit, days });
      return [{ menu_item_id: "m1", name: "Masala Dosa", category: "Main", units: 12, revenue: 2160 }];
    },
    pendingOrders: async () => [
      { order_id: "o1", table_name: "Table 1", table_code: "abcde", status: "pending", total: 360, created_at: "2026-10-30T10:00:00+05:30", age_minutes: 22 },
      { order_id: "o2", table_name: "Table 4", table_code: "fghij", status: "preparing", total: 540, created_at: "2026-10-30T10:20:00+05:30", age_minutes: 6 },
    ],
    occupancy: async () => ({
      total: 5,
      occupied: 2,
      free: 3,
      tables: [
        { table_id: "t1", name: "Table 1", code: "abcde", status: "active", bill_status: "unrequested", devices: 2, guests: 3, open_orders: 1 },
        { table_id: "t2", name: "Table 2", code: "fghij", status: "empty", bill_status: "unrequested", devices: 0, guests: 0, open_orders: 0 },
      ],
    }),
    inventory: async () => INVENTORY,
    feedback: async () => [
      { feedback_id: "f1", rating: 5, comment: "Dosa was superb", created_at: "2026-10-30T11:00:00+05:30", table_name: "Table 1", table_code: "abcde" },
      { feedback_id: "f2", rating: 3, comment: "Slow service", created_at: "2026-10-30T11:10:00+05:30", table_name: "Table 2", table_code: "fghij" },
    ],
    ...overrides,
  };
  return { runtime, calls };
}

describe("console insight tools", () => {
  it("reports today with the change against yesterday", async () => {
    const { runtime } = makeRuntime();
    const result = await executeAdminTool("get_daily_sales_summary", {}, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.revenue_today, 12400);
    assert.equal(result.response.data.revenue_change_vs_yesterday_percent, 24);
    assert.equal(result.mutated, false, "reading numbers never mutates");
  });

  it("passes the requested window through, clamped", async () => {
    const { runtime, calls } = makeRuntime();
    await executeAdminTool("get_best_selling_dishes", { days: "7", limit: 3 }, runtime);
    assert.deepEqual(calls, [{ limit: 3, days: 7 }]);

    const { runtime: runtime2, calls: calls2 } = makeRuntime();
    await executeAdminTool("get_best_selling_dishes", { days: 999, limit: 999 }, runtime2);
    assert.deepEqual(calls2, [{ limit: 20, days: 90 }], "a model-supplied window cannot scan everything");
  });

  it("surfaces the oldest open ticket", async () => {
    const { runtime } = makeRuntime();
    const result = await executeAdminTool("get_pending_orders", {}, runtime);

    assert.equal(result.response.data.count, 2);
    assert.equal(result.response.data.oldest_age_minutes, 22);
  });

  it("can answer 'which tables are free'", async () => {
    const { runtime } = makeRuntime();
    const result = await executeAdminTool("get_table_occupancy", { only_free: true }, runtime);

    assert.equal(result.response.data.occupied, 2);
    assert.equal(result.response.data.tables.length, 1);
    assert.equal(result.response.data.tables[0].status, "empty");
  });

  it("never reports untracked stock as zero", async () => {
    const { runtime } = makeRuntime();
    const result = await executeAdminTool("get_low_stock_items", {}, runtime);

    const names = result.response.data.items.map((item) => item.name);
    assert.deepEqual(names, ["Paneer Butter Masala", "Tandoori Roti"]);
    assert.equal(result.response.data.items.some((item) => item.state === "untracked"), false);
    assert.ok(result.response.data.out >= 1);
  });

  it("filters inventory to only what needs restocking", async () => {
    const { runtime } = makeRuntime();
    const result = await executeAdminTool("get_inventory_status", { low_only: true }, runtime);

    assert.equal(result.response.data.tracked, 2);
    assert.equal(result.response.data.untracked, 1);
    assert.equal(result.response.data.items.length, 2);
  });

  it("averages guest feedback and refuses to invent it", async () => {
    const { runtime } = makeRuntime();
    const withFeedback = await executeAdminTool("get_guest_feedback", { limit: 5 }, runtime);
    assert.equal(withFeedback.response.data.average_rating, 4);

    const { runtime: empty } = makeRuntime({ feedback: async () => [] });
    const none = await executeAdminTool("get_guest_feedback", {}, empty);
    assert.equal(none.response.data.average_rating, null);
    assert.match(none.response.data.note, /Do not invent/i);
  });

  it("rejects an unknown tool instead of pretending", async () => {
    const { runtime } = makeRuntime();
    const result = await executeAdminTool("drop_all_tables", {}, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "UNKNOWN_TOOL");
    assert.equal(result.mutated, false);
  });
});
