import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/* Module 5 — the executive console.
 *
 * Two halves, on purpose:
 *
 *   PURE — the PIN comparison, the code generator and the login claim need no
 *   database at all. A regression there (a PIN accepted with the wrong
 *   comparison, a predictable code) is silent and dangerous, so it is pinned
 *   on every `npm test` run, database or not.
 *
 *   DATABASE — table creation, token regeneration, menu CRUD and the
 *   best-seller aggregation all run against real SQL, because the behaviour
 *   that matters is transactional (regenerate clears the cart AND serves the
 *   open orders AND rotates the code in one commit). The suite creates its own
 *   rows and removes them afterwards, and skips cleanly with a reason when no
 *   DATABASE_URL is configured.
 *
 * src/config/env.ts exits the process when a required variable is missing, so
 * defaults are installed BEFORE the service module is imported.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.CLIENT_URL ??= "http://localhost:3000";
process.env.STAFF_PIN ??= "000000";
process.env.ADMIN_PIN ??= "998877";
process.env.KDS_TOKEN_SECRET ??= "test-only-secret-not-used-anywhere-else";

const { AppError } = await import("../src/errors/app-error.js");
const admin = await import("../src/services/admin.service.js");
const { verifyToken } = await import("../src/lib/jwt.js");
const { pool } = await import("../src/db/pool.js");

const ADMIN_PIN = process.env.ADMIN_PIN as string;
const CODE_RE = /^[a-z0-9]{5,8}$/;
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

/* The runtime class comes from a dynamic import, so its TYPE is derived from
   the value rather than annotated with the (import-only) class name. */
type AppErrorInstance = InstanceType<typeof AppError>;

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
): Promise<AppErrorInstance> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError ${code}, got ${String(err)}`);
    assert.equal(err.code, code);
    return err as AppErrorInstance;
  }
  assert.fail(`expected AppError ${code}, but the call resolved`);
}

/* ---------------------------------------------------------------- pure --- */

describe("admin PIN + claim", () => {
  it("generates lowercase alphanumeric codes in the documented range", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = admin.generateTableCode();
      assert.match(code, CODE_RE);
      assert.ok(code.length >= 5 && code.length <= 8);
    }
  });

  it("clamps an out-of-range requested length into 5–8 characters", () => {
    assert.match(admin.generateTableCode(1), /^[a-z0-9]{5}$/);
    assert.match(admin.generateTableCode(40), /^[a-z0-9]{8}$/);
  });

  it("produces distinct codes instead of a predictable sequence", () => {
    const codes = new Set(Array.from({ length: 60 }, () => admin.generateTableCode()));
    assert.equal(codes.size, 60);
  });

  it("compares the manager PIN in constant time and rejects the wrong one", () => {
    assert.equal(admin.adminPinMatches(ADMIN_PIN, ADMIN_PIN), true);

    const wrong = ADMIN_PIN === "000000" ? "111111" : "000000";
    assert.equal(admin.adminPinMatches(wrong, ADMIN_PIN), false);
    // A different LENGTH must fail without throwing (timingSafeEqual does).
    assert.equal(admin.adminPinMatches("1", ADMIN_PIN), false);
  });

  it("issues a role:'admin' token with an 8-hour TTL for the right PIN", async () => {
    const session = await admin.authenticateAdmin(ADMIN_PIN);

    assert.equal(session.role, "admin");
    assert.equal(session.expires_in, TOKEN_TTL_SECONDS);

    const claims = verifyToken(session.token, process.env.KDS_TOKEN_SECRET as string);
    assert.ok(claims, "the issued token must verify with the shared HMAC secret");
    assert.equal(claims.role, "admin");
    assert.equal(claims.exp - claims.iat, TOKEN_TTL_SECONDS);
  });

  it("answers a wrong PIN with 401 INVALID_ADMIN_PIN and no token", async () => {
    const wrong = ADMIN_PIN === "000000" ? "111111" : "000000";
    const error = await expectAppError(admin.authenticateAdmin(wrong), "INVALID_ADMIN_PIN");
    assert.equal(error.status, 401);
    // The message must never echo the attempted PIN.
    assert.ok(!error.message.includes(wrong));
  });
});

/* ------------------------------------------------------------ database --- */

const suite = hasDatabase ? describe : describe.skip;
const reason = hasDatabase ? "" : "DATABASE_URL is not configured";

suite(`admin engine against Postgres${reason ? ` — SKIPPED (${reason})` : ""}`, () => {
  const stamp = Date.now().toString(36);

  /* Rows created by this suite. Cleaned in `after()` in dependency order:
     items → orders (cascades order_items) → menu rows → tables. */
  const createdTableIds: string[] = [];
  const createdMenuItemIds: string[] = [];
  const createdOrderIds: string[] = [];

  let kitchenMenuId = "";
  let analyticsMenuId = "";

  before(async () => {
    const menu = await admin.createMenuItem({
      name: `Admin test dish ${stamp}`,
      price: 123.45,
      category: "Admin Test",
      description: "Created by backend/test/admin.test.ts",
      vegetarian: true,
      is_available: true,
    });
    kitchenMenuId = menu.menu_item_id;
    createdMenuItemIds.push(menu.menu_item_id);

    const analytics = await admin.createMenuItem({
      name: `Admin analytics dish ${stamp}`,
      price: 100,
      category: "Admin Test",
      description: "High volume so it wins the leaderboard in a shared test DB",
      vegetarian: false,
      is_available: true,
    });
    analyticsMenuId = analytics.menu_item_id;
    createdMenuItemIds.push(analytics.menu_item_id);
  });

  after(async () => {
    if (createdOrderIds.length > 0) {
      await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [createdOrderIds]);
    }
    if (createdMenuItemIds.length > 0) {
      await pool.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [createdMenuItemIds]);
    }
    if (createdTableIds.length > 0) {
      await pool.query("DELETE FROM restaurant_tables WHERE id = ANY($1::uuid[])", [
        createdTableIds,
      ]);
    }
    await pool.end();
  });

  it("creates a table with a unique code and lists it as live", async () => {
    const table = await admin.createTable({ name: `Admin test table ${stamp}` });
    createdTableIds.push(table.table_id);

    assert.match(table.code, CODE_RE);
    assert.equal(table.status, "empty");
    assert.equal(table.has_session, false);
    assert.equal(table.active_order_count, 0);

    const list = await admin.listAdminTables();
    const row = list.find((entry) => entry.table_id === table.table_id);
    assert.ok(row, "the new table must appear in the admin grid");
    assert.equal(row.code, table.code);
  });

  it("creates a distinct code per table", async () => {
    const [first, second] = await Promise.all([
      admin.createTable({ name: `Admin code A ${stamp}` }),
      admin.createTable({ name: `Admin code B ${stamp}` }),
    ]);
    createdTableIds.push(first.table_id, second.table_id);
    assert.notEqual(first.code, second.code);
  });

  it("renames a table without rotating its code", async () => {
    const table = await admin.createTable({ name: `Rename me ${stamp}` });
    createdTableIds.push(table.table_id);

    const renamed = await admin.updateTableName(table.table_id, { name: "Corner booth" });
    assert.equal(renamed.name, "Corner booth");

    const list = await admin.listAdminTables();
    const row = list.find((entry) => entry.table_id === table.table_id);
    assert.ok(row);
    assert.equal(row.name, "Corner booth");
    assert.equal(row.code, table.code);
  });

  it("re-codes an empty table, folding the case, and refuses once it is in use", async () => {
    const table = await admin.createTable({ name: `Recode ${stamp}` });
    createdTableIds.push(table.table_id);

    const desired = `x${stamp.slice(-6)}`.slice(0, 8).toLowerCase();
    assert.match(desired, CODE_RE);

    const saved = await admin.updateTableCode(table.table_id, { code: desired.toUpperCase() });
    assert.equal(saved.code, desired, "uppercase input is stored lowercase");
    assert.equal(saved.name, table.name);

    // Re-saving the current code is a no-op, not a conflict.
    const again = await admin.updateTableCode(table.table_id, { code: desired });
    assert.equal(again.code, desired);

    // Once a party is seated the code is pinned under their phones.
    await pool.query(
      `UPDATE restaurant_tables
          SET status = 'active', session_pin = '12', session_started_at = now()
        WHERE id = $1`,
      [table.table_id],
    );

    const error = await expectAppError(
      admin.updateTableCode(table.table_id, { code: `${desired.slice(0, 4)}q` }),
      "TABLE_NOT_EMPTY",
    );
    assert.equal(error.status, 409);
  });

  it("refuses a code another live table already owns", async () => {
    const [owner, other] = await Promise.all([
      admin.createTable({ name: `Code owner ${stamp}` }),
      admin.createTable({ name: `Code other ${stamp}` }),
    ]);
    createdTableIds.push(owner.table_id, other.table_id);

    const error = await expectAppError(
      admin.updateTableCode(other.table_id, { code: owner.code }),
      "TABLE_CODE_TAKEN",
    );
    assert.equal(error.status, 409);
  });

  it("regenerates the token: new code, cart wiped, orders served, session cleared", async () => {
    const table = await admin.createTable({ name: `Regenerate ${stamp}` });
    createdTableIds.push(table.table_id);

    // Open a real session and stage a real cart line on the table.
    await pool.query(
      `UPDATE restaurant_tables
          SET status = 'active',
              session_pin = '42',
              session_secret = 'ABCDEFGHIJKLMNOPQRST',
              failed_pin_attempts = 2,
              session_started_at = now()
        WHERE id = $1`,
      [table.table_id],
    );

    await pool.query(
      `INSERT INTO cart_items (table_id, menu_item_id, quantity, added_by)
            VALUES ($1, $2, 1, 'Guest')`,
      [table.table_id, kitchenMenuId],
    );

    const order = await pool.query<{ id: string }>(
      "INSERT INTO orders (table_id, status) VALUES ($1, 'preparing') RETURNING id",
      [table.table_id],
    );
    const orderId = order.rows[0]?.id;
    assert.ok(orderId);
    createdOrderIds.push(orderId);

    const rotated = await admin.regenerateTableToken(table.table_id);
    assert.match(rotated.code, CODE_RE);
    assert.notEqual(rotated.code, table.code);

    const row = await pool.query<{
      status: string;
      session_pin: string | null;
      session_secret: string | null;
      failed_pin_attempts: number;
      session_started_at: Date | null;
    }>(
      `SELECT status, session_pin, session_secret, failed_pin_attempts, session_started_at
         FROM restaurant_tables WHERE id = $1`,
      [table.table_id],
    );
    const stored = row.rows[0];
    assert.ok(stored);
    assert.equal(stored.status, "empty");
    assert.equal(stored.session_pin, null);
    assert.equal(stored.session_secret, null);
    assert.equal(stored.failed_pin_attempts, 0);
    assert.equal(stored.session_started_at, null);

    const cart = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM cart_items WHERE table_id = $1",
      [table.table_id],
    );
    assert.equal(cart.rows[0]?.count, 0);

    // The open ticket is closed, not deleted: the day's sales stay intact.
    const served = await pool.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [orderId],
    );
    assert.equal(served.rows[0]?.status, "served");
  });

  it("archives a table instead of dropping the row", async () => {
    const table = await admin.createTable({ name: `Archive me ${stamp}` });
    createdTableIds.push(table.table_id);

    await admin.archiveTable(table.table_id);

    const list = await admin.listAdminTables();
    assert.equal(
      list.some((entry) => entry.table_id === table.table_id),
      false,
      "an archived table must leave the admin grid",
    );

    const row = await pool.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM restaurant_tables WHERE id = $1",
      [table.table_id],
    );
    assert.ok(row.rows[0]?.deleted_at, "the row must still exist, carrying deleted_at");
  });

  it("creates, updates, 86s and soft-deletes a dish", async () => {
    const dish = await admin.createMenuItem({
      name: `Menu CRUD ${stamp}`,
      price: 199,
      category: "Admin Test",
      description: "First description",
      vegetarian: true,
      is_available: true,
    });
    createdMenuItemIds.push(dish.menu_item_id);

    assert.equal(dish.price, 199);
    assert.equal(dish.is_available, true);

    const edited = await admin.updateMenuItem(dish.menu_item_id, {
      price: 249.5,
      description: "Second description",
      is_available: false,
    });
    assert.equal(edited.price, 249.5);
    assert.equal(edited.description, "Second description");
    assert.equal(edited.is_available, false);
    // Unspecified fields survive a partial update.
    assert.equal(edited.name, `Menu CRUD ${stamp}`);
    assert.equal(edited.vegetarian, true);

    const archived = await admin.archiveMenuItem(dish.menu_item_id);
    assert.equal(archived.menu_item_id, dish.menu_item_id);

    const list = await admin.listAdminMenu();
    assert.equal(list.some((item) => item.menu_item_id === dish.menu_item_id), false);

    const row = await pool.query<{ deleted_at: Date | null; is_available: boolean }>(
      "SELECT deleted_at, is_available FROM menu_items WHERE id = $1",
      [dish.menu_item_id],
    );
    assert.ok(row.rows[0]?.deleted_at, "archiving is a soft delete");
    assert.equal(row.rows[0]?.is_available, false);
  });

  it("aggregates best sellers from SERVED orders using the fire-time price", async () => {
    const table = await admin.createTable({ name: `Analytics ${stamp}` });
    createdTableIds.push(table.table_id);

    // A high quantity so this row ranks first even on a shared database.
    const quantity = 97;
    const unitPrice = 100;

    const order = await pool.query<{ id: string }>(
      "INSERT INTO orders (table_id, status, total) VALUES ($1, 'served', $2) RETURNING id",
      [table.table_id, quantity * unitPrice],
    );
    const orderId = order.rows[0]?.id;
    assert.ok(orderId);
    createdOrderIds.push(orderId);

    await pool.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
            VALUES ($1, $2, $3, $4)`,
      [orderId, analyticsMenuId, quantity, unitPrice],
    );

    const analytics = await admin.topSellingAnalytics();

    const row = analytics.items.find((item) => item.menu_item_id === analyticsMenuId);
    assert.ok(row, "the sold dish must appear in the leaderboard");
    assert.equal(row.total_sold, quantity);
    assert.equal(row.total_revenue, quantity * unitPrice);
    assert.equal(row.name, `Admin analytics dish ${stamp}`);

    // Summary figures cover the whole database, so they are lower bounds.
    assert.ok(analytics.total_revenue >= quantity * unitPrice);
    assert.ok(analytics.total_orders_served >= 1);
    assert.ok(analytics.active_tables_count >= 0);

    // Leaderboard is ordered by units sold, descending.
    const sold = analytics.items.map((item) => item.total_sold);
    assert.deepEqual(sold, [...sold].sort((a, b) => b - a));
  });

  it("treats an unknown id as 404 on every mutation", async () => {
    const missing = randomUUID();

    await expectAppError(admin.updateTableName(missing, { name: "x" }), "TABLE_NOT_FOUND");
    await expectAppError(admin.regenerateTableToken(missing), "TABLE_NOT_FOUND");
    await expectAppError(admin.archiveTable(missing), "TABLE_NOT_FOUND");
    await expectAppError(admin.updateMenuItem(missing, { price: 1 }), "MENU_ITEM_NOT_FOUND");
    await expectAppError(admin.archiveMenuItem(missing), "MENU_ITEM_NOT_FOUND");
  });
});
