import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The bill handoff is what moves a table from "eating" to "empty" — the one
   flow where a tap on the floor board decides whether a diner's session
   still exists. Both halves are pinned: the request signal every surface
   renders from, and the erasure it triggers when a server takes payment. */

import {
  acknowledgeSettlement,
  getBill,
  requestBill,
  settleBill,
  subscribeBills,
} from "../lib/api/bill.ts";
import { settleTable } from "../lib/api/index.ts";
import { getSnapshot, mutate } from "../lib/api/store.ts";

const NEW_TABLE = "bill-fresh";
const EATING_TABLE = "bill-eating";
const OTHER_TABLE = "bill-other";

describe("the bill request signal", () => {
  it("records a request as unsettled", () => {
    requestBill(NEW_TABLE);

    const event = getBill(NEW_TABLE);
    assert.ok(event, "the request should be visible to every surface");
    assert.equal(event.table_code, NEW_TABLE);
    assert.equal(event.settled_at, null);
    assert.ok(Date.parse(event.requested_at) > 0);
  });

  it("is idempotent — a second tap on the same table is one request", () => {
    requestBill(NEW_TABLE);
    const first = getBill(NEW_TABLE).requested_at;

    requestBill(NEW_TABLE);

    assert.equal(getBill(NEW_TABLE).requested_at, first);
  });

  it("notifies subscribers on change and stops after they unsubscribe", () => {
    let calls = 0;
    const stop = subscribeBills(() => {
      calls += 1;
    });

    requestBill("bill-subscriber");
    assert.equal(calls, 1);

    stop();
    requestBill("bill-subscriber-2");
    assert.equal(calls, 1, "an unsubscribed listener must not be called");
  });
});

describe("settlement", () => {
  /* A staff member can take payment without the diner ever tapping "request
     the bill" (the floor board settles the table directly, and the broadcast
     arrives over Realtime). The diner's screen must still show the thank-you,
     so settlement is recorded even with no prior request — the request time is
     back-filled from the settlement. This is the cross-device half of the
     handoff; the old "ignore it" rule left that guest on a dead menu. */
  it("records a settle even for a table that never asked", () => {
    settleBill("bill-never-asked");

    const event = getBill("bill-never-asked");
    assert.ok(event, "a settle must be visible without a prior request");
    assert.ok(event.settled_at, "the diner must see that the bill was settled");
    assert.equal(
      event.requested_at,
      event.settled_at,
      "the missing request is back-filled with the settlement time",
    );
  });

  it("keeps the original request when a server takes payment", () => {
    requestBill(EATING_TABLE);
    const requestedAt = getBill(EATING_TABLE).requested_at;

    settleBill(EATING_TABLE);

    const event = getBill(EATING_TABLE);
    assert.ok(event.settled_at, "the diner must be able to see it was settled");
    assert.equal(event.requested_at, requestedAt);
  });

  it("drops the event only when the diner has acknowledged the thanks", () => {
    requestBill(EATING_TABLE);
    settleBill(EATING_TABLE);
    requestBill(OTHER_TABLE);

    acknowledgeSettlement(EATING_TABLE);

    assert.equal(getBill(EATING_TABLE), null, "the settled table must go clean");
    assert.ok(getBill(OTHER_TABLE), "an unrelated table must be untouched");
  });
});

describe("settleTable", () => {
  it("erases one table's cart and orders without touching its neighbour", () => {
    const [eating, other] = getSnapshot().tables;
    const menuItemId = getSnapshot().menu[0].id;
    const stamp = new Date().toISOString();

    mutate((draft) => {
      draft.cart.push(
        {
          id: "cart-a",
          table_id: eating.id,
          menu_item_id: menuItemId,
          quantity: 2,
          request_note: "",
          allergy_note: "",
          added_by: "Guest",
        },
        {
          id: "cart-b",
          table_id: other.id,
          menu_item_id: menuItemId,
          quantity: 1,
          request_note: "",
          allergy_note: "",
          added_by: "Guest",
        },
      );
      draft.orders.push(
        {
          id: "order-a",
          table_id: eating.id,
          table_code: eating.code,
          status: "served",
          created_at: stamp,
          updated_at: stamp,
          items: [],
        },
        {
          id: "order-b",
          table_id: other.id,
          table_code: other.code,
          status: "served",
          created_at: stamp,
          updated_at: stamp,
          items: [],
        },
      );
    });

    const result = settleTable(eating.code);
    assert.equal(result.ok, true);

    const state = getSnapshot();
    assert.equal(
      state.cart.filter((line) => line.table_id === eating.id).length,
      0,
      "the settled table's cart must be gone",
    );
    assert.equal(
      state.orders.filter((order) => order.table_id === eating.id).length,
      0,
      "the settled table's history must be gone",
    );
    assert.equal(
      state.cart.filter((line) => line.table_id === other.id).length,
      1,
      "the neighbour's staged cart must survive",
    );
    assert.equal(
      state.orders.filter((order) => order.table_id === other.id).length,
      1,
      "the neighbour's orders must survive",
    );
  });

  it("refuses an unknown table rather than clearing everything", () => {
    const before = getSnapshot().cart.length;
    const result = settleTable("not-a-real-table");

    assert.equal(result.ok, false);
    assert.equal(getSnapshot().cart.length, before);
  });
});
