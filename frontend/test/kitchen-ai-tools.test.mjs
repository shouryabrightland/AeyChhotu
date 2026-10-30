import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The kitchen assistant's executors run in the BROWSER, so their tests live
   here: same code the voice dock uses, against a fake `KitchenRuntime` that
   records the board writes. No Gemini key, no network, no database.

   The behaviours pinned below are the ones a language model gets wrong on a
   busy line: resolving "table four" to the right ticket, refusing an illegal
   lane move, and — most importantly — NOT performing a destructive action
   until `confirm_action` is called after the chef said yes. */

import { createKitchenToolset } from "../lib/ai/kitchen-tools.ts";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");

function item(overrides = {}) {
  return {
    id: "line-1",
    menu_item_id: "dish-dosa",
    name: "Masala Dosa",
    quantity: 2,
    request_note: "",
    allergy_note: "",
    added_by: "Ravi",
    unit_price: 180,
    ...overrides,
  };
}

function ticket(overrides = {}) {
  return {
    id: "order-1",
    table_id: "table-1",
    table_code: "T04",
    status: "pending",
    created_at: "2026-10-30T09:52:00.000Z",
    updated_at: "2026-10-30T09:52:00.000Z",
    items: [item()],
    ...overrides,
  };
}

function dish(overrides = {}) {
  return {
    id: "dish-dosa",
    name: "Masala Dosa",
    price: 180,
    category: "Main Course",
    is_available: true,
    description: "",
    vegetarian: true,
    ingredients: [],
    spice_level: 1,
    allergens: [],
    diet_tags: [],
    portion_description: "",
    ...overrides,
  };
}

function makeRuntime({ tickets = [], menu = [] } = {}) {
  const calls = [];

  const runtime = {
    tickets,
    menu,
    now: () => NOW,
    refresh: async () => {
      calls.push(["refresh"]);
    },
    moveTicket: async (order, next) => {
      calls.push(["move", order.table_code, next]);
      return { ok: true };
    },
    serveTicket: async (order) => {
      calls.push(["serve", order.table_code]);
      return { ok: true };
    },
    denyTicket: async (order, reason) => {
      calls.push(["deny", order.table_code, reason]);
      return { ok: true };
    },
    setAvailability: async (menuItemId, available) => {
      calls.push(["availability", menuItemId, available]);
      return { ok: true };
    },
    startShift: async () => {
      calls.push(["shift"]);
      return { ok: true };
    },
  };

  return { calls, toolset: createKitchenToolset(runtime) };
}

describe("kitchen board overview", () => {
  it("counts each lane and reports the oldest ticket", async () => {
    const { toolset } = makeRuntime({
      tickets: [
        ticket({ id: "a", table_code: "T01", status: "pending", created_at: "2026-10-30T09:55:00.000Z" }),
        ticket({ id: "b", table_code: "T02", status: "preparing", created_at: "2026-10-30T09:40:00.000Z" }),
        ticket({ id: "c", table_code: "T05", status: "ready" }),
      ],
    });

    const result = await toolset.execute("get_board_overview", {});
    assert.equal(result.response.ok, true);

    const data = result.response.data;
    assert.deepEqual(data.counts, { pending: 1, preparing: 1, ready: 1 });
    assert.equal(data.total, 3);
    assert.deepEqual(data.pending_tables, ["T01"]);
    assert.deepEqual(data.ready_tables, ["T05"]);
    assert.equal(data.oldest.table, "T02");
    assert.equal(data.oldest.age_minutes, 20);
  });

  it("says the board is empty instead of inventing a ticket", async () => {
    const { toolset } = makeRuntime();
    const result = await toolset.execute("get_board_overview", {});
    assert.equal(result.response.data.total, 0);
    assert.match(result.response.data.note, /empty/i);
  });
});

describe("reading tickets", () => {
  it("carries allergy notes to the chef", async () => {
    const { toolset } = makeRuntime({
      tickets: [ticket({ items: [item({ allergy_note: "peanut" }), item({ id: "line-2", name: "Filter Coffee" })] })],
    });

    const result = await toolset.execute("list_tickets", { status: "pending" });
    assert.equal(result.response.data.count, 1);
    assert.deepEqual(result.response.data.tickets[0].allergy_notes, ["peanut"]);
    assert.match(result.response.data.note, /allergy/i);
  });
});

describe("moving tickets", () => {
  it("resolves a spoken table number and moves one lane", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "pending" })] });

    const result = await toolset.execute("move_ticket", { table: "table 4", status: "preparing" });
    assert.equal(result.response.ok, true);
    assert.deepEqual(calls, [["move", "T04", "preparing"]]);
  });

  it("refuses to skip the preparing lane", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "pending" })] });

    const result = await toolset.execute("move_ticket", { table: "T04", status: "ready" });
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "INVALID_TRANSITION");
    assert.deepEqual(calls, []);
  });

  it("is idempotent when the ticket is already in that lane", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "preparing" })] });

    const result = await toolset.execute("move_ticket", { table: "T04", status: "preparing" });
    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.unchanged, true);
    assert.deepEqual(calls, []);
  });

  it("lists the open tables when the number matches nothing", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ table_code: "T09" })] });

    const result = await toolset.execute("move_ticket", { table: "12", status: "preparing" });
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "TICKET_NOT_FOUND");
    assert.deepEqual(result.response.error.open_tables, ["T09"]);
    assert.deepEqual(calls, []);
  });
});

describe("serving", () => {
  it("serves a Ready ticket", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "ready" })] });

    const result = await toolset.execute("serve_ticket", { table: "T04" });
    assert.equal(result.response.ok, true);
    assert.deepEqual(calls, [["serve", "T04"]]);
  });

  it("will not serve food that is still pending", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "pending" })] });

    const result = await toolset.execute("serve_ticket", { table: "T04" });
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "INVALID_TRANSITION");
    assert.deepEqual(calls, []);
  });
});

describe("denial requires a spoken yes", () => {
  it("parks the refusal instead of denying", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "preparing" })] });

    const result = await toolset.execute("deny_ticket", { table: "T04", reason: "paneer over" });
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "CONFIRMATION_REQUIRED");
    assert.deepEqual(calls, []);
    assert.equal(toolset.pendingDescription(), "Deny table T04 (paneer over)");
  });

  it("runs only after confirm_action says yes", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "ready" })] });

    await toolset.execute("deny_ticket", { table: "T04", reason: "paneer over" });
    const confirmed = await toolset.execute("confirm_action", { confirm: true });

    assert.equal(confirmed.response.ok, true);
    assert.deepEqual(calls, [["deny", "T04", "paneer over"]]);
    assert.equal(toolset.pendingDescription(), null);
  });

  it("cancels on a no and clears the parked action", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "pending" })] });

    await toolset.execute("deny_ticket", { table: "T04", reason: "ran out" });
    const cancelled = await toolset.execute("confirm_action", { confirm: false });

    assert.equal(cancelled.response.ok, true);
    assert.deepEqual(calls, []);
    assert.equal(toolset.pendingDescription(), null);

    const second = await toolset.execute("confirm_action", { confirm: true });
    assert.equal(second.response.error.code, "NOTHING_TO_CONFIRM");
  });

  it("needs a reason before it can even ask", async () => {
    const { toolset } = makeRuntime({ tickets: [ticket()] });
    const result = await toolset.execute("deny_ticket", { table: "T04" });
    assert.equal(result.response.error.code, "MISSING_REASON");
  });

  it("carries the guest-facing sentence to the API unchanged", async () => {
    const { calls, toolset } = makeRuntime({ tickets: [ticket({ status: "preparing" })] });
    const reason =
      "Maaf kijiye, ye order abhi nahi ban payega kyunki paneer khatam ho gaya hai. Aap kuch aur order karna chahenge?";

    const parked = await toolset.execute("deny_ticket", { table: "T04", reason });
    assert.equal(parked.response.error.code, "CONFIRMATION_REQUIRED");
    assert.match(parked.response.error.action, /Maaf kijiye/);

    const confirmed = await toolset.execute("confirm_action", { confirm: true });
    assert.equal(confirmed.response.ok, true);
    assert.deepEqual(calls, [["deny", "T04", reason]]);
  });
});

describe("86", () => {
  it("asks before marking a dish unavailable", async () => {
    const { calls, toolset } = makeRuntime({ menu: [dish()] });

    const result = await toolset.execute("set_dish_availability", { dish: "masala dosa", available: false });
    assert.equal(result.response.error.code, "CONFIRMATION_REQUIRED");
    assert.deepEqual(calls, []);

    await toolset.execute("confirm_action", { confirm: true });
    assert.deepEqual(calls, [["availability", "dish-dosa", false]]);
  });

  it("puts a dish back on the menu immediately", async () => {
    const { calls, toolset } = makeRuntime({ menu: [dish({ is_available: false })] });

    const result = await toolset.execute("set_dish_availability", { dish: "masala dosa", available: true });
    assert.equal(result.response.ok, true);
    assert.deepEqual(calls, [["availability", "dish-dosa", true]]);
  });

  it("refuses to guess between two dishes that both match", async () => {
    const { calls, toolset } = makeRuntime({
      menu: [
        dish({ id: "d1", name: "Paneer Tikka" }),
        dish({ id: "d2", name: "Paneer Butter Masala" }),
      ],
    });

    const result = await toolset.execute("set_dish_availability", { dish: "paneer", available: false });
    assert.equal(result.response.error.code, "AMBIGUOUS_DISH");
    assert.deepEqual(result.response.error.candidates, ["Paneer Tikka", "Paneer Butter Masala"]);
    assert.deepEqual(calls, []);
    assert.equal(toolset.pendingDescription(), null);
  });
});

describe("shift", () => {
  it("arms the shift through the board", async () => {
    const { calls, toolset } = makeRuntime();
    const result = await toolset.execute("start_shift", {});
    assert.equal(result.response.ok, true);
    assert.deepEqual(calls, [["shift"]]);
  });
});

describe("reading one table", () => {
  it("filters the list to the table the cook said", async () => {
    const { toolset } = makeRuntime({
      tickets: [
        ticket({ id: "a", table_code: "T04" }),
        ticket({ id: "b", table_code: "T09", status: "preparing" }),
      ],
    });

    const result = await toolset.execute("list_tickets", { table: "table 4" });
    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.count, 1);
    assert.equal(result.response.data.tickets[0].table, "T04");
    assert.equal(result.response.data.tickets[0].line_count, 1);
    assert.equal(result.response.data.tickets[0].total_quantity, 2);
  });

  it("says which tables are open when the table has no ticket", async () => {
    const { toolset } = makeRuntime({ tickets: [ticket({ table_code: "T09" })] });

    const result = await toolset.execute("list_tickets", { table: "12" });
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "TICKET_NOT_FOUND");
    assert.deepEqual(result.response.error.open_tables, ["T09"]);
  });
});

describe("menu status", () => {
  it("answers whether a named dish is available", async () => {
    const { toolset } = makeRuntime({
      menu: [dish(), dish({ id: "d2", name: "Paneer Tikka", is_available: false })],
    });

    const result = await toolset.execute("get_menu_status", { dish: "masala dosa" });
    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.count, 1);
    assert.equal(result.response.data.dishes[0].available, true);
    assert.deepEqual(result.response.data.off_menu, ["Paneer Tikka"]);
  });

  it("lists only the 86 dishes when asked what is off", async () => {
    const { toolset } = makeRuntime({
      menu: [dish(), dish({ id: "d2", name: "Paneer Tikka", is_available: false })],
    });

    const result = await toolset.execute("get_menu_status", { only_unavailable: true });
    assert.equal(result.response.data.count, 1);
    assert.deepEqual(
      result.response.data.dishes.map((item) => item.name),
      ["Paneer Tikka"],
    );
  });

  it("says nothing is 86 on a full menu", async () => {
    const { toolset } = makeRuntime({ menu: [dish()] });
    const result = await toolset.execute("get_menu_status", { only_unavailable: true });
    assert.equal(result.response.data.count, 0);
    assert.match(result.response.data.note, /86/i);
  });

  it("refuses to invent a dish", async () => {
    const { toolset } = makeRuntime({ menu: [dish()] });
    const result = await toolset.execute("get_menu_status", { dish: "sushi" });
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "DISH_NOT_FOUND");
  });
});

describe("waiter pings", () => {
  it("reports who is waiting and for how long", async () => {
    const { toolset } = makeRuntime({
      tickets: [
        ticket({ status: "ready", serve_requested_at: "2026-10-30T09:57:00.000Z" }),
        ticket({ id: "b", table_code: "T07", status: "ready" }),
      ],
    });

    const result = await toolset.execute("get_waiter_requests", {});
    assert.equal(result.response.data.count, 1);
    assert.equal(result.response.data.requests[0].table, "T04");
    assert.equal(result.response.data.requests[0].waiter_requested_minutes, 3);
  });

  it("says nobody has pinged instead of inventing one", async () => {
    const { toolset } = makeRuntime({ tickets: [ticket({ status: "ready" })] });
    const result = await toolset.execute("get_waiter_requests", {});
    assert.equal(result.response.data.count, 0);
    assert.match(result.response.data.note, /no waiter/i);
  });
});

describe("refreshing", () => {
  it("re-reads the board through the runtime", async () => {
    const { calls, toolset } = makeRuntime();
    const result = await toolset.execute("refresh_board", {});
    assert.equal(result.response.ok, true);
    assert.deepEqual(calls, [["refresh"]]);
  });
});
