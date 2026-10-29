import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/* The two-layer table session is the one piece of this system that decides
   whether a stranger holding the table's QR code can read or edit somebody
   else's cart. It is therefore tested against the REAL service code and,
   when a database is available, against a real row:

     * the PIN/pass SHAPE is asserted with no database at all, because the
       generators are pure and a regression there is silent;
     * the lifecycle (claim → locked → 3 strikes → pass unlock → reconnect →
       settle wipe) runs against a throwaway table created by this suite and
       removed afterwards;
     * both staff read models are serialised wholesale and searched for the
       credentials, so "zero staff visibility" is proven, not assumed.

   `npm test` alone (no DATABASE_URL) still runs the pure half and skips the
   database half with a reason, exactly like the other suites are meant to be
   runnable anywhere. CI supplies a migrated database, so nothing is skipped
   there.

   IMPORTANT: src/config/env.ts exits the process when a required variable is
   missing. Defaults are installed BEFORE the service module is imported
   (dynamic import after the assignments) so `npm test` never dies at load. */

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.CLIENT_URL ??= "http://localhost:3000";
process.env.STAFF_PIN ??= "000000";
/* clearTableAsAdmin() pulls in admin.service.ts → env.ts, which hard-requires
   ADMIN_PIN. Without this default the suite dies at load on any machine that
   has no backend/.env (fresh clone, CI) — it only ever passed locally because
   a developer .env happened to supply it. */
process.env.ADMIN_PIN ??= "998877";
process.env.KDS_TOKEN_SECRET ??= "test-only-secret-not-used-anywhere-else";

const { AppError } = await import("../src/errors/app-error.js");
const sessions = await import("../src/services/sessions.service.js");
const { pruneTicket, listTickets } = await import("../src/services/kds.service.js");
const { listFloorTables, settleTableBill, clearFloorTable } = await import(
  "../src/services/floor.service.js"
);
const { clearTableAsAdmin } = await import("../src/services/admin.service.js");
const { pool } = await import("../src/db/pool.js");
const { initializeSchema, joinPassSchema, joinPinSchema, reconnectSchema } = await import(
  "../src/validation/schemas.js"
);

const PIN_RE = /^\d{2}$/;
const SECRET_RE = /^[A-Za-z0-9]{20}$/;
const MAX = sessions.MAX_PIN_ATTEMPTS;

/* A code the seed can never collide with, deleted again in `after()`. */
const TEST_CODE = `t${Date.now().toString(36)}`.slice(0, 12).toLowerCase();
const TEST_NAME = "Session security test table";

/* ---------------------------------------------------------------- helpers */

/* initialize() is a discriminated union (claimed vs already live). Narrowing
   here keeps every test honest: a suite that expected credentials from a
   locked table fails loudly instead of reading undefined. */
async function claim() {
  const result = await sessions.initializeSession(TEST_CODE);
  if (result.status !== "active") {
    assert.fail(`expected the scan to claim the table, got ${result.status}`);
  }
  return result;
}

async function scanLocked() {
  const result = await sessions.initializeSession(TEST_CODE);
  if (result.status !== "locked") {
    assert.fail(`expected a locked reply, got ${result.status}`);
  }
  return result;
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

async function readRow() {
  const res = await pool.query<{
    status: string;
    session_pin: string | null;
    session_secret: string | null;
    failed_pin_attempts: number;
    session_started_at: Date | null;
    bill_status: string;
    bill_paid_at: Date | null;
    clear_requested_at: Date | null;
  }>(
    `SELECT status, session_pin, session_secret, failed_pin_attempts, session_started_at,
            bill_status, bill_paid_at, clear_requested_at
       FROM restaurant_tables WHERE code = $1`,
    [TEST_CODE],
  );
  const row = res.rows[0];
  assert.ok(row, "the test table should exist");
  return row;
}

async function testTableId(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    "SELECT id FROM restaurant_tables WHERE code = $1",
    [TEST_CODE],
  );
  const id = res.rows[0]?.id;
  assert.ok(id, "the test table should exist");
  return id;
}

async function resetTable() {
  await pool.query(
    `DELETE FROM orders
      WHERE table_id = (SELECT id FROM restaurant_tables WHERE code = $1)`,
    [TEST_CODE],
  );
  await pool.query(
    `DELETE FROM table_device_presence
      WHERE table_id = (SELECT id FROM restaurant_tables WHERE code = $1)`,
    [TEST_CODE],
  );    await pool.query(
      `DELETE FROM cart_items
        WHERE table_id = (SELECT id FROM restaurant_tables WHERE code = $1)`,
      [TEST_CODE],
    );
    await pool.query(
      `DELETE FROM table_members
        WHERE table_id = (SELECT id FROM restaurant_tables WHERE code = $1)`,
      [TEST_CODE],
    );
  await pool.query(
    `UPDATE restaurant_tables
        SET status = 'empty', session_pin = NULL, session_secret = NULL,
            failed_pin_attempts = 0, session_started_at = NULL,
            bill_status = 'unrequested', bill_requested_at = NULL, bill_paid_at = NULL,
            clear_requested_at = NULL
      WHERE code = $1`,
    [TEST_CODE],
  );
}

/* ------------------------------------------------------------- pure layer */

describe("session credential generators", () => {
  it("mints a PIN that is always two digits, leading zero included", () => {
    const seen = new Set<string>();

    for (let i = 0; i < 200; i += 1) {
      const pin = sessions.generateSessionPin();
      assert.match(pin, PIN_RE);
      const numeric = Number(pin);
      assert.ok(numeric >= 0 && numeric <= 99, `PIN out of range: ${pin}`);
      seen.add(pin);
    }

    // '00'–'09' must be reachable: a numeric padStart that dropped zeros
    // would produce single characters and this set would contain none.
    assert.ok(
      [...seen].some((pin) => pin.startsWith("0")),
      "expected at least one leading-zero PIN across 200 draws",
    );
  });

  it("mints a 20-character alphanumeric pass, never repeating", () => {
    const seen = new Set<string>();

    for (let i = 0; i < 50; i += 1) {
      const secret = sessions.generateSessionSecret();
      assert.match(secret, SECRET_RE);
      assert.equal(secret.length, sessions.SESSION_SECRET_LENGTH);
      seen.add(secret);
    }

    assert.equal(seen.size, 50, "two generated passes collided");
  });

  it("keeps the documented thresholds", () => {
    assert.equal(MAX, 3);
    assert.equal(sessions.SESSION_SECRET_LENGTH, 20);
  });
});

/* The name is not decoration: it is the only thing that keeps a ticket, a
   split-bill tab and the roster pointing at a person. The API therefore
   refuses every entry point without one. */
describe("the guest name on every entry point", () => {
  const token = { table_token: "k7x2p" };

  it("refuses initialize without a usable name", () => {
    assert.equal(initializeSchema.safeParse(token).success, false);
    assert.equal(initializeSchema.safeParse({ ...token, name: "   " }).success, false);
  });

  it("trims and keeps the name it is given", () => {
    const parsed = initializeSchema.safeParse({
      ...token,
      user_id: "dev_1234",
      name: "  Ravi  ",
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.name, "Ravi");
    assert.equal(parsed.data.user_id, "dev_1234");
  });

  it("refuses join-pin, join-pass and reconnect without one", () => {
    assert.equal(joinPinSchema.safeParse({ ...token, pin: "07" }).success, false);
    assert.equal(joinPassSchema.safeParse({ ...token, secret: "a".repeat(20) }).success, false);
    assert.equal(reconnectSchema.safeParse({ ...token, secret: "a".repeat(20) }).success, false);
  });

  it("accepts all three when the name is present", () => {
    const name = "Ravi";
    assert.equal(joinPinSchema.safeParse({ ...token, pin: "07", name }).success, true);
    assert.equal(joinPassSchema.safeParse({ ...token, secret: "a".repeat(20), name }).success, true);
    assert.equal(reconnectSchema.safeParse({ ...token, secret: "a".repeat(20), name }).success, true);
  });

  it("caps the name at 40 characters", () => {
    assert.equal(initializeSchema.safeParse({ ...token, name: "a".repeat(40) }).success, true);
    assert.equal(initializeSchema.safeParse({ ...token, name: "a".repeat(41) }).success, false);
  });
});

/* ------------------------------------------------------- database lifecycle */

describe("table session lifecycle", { skip: hasDatabase ? false : "DATABASE_URL not set" }, () => {
  before(async () => {
    await pool.query(
      `INSERT INTO restaurant_tables (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO NOTHING`,
      [TEST_CODE, TEST_NAME],
    );
    await resetTable();
  });

  after(async () => {
    await resetTable().catch(() => undefined);
    await pool
      .query("DELETE FROM restaurant_tables WHERE code = $1", [TEST_CODE])
      .catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it("claims an empty table: exact PIN/pass shape, no prior attempts", async () => {
    await resetTable();

    const granted = await claim();

    assert.equal(granted.status, "active");
    assert.match(granted.session_pin, PIN_RE);
    assert.match(granted.session_secret, SECRET_RE);

    const row = await readRow();
    assert.equal(row.status, "active");
    assert.equal(row.session_pin, granted.session_pin);
    assert.equal(row.session_secret, granted.session_secret);
    assert.equal(row.failed_pin_attempts, 0);
    assert.ok(row.session_started_at instanceof Date, "session_started_at must be stamped");
  });

  it("answers a second scan of a live table with locked and no credentials", async () => {
    await resetTable();
    const first = await claim();

    const second = await scanLocked();

    assert.equal(second.pin_locked, false);
    assert.equal(second.attempts_remaining, MAX);
    assert.equal(second.realtime_token, null);
    assert.ok(!("session_secret" in second), "the locked reply must not carry the pass");
    assert.ok(!("session_pin" in second), "the locked reply must not carry the PIN");

    // Nothing was released to the second caller: the stored credentials are
    // exactly the ones the first device received.
    const row = await readRow();
    assert.equal(row.session_pin, first.session_pin);
    assert.equal(row.session_secret, first.session_secret);
  });

  it("joins with the right PIN and clears any earlier misses", async () => {
    await resetTable();
    const granted = await claim();
    const pin = granted.session_pin;

    await expectAppError(
      sessions.joinWithPin({ table_token: TEST_CODE, pin: pin === "00" ? "99" : "00" }),
      "INVALID_SESSION_PIN",
    );

    const joined = await sessions.joinWithPin({ table_token: TEST_CODE, pin });

    assert.equal(joined.status, "active");
    assert.equal(joined.session_pin, pin);
    assert.equal(joined.session_secret, granted.session_secret);

    const row = await readRow();
    assert.equal(row.failed_pin_attempts, 0, "a correct PIN must reset the counter");
  });

  it("counts misses down and locks the TABLE on the third", async () => {
    await resetTable();
    const granted = await claim();
    const wrong = granted.session_pin === "00" ? "99" : "00";

    const first = await sessions
      .joinWithPin({ table_token: TEST_CODE, pin: wrong })
      .then(() => null)
      .catch((err: unknown) => err);
    assert.ok(first instanceof AppError);
    assert.equal(first.status, 401);
    assert.equal(Number(first.details?.attempts_remaining), 2);

    const second = await sessions
      .joinWithPin({ table_token: TEST_CODE, pin: wrong })
      .then(() => null)
      .catch((err: unknown) => err);
    assert.ok(second instanceof AppError);
    assert.equal(Number(second.details?.attempts_remaining), 1);

    // The 3rd wrong PIN is the lock itself.
    await expectAppError(
      sessions.joinWithPin({ table_token: TEST_CODE, pin: wrong }),
      "TABLE_PIN_LOCKED",
    );

    const row = await readRow();
    assert.equal(row.failed_pin_attempts, MAX);

    // Locked is table-wide: the CORRECT PIN is refused too.
    await expectAppError(
      sessions.joinWithPin({ table_token: TEST_CODE, pin: granted.session_pin }),
      "TABLE_PIN_LOCKED",
    );

    // And a fresh scan of that table reports the flag without credentials.
    const flagged = await scanLocked();
    assert.equal(flagged.pin_locked, true);
    assert.equal(flagged.attempts_remaining, 0);
  });

  it("unlocks a flagged table with the pass and resets the counter", async () => {
    await resetTable();
    const granted = await claim();
    const wrong = granted.session_pin === "00" ? "99" : "00";

    for (let attempt = 0; attempt < MAX; attempt += 1) {
      await sessions
        .joinWithPin({ table_token: TEST_CODE, pin: wrong })
        .catch(() => undefined);
    }
    assert.equal((await readRow()).failed_pin_attempts, MAX);

    const wrongPass = granted.session_secret === "A".repeat(20) ? "B".repeat(20) : "A".repeat(20);
    await expectAppError(
      sessions.joinWithPass({ table_token: TEST_CODE, secret: wrongPass }),
      "INVALID_SESSION_SECRET",
    );

    const joined = await sessions.joinWithPass({
      table_token: TEST_CODE,
      secret: granted.session_secret,
    });

    assert.equal(joined.status, "active");
    assert.equal(joined.session_pin, granted.session_pin);
    assert.equal((await readRow()).failed_pin_attempts, 0, "the pass must unflag the table");

    // The keypad works again immediately after an unlock.
    const byPin = await sessions.joinWithPin({ table_token: TEST_CODE, pin: granted.session_pin });
    assert.equal(byPin.status, "active");
  });

  it("reconnects a returning device and refuses a stale pass", async () => {
    await resetTable();
    const granted = await claim();

    const live = await sessions.reconnectSession({
      table_token: TEST_CODE,
      secret: granted.session_secret,
    });
    assert.equal(live.status, "active");
    assert.equal(live.session_pin, granted.session_pin);

    const stale = granted.session_secret === "A".repeat(20) ? "B".repeat(20) : "A".repeat(20);
    await expectAppError(
      sessions.reconnectSession({ table_token: TEST_CODE, secret: stale }),
      "SESSION_ENDED",
    );
  });

  it("registers the returning device on reconnect and renames it in place", async () => {
    await resetTable();
    const granted = await claim();
    const tableId = await testTableId();

    await sessions.reconnectSession({
      table_token: TEST_CODE,
      secret: granted.session_secret,
      member: { user_id: "dev-returning", name: "Ravi" },
    });

    const memberRows = () =>
      pool.query<{ user_id: string; name: string }>(
        "SELECT user_id, name FROM table_members WHERE table_id = $1 ORDER BY user_id",
        [tableId],
      );

    const first = await memberRows();
    assert.equal(first.rows.length, 1, "reconnect must add exactly one roster row");
    assert.equal(first.rows[0]?.name, "Ravi");

    // A refresh with a corrected name updates the row; it never forks one.
    await sessions.reconnectSession({
      table_token: TEST_CODE,
      secret: granted.session_secret,
      member: { user_id: "dev-returning", name: "Ravi Kumar" },
    });

    const renamed = await memberRows();
    assert.equal(renamed.rows.length, 1, "a second reconnect must not duplicate the member");
    assert.equal(renamed.rows[0]?.name, "Ravi Kumar");
  });

  it("keeps the session alive when the last ticket is served before payment", async () => {
    await resetTable();
    const granted = await claim();
    const tableId = await testTableId();

    const orderRes = await pool.query<{ id: string }>(
      "INSERT INTO orders (table_id, status) VALUES ($1, 'ready') RETURNING id",
      [tableId],
    );
    const orderId = orderRes.rows[0]?.id;
    assert.ok(orderId);

    // Serving the ticket must NOT clear the table: the guests are still
    // sitting there and the bill is still unpaid.
    const pruned = await pruneTicket(orderId);
    assert.equal(pruned.table_cleared, false);

    const row = await readRow();
    assert.equal(row.status, "active");
    assert.equal(row.session_pin, granted.session_pin);
    assert.equal(row.session_secret, granted.session_secret);
    assert.equal(row.bill_status, "unrequested");

    const live = await sessions.reconnectSession({
      table_token: TEST_CODE,
      secret: granted.session_secret,
    });
    assert.equal(live.status, "active");
  });

  it("does not release a paid table while an order is still active", async () => {
    await resetTable();
    const granted = await claim();
    const tableId = await testTableId();

    await pool.query("INSERT INTO orders (table_id, status) VALUES ($1, 'preparing')", [tableId]);

    const settled = await settleTableBill(tableId);
    assert.equal(settled.bill_status, "paid");
    assert.equal(settled.released, false, "a live ticket must block the release");

    const row = await readRow();
    assert.equal(row.status, "active");
    assert.equal(row.session_pin, granted.session_pin);
    assert.equal(row.session_secret, granted.session_secret);
    assert.equal(row.bill_status, "paid");
    assert.ok(row.bill_paid_at instanceof Date, "bill_paid_at must be stamped");

    // A later sweep sees the same live ticket and still refuses.
    const swept = await sessions.checkAndAutoReleaseTable(tableId);
    assert.equal(swept.released, false);
  });

  it("does not release a paid, empty table while a device heartbeat is fresh", async () => {
    await resetTable();
    const granted = await claim();
    const tableId = await testTableId();

    await sessions.recordHeartbeat(TEST_CODE, "device-alpha");

    const settled = await settleTableBill(tableId);
    assert.equal(settled.bill_status, "paid");
    assert.equal(settled.released, false, "a connected device must block the release");

    const row = await readRow();
    assert.equal(row.status, "active");
    assert.equal(row.session_pin, granted.session_pin);
    assert.equal(row.session_secret, granted.session_secret);

    const swept = await sessions.checkAndAutoReleaseTable(tableId);
    assert.equal(swept.released, false);
  });

  it("auto-releases a paid table when orders are 0 and presence drops to 0", async () => {
    await resetTable();
    const granted = await claim();
    const tableId = await testTableId();

    await sessions.recordHeartbeat(TEST_CODE, "device-alpha");
    const settled = await settleTableBill(tableId);
    assert.equal(settled.bill_status, "paid");
    assert.equal(settled.released, false);

    // The last device closes its tab: removing the heartbeat runs the same
    // three-condition check and this time all three agree.
    const dropped = await sessions.removeHeartbeat(TEST_CODE, "device-alpha");
    assert.equal(dropped.released, true);

    const row = await readRow();
    assert.equal(row.status, "empty");
    assert.equal(row.session_pin, null);
    assert.equal(row.session_secret, null);
    assert.equal(row.failed_pin_attempts, 0);
    assert.equal(row.session_started_at, null);
    assert.equal(row.bill_status, "unrequested");
    assert.equal(row.bill_paid_at, null);

    // The old device's stored pass is now worthless — and says so plainly.
    await expectAppError(
      sessions.reconnectSession({ table_token: TEST_CODE, secret: granted.session_secret }),
      "SESSION_ENDED",
    );

    // The next party starts from a genuinely fresh pair.
    const fresh = await claim();
    assert.notEqual(fresh.session_secret, granted.session_secret);
  });

  it("lets staff clear a flagged table that has nothing owed", async () => {
    await resetTable();
    await claim();
    const tableId = await testTableId();

    const result = await clearFloorTable(tableId);
    assert.equal(result.cleared, true);

    const row = await readRow();
    assert.equal(row.status, "empty");
    assert.equal(row.session_pin, null);
    assert.equal(row.session_secret, null);
    assert.equal(row.clear_requested_at, null);
  });

  it("does not let a previous party's ticket block the next clear", async () => {
    await resetTable();
    const tableId = await testTableId();

    // Orders are history and are never deleted; a cleared table therefore
    // keeps the last party's served ticket forever. It must not read as money
    // owed by the brand-new session.
    await pool.query(
      `INSERT INTO orders (table_id, status, total, created_at)
            VALUES ($1, 'served', 250, now() - interval '1 hour')`,
      [tableId],
    );

    await claim(); // fresh session, no ticket of its own yet
    const result = await clearFloorTable(tableId);
    assert.equal(result.cleared, true);
  });

  it("refuses a staff clear on an unpaid bill and raises the admin alert", async () => {
    await resetTable();
    await claim();
    const tableId = await testTableId();

    // A ticket from THIS session exists and the bill was never settled: money
    // is owed. It is deliberately `served`, so no open ticket masks the rule.
    await pool.query(
      "INSERT INTO orders (table_id, status, total) VALUES ($1, 'served', 250)",
      [tableId],
    );

    await expectAppError(clearFloorTable(tableId), "BILL_UNPAID");

    const refused = await readRow();
    assert.equal(refused.status, "active");
    assert.equal(refused.session_pin !== null, true);
    assert.ok(refused.clear_requested_at instanceof Date, "the admin alert must be stamped");

    // The manager override is the only clear that succeeds here.
    const cleared = await clearTableAsAdmin(tableId);
    assert.equal(cleared.cleared, true);

    const row = await readRow();
    assert.equal(row.status, "empty");
    assert.equal(row.session_pin, null);
    assert.equal(row.clear_requested_at, null);
  });

  it("never leaks either credential through the staff read models", async () => {
    await resetTable();
    const granted = await claim();

    const floor = await listFloorTables({ page: 1, limit: 100 });
    const tickets = await listTickets({ page: 1, limit: 100 });

    const floorJson = JSON.stringify(floor);
    const ticketJson = JSON.stringify(tickets);

    for (const json of [floorJson, ticketJson]) {
      assert.ok(!json.includes("session_pin"), "a staff payload exposed the PIN column");
      assert.ok(!json.includes("session_secret"), "a staff payload exposed the pass column");
      assert.ok(!json.includes(granted.session_secret), "a staff payload exposed the pass VALUE");
    }

    // The row itself is still reachable by staff — this is about the two
    // columns, not about hiding the table.
    assert.ok(floorJson.includes(TEST_CODE), "the floor model must still list the table");
  });
});
