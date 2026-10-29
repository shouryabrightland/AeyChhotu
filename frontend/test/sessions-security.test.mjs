import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The frontend half of table security.
 *
 * These are the decisions the UI makes on its own, with no network in the
 * loop — and every one of them is a decision an attacker can probe:
 *
 *   - what counts as a well-formed PIN / pass (the API validates too, but a
 *     gate that submits '7' is a gate that spends an attempt on a typo)
 *   - when the keypad is withdrawn, counted from the SERVER's figure
 *   - what a failed join means for the next screen
 *   - which QR payloads are accepted
 *
 * Anything that needs a browser (localStorage, cameras) is deliberately not
 * tested here; the pure module is where the rules live. */

import {
  MAX_PIN_ATTEMPTS,
  PIN_LENGTH,
  SESSION_SECRET_LENGTH,
  attemptsRemaining,
  encodePassPayload,
  gatePhase,
  isPinLocked,
  isValidPin,
  isValidSessionSecret,
  joinFailureFor,
  parsePassPayload,
} from "../lib/diner/table-pass.ts";

const SECRET = "aB3dE5gH7jK9mN1pQ3sT";

describe("PIN format ('00'–'99')", () => {
  it("accepts every code from 00 to 99, leading zeros included", () => {
    for (let value = 0; value < 100; value += 1) {
      const pin = String(value).padStart(2, "0");
      assert.equal(isValidPin(pin), true, `rejected the valid PIN ${pin}`);
    }
  });

  it("keeps the documented width", () => {
    assert.equal(PIN_LENGTH, 2);
    assert.equal(MAX_PIN_ATTEMPTS, 3);
  });

  it("rejects short, long, signed, spaced and non-ASCII input", () => {
    for (const bad of ["", "7", "007", "-1", "+1", "1 ", " 1", "1.0", "aa", "١٢"]) {
      assert.equal(isValidPin(bad), false, `accepted the invalid PIN ${JSON.stringify(bad)}`);
    }
  });
});

describe("session pass format", () => {
  it("accepts exactly 20 letters or digits", () => {
    assert.equal(isValidSessionSecret(SECRET), true);
    assert.equal(SECRET.length, SESSION_SECRET_LENGTH);
    assert.equal(isValidSessionSecret("0".repeat(20)), true);
    assert.equal(isValidSessionSecret("Z".repeat(20)), true);
  });

  it("rejects anything the server would reject", () => {
    for (const bad of [
      "",
      SECRET.slice(0, 19),
      `${SECRET}x`,
      "-".repeat(20),
      "a".repeat(19) + " ",
      "a".repeat(19) + "_",
    ]) {
      assert.equal(isValidSessionSecret(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe("the table-wide lock", () => {
  it("counts server-reported attempts down to zero and never below", () => {
    assert.equal(attemptsRemaining(0), 3);
    assert.equal(attemptsRemaining(1), 2);
    assert.equal(attemptsRemaining(2), 1);
    assert.equal(attemptsRemaining(3), 0);
    assert.equal(attemptsRemaining(9), 0);
  });

  it("treats a missing or nonsensical counter as zero failures", () => {
    assert.equal(attemptsRemaining(Number.NaN), MAX_PIN_ATTEMPTS);
    assert.equal(attemptsRemaining(-4), MAX_PIN_ATTEMPTS);
  });

  it("locks on the third failure, not the fourth", () => {
    assert.equal(isPinLocked(2), false);
    assert.equal(isPinLocked(3), true);
    assert.equal(isPinLocked(4), true);
  });

  it("picks the screen from the table's state", () => {
    assert.equal(gatePhase("active", 0), "pin");
    assert.equal(gatePhase("active", 2), "pin");
    assert.equal(gatePhase("active", 3), "locked");
    assert.equal(gatePhase("empty", 0), "ended");
    assert.equal(gatePhase("empty", 3), "ended");
  });
});

describe("a failed join's next screen", () => {
  it("keeps the keypad with the server's remaining count", () => {
    const failure = joinFailureFor({
      status: 401,
      code: "INVALID_SESSION_PIN",
      message: "That PIN is not right. 2 tries left before the table locks.",
      details: { attempts_remaining: 2 },
    });

    assert.equal(failure.phase, "pin");
    assert.equal(failure.attemptsRemaining, 2);
    assert.match(failure.message, /2 tries left/);
  });

  it("withdraws the keypad the moment the table is flagged", () => {
    const failure = joinFailureFor({
      status: 423,
      code: "TABLE_PIN_LOCKED",
      message: "Table PIN locked after 3 failed attempts.",
      details: { attempts_remaining: 0, locked: true },
    });

    assert.equal(failure.phase, "locked");
    assert.equal(failure.attemptsRemaining, 0);
  });

  it("denies a code that is not a table, without claiming the visit ended", () => {
    const failure = joinFailureFor({
      status: 404,
      code: "TABLE_NOT_FOUND",
      message: "Invalid table token parsed.",
    });

    assert.equal(failure.phase, "missing", "a bad table is not a settled table");
  });

  it("ends the flow when the table was settled", () => {
    const failure = joinFailureFor({
      status: 403,
      code: "SESSION_ENDED",
      message: "This table session has ended.",
    });

    assert.equal(failure.phase, "ended");
  });

  it("sends a refused pass back to the keypad, not past it", () => {
    const failure = joinFailureFor({
      status: 403,
      code: "PASS_REQUIRES_PIN",
      message: "Enter the two-digit PIN on the table card to join.",
      details: { attempts_remaining: 3, failed_attempts: 0 },
    });

    assert.equal(failure.phase, "pin", "the pass is unlock-only");
    assert.equal(failure.attemptsRemaining, 3);
  });

  it("keeps the current screen usable when a SCANNED pass is wrong", () => {
    const failure = joinFailureFor({
      status: 401,
      code: "INVALID_SESSION_SECRET",
      message: "That table pass is not valid for this table.",
    });

    assert.equal(failure.phase, "error");
    assert.match(failure.message, /not valid/);
  });

  it("never invents an attempt count when the server omits one", () => {
    const failure = joinFailureFor({ status: 401, code: "INVALID_SESSION_PIN" });

    assert.equal(failure.phase, "pin");
    assert.equal(failure.attemptsRemaining, 0, "a missing count must not look generous");
  });
});

describe("the QR pass payload", () => {
  it("encodes a table link carrying the secret", () => {
    const payload = encodePassPayload({
      origin: "https://aeychhotu.example/",
      tableToken: "k7x2p",
      secret: SECRET,
    });

    assert.equal(payload, `https://aeychhotu.example/table/k7x2p?pass=${SECRET}`);
  });

  it("round-trips through the parser", () => {
    const tableToken = "m9b3x";
    const parsed = parsePassPayload(
      encodePassPayload({ origin: "http://localhost:3000", tableToken, secret: SECRET }),
    );

    assert.deepEqual(parsed, { tableToken, secret: SECRET });
  });

  it("accepts a bare secret, a relative link and the `secret` alias", () => {
    assert.deepEqual(parsePassPayload(SECRET), { tableToken: null, secret: SECRET });
    assert.deepEqual(parsePassPayload(`/table/k7x2p?pass=${SECRET}`), {
      tableToken: "k7x2p",
      secret: SECRET,
    });
    assert.deepEqual(parsePassPayload(`https://x.test/table/k7x2p?secret=${SECRET}`), {
      tableToken: "k7x2p",
      secret: SECRET,
    });
  });

  it("rejects codes that are not passes", () => {
    for (const raw of [
      "",
      "   ",
      "https://example.com",
      "/table/k7x2p",
      `/table/k7x2p?pass=${SECRET.slice(0, 19)}`,
      `/table/k7x2p?pass=${SECRET}&pass=short`,
      "hello world",
    ]) {
      assert.equal(parsePassPayload(raw), null, `accepted ${JSON.stringify(raw)}`);
    }
  });

  it("keeps a valid secret even when the link names an odd table", () => {
    const parsed = parsePassPayload(`/table/NOT-A-TOKEN?pass=${SECRET}`);
    assert.equal(parsed?.secret, SECRET);
    assert.equal(parsed?.tableToken, null);
  });
});
