import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the normalizers (lib/api-client/normalize.ts) — the seam
   between the wire contract and every screen. Run with node:test; TSX is
   compiled on the fly via the project's own loader so no build step or
   extra dependency is needed. */

import { ApiError } from "../lib/api-client/errors.ts";
import {
  isOfflineError,
  toCartLine,
  toFloorSummary,
  toKdsOrder,
  toMenuItem,
  toOrder,
} from "../lib/api-client/normalize.ts";

describe("toMenuItem", () => {
  it("maps the wire payload onto the UI shape", () => {
    const ui = toMenuItem({
      menu_item_id: "m1",
      name: "Masala Dosa",
      price: 130,
      category: "Mains",
      is_available: true,
      description: "Crisp",
      vegetarian: true,
    });
    assert.equal(ui.id, "m1");
    assert.equal(ui.price, 130);
    assert.equal(ui.name, "Masala Dosa");
  });
});

describe("toCartLine", () => {
  it("keeps identity and notes but drops server-only fields", () => {
    const ui = toCartLine({
      id: "c1",
      table_id: "t1",
      menu_item_id: "m1",
      quantity: 2,
      request_note: "extra butter",
      allergy_note: "NO PEANUTS",
      added_by: "Amit",
    });
    assert.deepEqual(ui, {
      id: "c1",
      table_id: "t1",
      menu_item_id: "m1",
      quantity: 2,
      request_note: "extra butter",
      allergy_note: "NO PEANUTS",
      added_by: "Amit",
    });
  });
});

describe("toOrder / toKdsOrder price snapshot", () => {
  const row = {
    order_id: "o1",
    table_id: "t1",
    status: "preparing",
    created_at: "2026-09-28T10:00:00Z",
    total: 260,
    items: [
      {
        menu_item_id: "m1",
        name: "Masala Dosa",
        quantity: 2,
        request_note: "",
        allergy_note: "",
        unit_price: 130,
      },
    ],
  };

  it("carries the fire-time unit_price into the UI (no hardcoded 0)", () => {
    const order = toOrder(row, "k7x2p");
    assert.equal(order.items[0].price, 130);
  });

  it("falls back to 0 only for payloads older than the column", () => {
    const legacy = toOrder({ ...row, items: [{ ...row.items[0], unit_price: undefined }] }, "k7x2p");
    assert.equal(legacy.items[0].price, 0);
  });

  it("maps a KDS ticket identically", () => {
    const ticket = {
      order_id: "o1",
      table: { id: "t1", code: "k7x2p", name: "Window four-top" },
      status: "ready",
      created_at: row.created_at,
      items: row.items,
    };
    const ui = toKdsOrder(ticket);
    assert.equal(ui.table_code, "k7x2p");
    assert.equal(ui.items[0].price, 130);
  });
});

describe("ticket attribution and denial (sql/011)", () => {
  const row = {
    order_id: "o9",
    table_id: "t1",
    status: "denied",
    created_at: "2026-10-28T10:00:00Z",
    denial_reason: "Item Paneer Tikka went out of stock",
    items: [
      {
        menu_item_id: "m1",
        name: "Paneer Tikka",
        quantity: 1,
        request_note: "",
        allergy_note: "",
        added_by: "Amit",
        unit_price: 210,
      },
    ],
  };

  it("carries added_by onto the ticket so the bill can be split per person", () => {
    const order = toOrder(row, "k7x2p");
    assert.equal(order.items[0].added_by, "Amit");
  });

  it("reads a legacy ticket with no added_by as Guest rather than blank", () => {
    const legacy = toOrder(
      { ...row, items: [{ ...row.items[0], added_by: undefined }] },
      "k7x2p",
    );
    assert.equal(legacy.items[0].added_by, "Guest");
  });

  it("carries the denial reason the tracker renders", () => {
    const order = toOrder(row, "k7x2p");
    assert.equal(order.status, "denied");
    assert.equal(order.denial_reason, "Item Paneer Tikka went out of stock");
  });
});

describe("toFloorSummary", () => {
  it("maps a live table row with an active order", () => {
    const ui = toFloorSummary({
      table_id: "t1",
      code: "k7x2p",
      name: "Window four-top",
      status: "active",
      active_order: {
        order_id: "o1",
        status: "pending",
        created_at: "2026-09-28T10:00:00Z",
        items: [
          { menu_item_id: "m1", name: "Masala Dosa", quantity: 2, request_note: "", allergy_note: "NO PEANUTS", unit_price: 130 },
        ],
      },
      cart_line_count: 3,
    });
    assert.equal(ui.active_order.items[0].price, 130);
    assert.equal(ui.active_order.items[0].allergy_note, "NO PEANUTS");
    assert.equal(ui.cart_line_count, 3);
  });

  it("maps an empty table to a null active_order", () => {
    const ui = toFloorSummary({
      table_id: "t2",
      code: "m3q8z",
      name: "Corner booth",
      status: "empty",
      active_order: null,
      cart_line_count: 0,
    });
    assert.equal(ui.active_order, null);
  });
});

describe("offline classification", () => {
  it("flags only status-0 ApiErrors as offline", () => {
    assert.equal(isOfflineError(new ApiError(0, "NETWORK_ERROR", "down")), true);
    assert.equal(isOfflineError(new ApiError(500, "INTERNAL", "boom")), false);
    assert.equal(isOfflineError(new Error("plain")), false);
  });

  it("no longer exposes a demo-fallback gate", async () => {
    const normalize = await import("../lib/api-client/normalize.ts");
    assert.equal("shouldUseDemoFallback" in normalize, false);
    assert.equal("demoFallbackEnabled" in normalize, false);
    assert.equal("apiErrorFromServiceFailure" in normalize, false);
  });
});
