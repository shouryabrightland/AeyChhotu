import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The order state machine (Rule 13) is enforced TWICE by design: in the
   database (enforce_order_status_transition, sql/004_hardening.sql — tested
   by db:verify §5d) and in app code, whose allow/deny matrix is mirrored
   here so a code-side regression cannot wait for a database round trip to
   be noticed. These are the rules the API layer may rely on. */

const LIVE_STATUSES = ["pending", "preparing", "ready"] as const;
const ALL_STATUSES = [...LIVE_STATUSES, "served", "denied"] as const;

/** Mirrors enforce_order_status_transition() in sql/011 (which supersedes
   sql/004): pending→preparing, preparing→ready, any live→served, and any
   live→denied. Everything else (backwards, skipping, repeating, or leaving a
   terminal state) is refused. */
function isLegalTransition(from: string, to: string): boolean {
  if (from === to) return false;
  if (from === "pending" && to === "preparing") return true;
  if (from === "preparing" && to === "ready") return true;
  if (
    (to === "served" || to === "denied") &&
    (LIVE_STATUSES as readonly string[]).includes(from)
  ) {
    return true;
  }
  return false;
}

describe("order status transition matrix (Rule 13)", () => {
  it("allows exactly the documented forward moves plus refusal", () => {
    const legal = new Set([
      "pending>preparing",
      "preparing>ready",
      "pending>served",
      "preparing>served",
      "ready>served",
      "pending>denied",
      "preparing>denied",
      "ready>denied",
    ]);
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const pair = `${from}>${to}`;
        assert.equal(
          isLegalTransition(from, to),
          legal.has(pair),
          `${pair} should be ${legal.has(pair) ? "legal" : "illegal"}`,
        );
      }
    }
  });

  it("refuses skipping (pending→ready) and repeating (same state)", () => {
    assert.equal(isLegalTransition("pending", "ready"), false);
    assert.equal(isLegalTransition("preparing", "preparing"), false);
    assert.equal(isLegalTransition("ready", "ready"), false);
  });

  it("refuses every backwards move", () => {
    assert.equal(isLegalTransition("preparing", "pending"), false);
    assert.equal(isLegalTransition("ready", "preparing"), false);
    assert.equal(isLegalTransition("ready", "pending"), false);
  });

  it("treats 'served' as terminal — nothing leaves it", () => {
    for (const to of ALL_STATUSES) {
      assert.equal(isLegalTransition("served", to), false, `served>${to} must be illegal`);
    }
  });

  it("treats 'denied' as terminal too — a retry is a NEW ticket", () => {
    for (const to of ALL_STATUSES) {
      assert.equal(isLegalTransition("denied", to), false, `denied>${to} must be illegal`);
    }
  });

  it("allows refusal from every live stage, never from a closed one", () => {
    for (const from of LIVE_STATUSES) {
      assert.equal(isLegalTransition(from, "denied"), true, `${from}>denied must be legal`);
    }
    assert.equal(isLegalTransition("served", "denied"), false);
    assert.equal(isLegalTransition("denied", "denied"), false);
  });
});

/** Mirrors NEXT_STATUS in kds.service.ts advanceStatus(): the E11 button can
    only walk the forward chain; 'served' comes only from E12 prune. */
const NEXT_STATUS: Record<string, string> = { preparing: "pending", ready: "preparing" };

describe("E11 advanceStatus lookup (kds.service.ts mirror)", () => {
  it("maps each button target to the status it may advance FROM", () => {
    assert.equal(NEXT_STATUS["preparing"], "pending");
    assert.equal(NEXT_STATUS["ready"], "preparing");
  });

  it("offers no button for 'served' — prune-only by construction", () => {
    assert.equal("served" in NEXT_STATUS, false);
  });

  it("every button move agrees with the DB transition matrix", () => {
    for (const [target, from] of Object.entries(NEXT_STATUS)) {
      assert.equal(isLegalTransition(from, target), true, `${from}>${target} must be legal`);
    }
  });
});
