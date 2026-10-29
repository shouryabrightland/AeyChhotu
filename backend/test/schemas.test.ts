import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for docs/7 §1.7 validation — the layer every request passes
   through, and the layer where a regression becomes a 500 or a security
   hole. Fast, dependency-free (node:test), no database. */

import {
  availabilitySchema,
  cartAddSchema,
  cartUpdateSchema,
  denyTicketSchema,
  fireSchema,
  initializeSchema,
  joinPinSchema,
  kdsLoginSchema,
  kdsTicketsQuerySchema,
  menuQuerySchema,
  orderStatusSchema,
  parseOrThrow,
} from "../src/validation/schemas.js";
import { AppError } from "../src/errors/app-error.js";

describe("kdsLoginSchema (E2)", () => {
  it("accepts a 4-6 digit PIN", () => {
    assert.equal(kdsLoginSchema.safeParse({ pin: "4604" }).success, true);
    assert.equal(kdsLoginSchema.safeParse({ pin: "460468" }).success, true);
  });

  it("rejects PINs that are too short, too long, or non-numeric", () => {
    assert.equal(kdsLoginSchema.safeParse({ pin: "123" }).success, false);
    assert.equal(kdsLoginSchema.safeParse({ pin: "1234567" }).success, false);
    assert.equal(kdsLoginSchema.safeParse({ pin: "12a4" }).success, false);
    assert.equal(kdsLoginSchema.safeParse({ pin: "" }).success, false);
  });

  it("rejects a missing pin", () => {
    assert.equal(kdsLoginSchema.safeParse({}).success, false);
  });
});

describe("pagination coercion (§1.5)", () => {
  it("coerces numeric strings and applies defaults", () => {
    const parsed = menuQuerySchema.parse({ table_token: "k7x2p", page: "3", limit: "50" });
    assert.equal(parsed.page, 3);
    assert.equal(parsed.limit, 50);
  });

  it("defaults to page 1 / limit 20", () => {
    const parsed = menuQuerySchema.parse({ table_token: "k7x2p" });
    assert.equal(parsed.page, 1);
    assert.equal(parsed.limit, 20);
  });

  it("rejects page 0, non-integer limits and limit > 100", () => {
    assert.equal(menuQuerySchema.safeParse({ table_token: "k7x2p", page: 0 }).success, false);
    assert.equal(menuQuerySchema.safeParse({ table_token: "k7x2p", limit: 2.5 }).success, false);
    assert.equal(menuQuerySchema.safeParse({ table_token: "k7x2p", limit: 101 }).success, false);
  });
});

describe("table_token rules (§1.7)", () => {
  it("accepts 4-16 lowercase alphanumerics", () => {
    assert.equal(fireSchema.safeParse({ table_token: "k7x2p" }).success, true);
    assert.equal(fireSchema.safeParse({ table_token: "abcd1234efgh5678" }).success, true);
  });

  it("rejects uppercase, wrong length and injection attempts", () => {
    assert.equal(fireSchema.safeParse({ table_token: "K7X2P" }).success, false);
    assert.equal(fireSchema.safeParse({ table_token: "abc" }).success, false);
    assert.equal(
      fireSchema.safeParse({ table_token: "k7x2p; DROP TABLE orders" }).success,
      false,
    );
    assert.equal(fireSchema.safeParse({ table_token: "k7x2p%20OR%201=1" }).success, false);
  });
});

describe("cartAddSchema (E5)", () => {
  const base = {
    table_token: "k7x2p",
    menu_item_id: "0f0e0d0c-0b0a-4987-8654-321098765432",
    added_by: "Amit",
  };

  it("accepts the happy path and defaults quantity to 1", () => {
    const parsed = cartAddSchema.parse(base);
    assert.equal(parsed.quantity, 1);
  });

  it("requires an author — there is no anonymous cart line", () => {
    assert.equal(
      cartAddSchema.safeParse({
        table_token: "k7x2p",
        menu_item_id: "0f0e0d0c-0b0a-4987-8654-321098765432",
      }).success,
      false,
    );
    assert.equal(cartAddSchema.safeParse({ ...base, added_by: "   " }).success, false);
    assert.equal(cartAddSchema.safeParse({ ...base, added_by: "x".repeat(41) }).success, false);

    const parsed = cartAddSchema.parse({ ...base, added_by: "  Ravi  " });
    assert.equal(parsed.added_by, "Ravi");
  });

  it("rejects quantity 0, 100, fractional and non-integer", () => {
    assert.equal(cartAddSchema.safeParse({ ...base, quantity: 0 }).success, false);
    assert.equal(cartAddSchema.safeParse({ ...base, quantity: 100 }).success, false);
    assert.equal(cartAddSchema.safeParse({ ...base, quantity: 1.5 }).success, false);
  });

  it("rejects a malformed uuid", () => {
    assert.equal(cartAddSchema.safeParse({ ...base, menu_item_id: "not-a-uuid" }).success, false);
  });

  it("caps notes at 500 chars", () => {
    assert.equal(cartAddSchema.safeParse({ ...base, allergy_note: "x".repeat(501) }).success, false);
    assert.equal(cartAddSchema.safeParse({ ...base, allergy_note: "x".repeat(500) }).success, true);
  });
});

describe("cartUpdateSchema (E6)", () => {
  const base = { table_token: "k7x2p", cart_item_id: undefined };

  it("accepts an absolute quantity", () => {
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", quantity: 3 }).success,
      true,
    );
  });

  it("accepts a non-zero delta and rejects delta 0", () => {
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", quantity_delta: 2 }).success,
      true,
    );
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", quantity_delta: -1 }).success,
      true,
    );
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", quantity_delta: 0 }).success,
      false,
    );
  });

  it("requires at least one mutable field", () => {
    assert.equal(cartUpdateSchema.safeParse({ table_token: "k7x2p" }).success, false);
  });

  it("accepts note-only updates", () => {
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", request_note: "extra butter" }).success,
      true,
    );
  });

  it("ignores the unused local base object (guards against silent edits)", () => {
    assert.equal(base.table_token, "k7x2p");
  });
});

describe("orderStatusSchema (E11)", () => {
  it("allows only preparing and ready — never served", () => {
    assert.equal(orderStatusSchema.safeParse({ status: "preparing" }).success, true);
    assert.equal(orderStatusSchema.safeParse({ status: "ready" }).success, true);
    assert.equal(orderStatusSchema.safeParse({ status: "served" }).success, false);
    assert.equal(orderStatusSchema.safeParse({ status: "pending" }).success, false);
  });
});

describe("kdsTicketsQuerySchema (E10)", () => {
  it("allows the three live statuses only", () => {
    assert.equal(kdsTicketsQuerySchema.safeParse({ status: "pending" }).success, true);
    assert.equal(kdsTicketsQuerySchema.safeParse({ status: "preparing" }).success, true);
    assert.equal(kdsTicketsQuerySchema.safeParse({ status: "ready" }).success, true);
    assert.equal(kdsTicketsQuerySchema.safeParse({ status: "served" }).success, false);
  });
});

describe("availabilitySchema (E14)", () => {
  it("requires a boolean — a string 'true' is not a bool", () => {
    assert.equal(availabilitySchema.safeParse({ is_available: true }).success, true);
    assert.equal(availabilitySchema.safeParse({ is_available: "true" }).success, false);
    assert.equal(availabilitySchema.safeParse({ is_available: 1 }).success, false);
  });
});

describe("denyTicketSchema (kitchen refusal)", () => {
  it("requires a reason and trims it", () => {
    assert.equal(denyTicketSchema.safeParse({ reason: "Paneer ran out" }).success, true);
    assert.equal(denyTicketSchema.safeParse({}).success, false);
    assert.equal(denyTicketSchema.safeParse({ reason: "   " }).success, false);

    const parsed = denyTicketSchema.parse({ reason: "  Out of stock  " });
    assert.equal(parsed.reason, "Out of stock");
  });

  it("caps the reason at 300 characters", () => {
    assert.equal(denyTicketSchema.safeParse({ reason: "x".repeat(300) }).success, true);
    assert.equal(denyTicketSchema.safeParse({ reason: "x".repeat(301) }).success, false);
  });
});

describe("session entry (stale refresh + roster)", () => {
  it("accepts an ISO scan_time and a device identity", () => {
    const parsed = initializeSchema.parse({
      table_token: "k7x2p",
      scan_time: "2026-10-28T10:15:00.000Z",
      user_id: "dev_1a2b3c4d",
      name: "Amit",
    });
    assert.equal(parsed.scan_time, "2026-10-28T10:15:00.000Z");
    assert.equal(parsed.user_id, "dev_1a2b3c4d");
  });

  it("requires a name on every entry point, scan_time and user_id optional", () => {
    assert.equal(initializeSchema.safeParse({ table_token: "k7x2p" }).success, false);
    assert.equal(
      joinPinSchema.safeParse({ table_token: "k7x2p", pin: "07" }).success,
      false,
    );

    const minimal = initializeSchema.parse({ table_token: "k7x2p", name: "Ravi" });
    assert.equal(minimal.name, "Ravi");
    assert.equal(minimal.user_id, undefined);
    assert.equal(
      joinPinSchema.safeParse({ table_token: "k7x2p", pin: "07", name: "Ravi" }).success,
      true,
    );
  });

  it("rejects an unparseable scan_time and an oversized user_id", () => {
    assert.equal(
      initializeSchema.safeParse({ table_token: "k7x2p", scan_time: "not-a-date" }).success,
      false,
    );
    assert.equal(
      initializeSchema.safeParse({ table_token: "k7x2p", user_id: "x".repeat(65) }).success,
      false,
    );
  });
});

describe("parseOrThrow contract", () => {
  it("throws the 400 VALIDATION_ERROR envelope with per-field messages", () => {
    try {
      parseOrThrow(fireSchema, { table_token: "BAD!" });
      assert.fail("expected parseOrThrow to throw");
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "VALIDATION_ERROR");
      const fields = (err.details as { fields?: Record<string, string> } | undefined)?.fields;
      assert.ok(fields && Object.keys(fields).includes("table_token"));
    }
  });

  it("returns the parsed value on success", () => {
    const parsed = parseOrThrow(fireSchema, { table_token: "k7x2p" });
    assert.deepEqual(parsed, { table_token: "k7x2p" });
  });
});
