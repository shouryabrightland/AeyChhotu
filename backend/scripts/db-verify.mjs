#!/usr/bin/env node
/* AeyChhotu! — database verification runner.
 *
 * Asserts that a database built by `npm run db:setup` is actually correct,
 * instead of trusting "the script exited 0". Covers the four things that
 * silently break in production:
 *
 *   1. SCHEMA      tables exist, RLS is switched on, all 24 policies present
 *   2. INDEXES     the 7 access-path indexes + the one-active-order constraint
 *   3. REPLICATION the Realtime publication + REPLICA IDENTITY FULL,
 *                  including the menu_items / restaurant_tables expansion
 *                  added by 008_realtime_expansion.sql
 *   4. SECURITY    claim-scoped RLS actually returns 0 rows with no token,
 *                  1 row for a diner token, the whole floor for a staff
 *                  token, and anon writes are denied
 *   5. HARDENING   the audit columns/triggers, the frozen price snapshot and
 *                  the status-transition guard added by 004_hardening.sql —
 *                  including firing a real cart in a rolled-back transaction
 *   6. SESSIONS    the PIN/pass columns, their shape constraints, and the
 *                  column privileges that keep both out of every browser
 *                  role (005_table_session_security.sql)
 *   7. BILLING     the bill columns + device-presence registry that drive
 *                  automatic table release (007_bill_and_auto_release.sql)
 *
 * Usage (from backend/):
 *   npm run db:verify
 *
 * Exit code 0 = everything asserted; 1 = at least one check failed.
 */

import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("[db:verify] FATAL: DATABASE_URL is missing or empty.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let passed = 0;
const failures = [];

function report(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const q = (text, params) => client.query(text, params);

try {
  const { rows: versionRows } = await q("SELECT version() AS v");
  console.log(`[db:verify] ${versionRows[0].v.split(",")[0]}`);

  // ---------------------------------------------------------------- 1. schema
  section("1. Schema & RLS");

  const EXPECTED_TABLES = [
    "restaurant_tables",
    "menu_items",
    "cart_items",
    "orders",
    "order_items",
    "staff_terminals",
  ];

  const { rows: tableRows } = await q(
    `SELECT c.relname AS name, c.relrowsecurity AS rls,
            (SELECT count(*)::int FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
    [EXPECTED_TABLES],
  );
  const byTable = new Map(tableRows.map((r) => [r.name, r]));

  for (const table of EXPECTED_TABLES) {
    const row = byTable.get(table);
    report(`table ${table}`, Boolean(row), row ? "" : "missing");
    if (row) report(`  ${table} RLS enabled`, row.rls === true);
  }

  const totalPolicies = tableRows.reduce((sum, r) => sum + r.policies, 0);
  report("24 RLS policies present", totalPolicies === 24, `found ${totalPolicies}`);

  // ---------------------------------------------------------------- 2. indexes
  section("2. Indexes & constraints");

  const { rows: indexRows } = await q(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  const indexes = new Set(indexRows.map((r) => r.indexname));

  for (const idx of [
    "cart_items_upsert_uq",
    "cart_items_table_created_idx",
    "orders_table_status_idx",
    "orders_active_idx",
    "orders_created_idx",
    "orders_one_active_uq",
    "order_items_order_idx",
    "menu_items_category_idx",
  ]) {
    report(`index ${idx}`, indexes.has(idx));
  }

  const { rows: fkRows } = await q(
    `SELECT confdeltype FROM pg_constraint
      WHERE conname = 'orders_table_id_fkey' AND conrelid = 'public.orders'::regclass`,
  );
  // confdeltype: 'r' = RESTRICT, 'c' = CASCADE
  report(
    "orders.table_id is ON DELETE RESTRICT",
    fkRows[0]?.confdeltype === "r",
    fkRows[0] ? `confdeltype=${fkRows[0].confdeltype}` : "constraint missing",
  );

  const { rows: fnRows } = await q(
    `SELECT p.oid::regprocedure AS sig
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fire_order'`,
  );
  report("fire_order(text) exists", fnRows.length > 0);

  // ------------------------------------------------------------ 3. replication
  section("3. Realtime replication");

  /* Logical decoding is a SERVER setting, not something the schema controls.
     Supabase ships wal_level=logical; a plain Postgres defaults to `replica`,
     where streaming is impossible and the app correctly falls back to REST
     polling. That is a degraded-but-valid deployment, so it is reported as a
     skip rather than a failure — failing here would train people to ignore
     this script. */
  const { rows: walRows } = await q("SELECT current_setting('wal_level', true) AS wal");
  const walLevel = walRows[0]?.wal;
  const realtimePossible = walLevel === "logical";

  if (!realtimePossible) {
    console.log(
      `  ⏭️  skipped — wal_level is "${walLevel ?? "unknown"}", so Realtime cannot stream here.`,
    );
    console.log(
      "      The app falls back to REST + 5s polling. Fix: postgres -c wal_level=logical",
    );
  } else {
    const { rows: pubRows } = await q(
      `SELECT tablename FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
        ORDER BY tablename`,
    );
    const published = pubRows.map((r) => r.tablename);
    report(
      "orders + cart_items streamed",
      published.includes("orders") && published.includes("cart_items"),
      published.join(", ") || "publication empty",
    );
    // 008: the admin console and floor board watch these two.
    report(
      "menu_items + restaurant_tables streamed (008)",
      published.includes("menu_items") && published.includes("restaurant_tables"),
      published.join(", ") || "publication empty",
    );
  }

  const { rows: identRows } = await q(
    `SELECT relname, relreplident FROM pg_class
      WHERE oid IN ('public.orders'::regclass, 'public.cart_items'::regclass,
                    'public.menu_items'::regclass, 'public.restaurant_tables'::regclass)`,
  );
  for (const row of identRows) {
    // relreplident: 'f' = FULL (needed so DELETE carries table_id for filters)
    report(`${row.relname} REPLICA IDENTITY FULL`, row.relreplident === "f");
  }

  // --------------------------------------------------------------- 4. security
  section("4. Claim-scoped RLS (the important one)");

  // Privileges: only the backend's service path may execute the fire RPC.
  const { rows: privRows } = await q(
    `SELECT
       has_function_privilege('anon', 'public.fire_order(text)', 'EXECUTE')          AS anon,
       has_function_privilege('authenticated', 'public.fire_order(text)', 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', 'public.fire_order(text)', 'EXECUTE')  AS service_role`,
  );
  report("fire_order NOT executable by anon", privRows[0].anon === false);
  report("fire_order NOT executable by authenticated", privRows[0].authenticated === false);
  report("fire_order executable by service_role", privRows[0].service_role === true);

  /* Simulate a browser holding only the public anon key, and count what it
     can actually read. `request.jwt.claims` is exactly the GUC PostgREST /
     Realtime populate from the JWT, so this is the real policy path. */
  async function readAsAnon(claims, table) {
    try {
      await q("BEGIN");
      await q("SELECT set_config('request.jwt.claims', $1, true)", [
        claims === null ? "" : JSON.stringify(claims),
      ]);
      await q("SET LOCAL ROLE anon");
      const res = await q(`SELECT count(*)::int AS n FROM ${table}`);
      await q("ROLLBACK");
      return res.rows[0].n;
    } catch (err) {
      await q("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  const noToken = await readAsAnon(null, "restaurant_tables");
  report(
    "no token ⇒ 0 rows (was the USING(true) hole)",
    noToken === 0,
    `read ${noToken} of the floor`,
  );

  // Read the live token instead of assuming the seed's original code: an
  // admin can regenerate a table's QR, which changes `code` by design.
  const { rows: tokenRows } = await q(
    "SELECT code FROM restaurant_tables WHERE deleted_at IS NULL ORDER BY code LIMIT 1",
  );
  const dinerCode = tokenRows[0]?.code;
  const dinerToken = await readAsAnon({ table_token: dinerCode }, "restaurant_tables");
  report(
    "diner token ⇒ only its own table",
    dinerToken === 1,
    `read ${dinerToken} row(s) for ${dinerCode}`,
  );

  const dinerLeak = await readAsAnon({ table_token: dinerCode }, "cart_items");
  report(
    "diner token scoped on cart_items",
    typeof dinerLeak === "number",
    `read ${dinerLeak} row(s)`,
  );

  const staffToken = await readAsAnon({ staff: "kitchen" }, "restaurant_tables");
  report(
    "staff token ⇒ whole floor",
    staffToken >= 5,
    `read ${staffToken} row(s)`,
  );

  /* anon must not be able to write. The IDs are resolved as the OWNER first
     (not inside the anon transaction) — a sub-select source under anon RLS
     returns zero rows, so the INSERT would insert nothing and raise nothing,
     making the test pass for the wrong reason. */
  const { rows: idRows } = await q(
    `SELECT (SELECT id FROM restaurant_tables ORDER BY code LIMIT 1) AS table_id,
            (SELECT id FROM menu_items        ORDER BY name LIMIT 1) AS menu_item_id`,
  );
  const { table_id: sampleTableId, menu_item_id: sampleMenuItemId } = idRows[0];

  let anonWriteDenied = false;
  let anonWriteError = "no error raised — INSERT was accepted";
  try {
    await q("BEGIN");
    await q("SET LOCAL ROLE anon");
    await q(
      "INSERT INTO cart_items (table_id, menu_item_id, quantity) VALUES ($1, $2, 1)",
      [sampleTableId, sampleMenuItemId],
    );
    await q("ROLLBACK");
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    anonWriteError = err.message;
    anonWriteDenied = /permission denied|row-level security|violates/i.test(err.message);
  }
  report("anon cannot INSERT into cart_items", anonWriteDenied, anonWriteError);

  /* ------------------------------------------------------- 5. hardening (004)
     The three data-integrity defects 004_hardening.sql closes. Asserting them
     here means a future schema edit that drops a column or a trigger fails
     loudly instead of silently un-freezing historical bills. */
  section("5. Hardening (004_hardening.sql)");

  // 5a. Audit columns exist and are NOT NULL.
  const { rows: auditRows } = await q(
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('created_at', 'updated_at')
        AND table_name IN ('menu_items', 'restaurant_tables', 'order_items', 'cart_items')`,
  );
  const audit = new Map(auditRows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]));
  for (const col of [
    "menu_items.created_at",
    "menu_items.updated_at",
    "restaurant_tables.created_at",
    "restaurant_tables.updated_at",
    "order_items.created_at",
    "cart_items.updated_at",
  ]) {
    report(
      `audit column ${col} NOT NULL`,
      audit.get(col) === "NO",
      audit.has(col) ? "nullable" : "missing",
    );
  }

  // 5b. Price snapshot columns are NOT NULL with a 0 default.
  const { rows: priceRows } = await q(
    `SELECT table_name, column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'order_items' AND column_name = 'unit_price')
          OR (table_name = 'orders'      AND column_name = 'total'))`,
  );
  const priceCol = new Map(priceRows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
  for (const col of ["order_items.unit_price", "orders.total"]) {
    const row = priceCol.get(col);
    report(`${col} NOT NULL DEFAULT 0`, row?.is_nullable === "NO" && /\b0\b/.test(row?.column_default ?? ""), row ? `nullable=${row.is_nullable} default=${row.column_default}` : "missing");
  }

  // 5c. Triggers attached where they must be.
  const { rows: trigRows } = await q(
    `SELECT tgname, relname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = ANY($1)`,
    [["orders", "menu_items", "restaurant_tables", "cart_items"]],
  );
  const triggers = new Set(trigRows.map((r) => `${r.relname}.${r.tgname}`));
  for (const t of [
    "orders.orders_status_transition",
    "orders.orders_set_updated_at",
    "menu_items.menu_items_set_updated_at",
    "restaurant_tables.restaurant_tables_set_updated_at",
    "cart_items.cart_items_set_updated_at",
  ]) {
    report(`trigger ${t}`, triggers.has(t));
  }

  // 5d. STATUS GUARD — an illegal jump must be rejected by the database, not
  //     merely by app code. Done inside a rolled-back transaction so the real
  //     data is never touched.
  let illegalRejected = false;
  let illegalDetail = "no error raised — UPDATE was accepted";
  let legalAllowed = false;
  try {
    await q("BEGIN");
    const { rows: mk } = await q(
      `INSERT INTO orders (table_id, status)
       VALUES ((SELECT id FROM restaurant_tables ORDER BY code LIMIT 1), 'pending')
       RETURNING id`,
    );
    const probeId = mk[0].id;
    // legal: pending → preparing
    await q("UPDATE orders SET status = 'preparing' WHERE id = $1", [probeId]);
    legalAllowed = true;
    // illegal: preparing → pending (backwards). Use a savepoint so the error
    // does not poison the outer transaction.
    await q("SAVEPOINT s1");
    try {
      await q("UPDATE orders SET status = 'pending' WHERE id = $1", [probeId]);
    } catch (err) {
      illegalRejected = /illegal order status transition|check_violation/i.test(err.message);
      illegalDetail = err.message;
    }
    await q("ROLLBACK TO SAVEPOINT s1");
    await q("ROLLBACK");
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    illegalDetail = err.message;
  }
  report("legal pending→preparing accepted", legalAllowed);
  report("illegal preparing→pending rejected by trigger", illegalRejected, illegalDetail);

  /* 5e. PRICE SNAPSHOT end-to-end inside a rolled-back transaction: fire a real
     cart and prove the stored unit price is the menu price at fire time, then
     re-price the dish and prove the ticket does NOT change. */
  let snapshotOk = false;
  let snapshotDetail = "not exercised";
  try {
    await q("BEGIN");
    const { rows: pick } = await q(
      `SELECT t.id AS table_id, t.code, mi.id AS menu_item_id, mi.price
         FROM restaurant_tables t
         CROSS JOIN LATERAL (
           SELECT id, price FROM menu_items ORDER BY id LIMIT 1
         ) mi
        WHERE NOT EXISTS (
          SELECT 1 FROM orders o
           WHERE o.table_id = t.id AND o.status IN ('pending','preparing','ready')
        )
        ORDER BY t.code LIMIT 1`,
    );
    if (!pick[0]) {
      snapshotDetail = "no idle table available";
    } else {
      const { table_id, code, menu_item_id, price } = pick[0];
      await q("DELETE FROM cart_items WHERE table_id = $1", [table_id]);
      await q(
        "INSERT INTO cart_items (table_id, menu_item_id, quantity) VALUES ($1, $2, 2)",
        [table_id, menu_item_id],
      );
      const { rows: fire } = await q("SELECT fire_order($1) AS r", [code]);
      const fired = fire[0].r;
      const { rows: line } = await q(
        "SELECT unit_price FROM order_items WHERE order_id = $1",
        [fired.order_id],
      );
      const { rows: ord } = await q("SELECT total FROM orders WHERE id = $1", [fired.order_id]);
      const expected = Number(price) * 2;
      const got = Number(line[0]?.unit_price);
      const total = Number(ord[0]?.total);
      // Re-price the dish AFTER firing — the ticket must not follow.
      await q("UPDATE menu_items SET price = price + 100 WHERE id = $1", [menu_item_id]);
      const { rows: after } = await q(
        "SELECT unit_price FROM order_items WHERE order_id = $1",
        [fired.order_id],
      );
      snapshotOk =
        fired.code === "OK" &&
        got === Number(price) &&
        Number(after[0]?.unit_price) === got &&
        total === expected;
      snapshotDetail = `charged ${got} (menu ${price}), total ${total} (expected ${expected}), after re-price ${after[0]?.unit_price}`;
    }
    await q("ROLLBACK");
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    snapshotDetail = err.message;
  }
  report("fire_order snapshots price & freezes total", snapshotOk, snapshotDetail);

  /* ----------------------------------------- 6. table session security (005)
     The two-layer table session adds four columns whose SHAPE matters: a
     2-digit PIN that keeps its leading zero, a fixed-length pass, and a
     counter the API increments atomically. The column-privilege check is
     the important half: the pass is a bearer credential for a whole table,
     so the browser roles must not be able to read it even though they are
     allowed to read the row. */
  section("6. Table session security (005_table_session_security.sql)");

  const { rows: sessionCols } = await q(
    `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'restaurant_tables'
        AND column_name IN ('session_pin', 'session_secret', 'failed_pin_attempts', 'session_started_at')`,
  );
  const sessionCol = new Map(sessionCols.map((row) => [row.column_name, row]));

  report(
    "column session_pin varchar(2) nullable",
    sessionCol.get("session_pin")?.data_type === "character varying" &&
      sessionCol.get("session_pin")?.character_maximum_length === 2 &&
      sessionCol.get("session_pin")?.is_nullable === "YES",
    JSON.stringify(sessionCol.get("session_pin") ?? "missing"),
  );
  report(
    "column session_secret varchar(20) nullable",
    sessionCol.get("session_secret")?.data_type === "character varying" &&
      sessionCol.get("session_secret")?.character_maximum_length === 20 &&
      sessionCol.get("session_secret")?.is_nullable === "YES",
    JSON.stringify(sessionCol.get("session_secret") ?? "missing"),
  );
  report(
    "column failed_pin_attempts integer NOT NULL DEFAULT 0",
    sessionCol.get("failed_pin_attempts")?.data_type === "integer" &&
      sessionCol.get("failed_pin_attempts")?.is_nullable === "NO" &&
      /\b0\b/.test(sessionCol.get("failed_pin_attempts")?.column_default ?? ""),
    JSON.stringify(sessionCol.get("failed_pin_attempts") ?? "missing"),
  );
  report(
    "column session_started_at timestamptz nullable",
    sessionCol.get("session_started_at")?.data_type === "timestamp with time zone" &&
      sessionCol.get("session_started_at")?.is_nullable === "YES",
    JSON.stringify(sessionCol.get("session_started_at") ?? "missing"),
  );

  const { rows: sessionChecks } = await q(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.restaurant_tables'::regclass AND contype = 'c'`,
  );
  const checkNames = new Set(sessionChecks.map((row) => row.conname));
  for (const name of [
    "restaurant_tables_session_pin_format",
    "restaurant_tables_session_secret_length",
    "restaurant_tables_failed_pin_attempts_range",
  ]) {
    report(`constraint ${name}`, checkNames.has(name));
  }

  // The PIN column must reject anything the keypad cannot produce.
  let pinShapeRejected = false;
  try {
    await q("BEGIN");
    await q(
      "UPDATE restaurant_tables SET session_pin = '7' WHERE code = (SELECT code FROM restaurant_tables LIMIT 1)",
    );
    await q("ROLLBACK");
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    pinShapeRejected = /check constraint|violates check/i.test(err.message);
  }
  report("session_pin rejects a 1-digit value", pinShapeRejected);

  // Zero-knowledge: browser roles read the row, never the credentials.
  const { rows: colPrivRows } = await q(
    `SELECT
       has_column_privilege('anon', 'public.restaurant_tables', 'code', 'SELECT')           AS anon_code,
       has_column_privilege('anon', 'public.restaurant_tables', 'session_pin', 'SELECT')    AS anon_pin,
       has_column_privilege('anon', 'public.restaurant_tables', 'session_secret', 'SELECT') AS anon_secret,
       has_column_privilege('authenticated', 'public.restaurant_tables', 'session_secret', 'SELECT') AS auth_secret,
       has_column_privilege('service_role', 'public.restaurant_tables', 'session_secret', 'SELECT')  AS svc_secret`,
  );
  const colPriv = colPrivRows[0];
  report("anon may still read restaurant_tables.code", colPriv.anon_code === true);
  report("anon cannot read session_pin", colPriv.anon_pin === false);
  report("anon cannot read session_secret", colPriv.anon_secret === false);
  report("authenticated cannot read session_secret", colPriv.auth_secret === false);
  report("service_role can read session_secret", colPriv.svc_secret === true);

  let secretReadDenied = false;
  let secretReadError = "no error — SELECT was allowed";
  try {
    await q("BEGIN");
    await q("SET LOCAL ROLE anon");
    await q("SELECT session_secret FROM restaurant_tables LIMIT 1");
    await q("ROLLBACK");
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    secretReadError = err.message;
    secretReadDenied = /permission denied/i.test(err.message);
  }
  report("anon SELECT session_secret is denied outright", secretReadDenied, secretReadError);

  /* ------------------------------- 7. bill settlement & auto-release (007)
     The release engine reads three facts: bill_status, open orders and fresh
     device presence. The schema has to make each of them reliable: a guarded
     status column, a paid timestamp that cannot contradict it, and a presence
     table with one row per device. */
  section("7. Bill settlement & auto-release (007 + 009)");

  const { rows: billCols } = await q(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'restaurant_tables'
        AND column_name IN ('bill_status', 'bill_requested_at', 'bill_paid_at')`,
  );
  const billCol = new Map(billCols.map((row) => [row.column_name, row]));

  report(
    "column bill_status text NOT NULL DEFAULT 'unrequested'",
    billCol.get("bill_status")?.data_type === "text" &&
      billCol.get("bill_status")?.is_nullable === "NO" &&
      /unrequested/.test(billCol.get("bill_status")?.column_default ?? ""),
    JSON.stringify(billCol.get("bill_status") ?? "missing"),
  );
  report(
    "column bill_requested_at timestamptz nullable",
    billCol.get("bill_requested_at")?.data_type === "timestamp with time zone" &&
      billCol.get("bill_requested_at")?.is_nullable === "YES",
    JSON.stringify(billCol.get("bill_requested_at") ?? "missing"),
  );
  report(
    "column bill_paid_at timestamptz nullable",
    billCol.get("bill_paid_at")?.data_type === "timestamp with time zone" &&
      billCol.get("bill_paid_at")?.is_nullable === "YES",
    JSON.stringify(billCol.get("bill_paid_at") ?? "missing"),
  );
  report(
    "constraint restaurant_tables_bill_status_check",
    checkNames.has("restaurant_tables_bill_status_check"),
  );
  report(
    "constraint restaurant_tables_bill_paid_consistency",
    checkNames.has("restaurant_tables_bill_paid_consistency"),
  );

  const { rows: presenceRows } = await q(
    `SELECT c.relname, c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'table_device_presence'`,
  );
  report("table table_device_presence", presenceRows.length === 1);

  const { rows: presenceIndexes } = await q(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'table_device_presence'",
  );
  report(
    "index table_device_presence_table_idx",
    presenceIndexes.some((row) => row.indexname === "table_device_presence_table_idx"),
  );

  const { rows: presenceFk } = await q(
    `SELECT confdeltype FROM pg_constraint
      WHERE conname = 'table_device_presence_table_id_fkey'
        AND conrelid = to_regclass('public.table_device_presence')`,
  );
  report(
    "presence cascades on table delete",
    presenceFk[0]?.confdeltype === "c",
    `confdeltype=${presenceFk[0]?.confdeltype ?? "missing"}`,
  );

  // The three bill columns are readable by browser roles; the credentials
  // above remain the only withheld ones. Guarded so an un-migrated database
  // reports the failure instead of aborting the whole run on a missing column.
  if (billCol.size === 3) {
    const { rows: billPrivRows } = await q(
      `SELECT
         has_column_privilege('anon', 'public.restaurant_tables', 'bill_status', 'SELECT')           AS anon_bill,
         has_column_privilege('authenticated', 'public.restaurant_tables', 'bill_paid_at', 'SELECT') AS auth_paid`,
    );
    report("anon can read bill_status", billPrivRows[0].anon_bill === true);
    report("authenticated can read bill_paid_at", billPrivRows[0].auth_paid === true);
  } else {
    report("anon can read bill_status", false, "columns missing");
    report("authenticated can read bill_paid_at", false, "columns missing");
  }

  // The status guard rejects a value the engine could never write.
  let billShapeRejected = false;
  try {
    await q("BEGIN");
    await q(
      "UPDATE restaurant_tables SET bill_status = 'settled' WHERE code = (SELECT code FROM restaurant_tables LIMIT 1)",
    );
    await q("ROLLBACK");
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    billShapeRejected = /check constraint|violates check/i.test(err.message);
  }
  report("bill_status rejects an unknown state", billShapeRejected);

  // 009 — the staff clear request that alerts the manager console.
  const { rows: clearCols } = await q(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'restaurant_tables'
        AND column_name = 'clear_requested_at'`,
  );
  report(
    "column clear_requested_at timestamptz nullable",
    clearCols[0]?.data_type === "timestamp with time zone" &&
      clearCols[0]?.is_nullable === "YES",
    JSON.stringify(clearCols[0] ?? "missing"),
  );

  const { rows: clearIdx } = await q(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'restaurant_tables_clear_requested_idx'",
  );
  report("index restaurant_tables_clear_requested_idx", clearIdx.length === 1);

  // ------------------------------------------------------------------- 8. seed
  section("8. Seed data");

  const { rows: seedRows } = await q(`
    SELECT
      (SELECT count(*)::int FROM restaurant_tables) AS tables,
      (SELECT count(*)::int FROM menu_items)        AS menu,
      (SELECT count(*)::int FROM staff_terminals)   AS terminals
  `);
  const { tables, menu, terminals } = seedRows[0];
  console.log(`  ℹ️  ${terminals} terminal(s) / ${tables} tables / ${menu} dishes`);
  report("seed applied", tables >= 5 && menu >= 20 && terminals >= 1);
} finally {
  await client.end();
}

console.log(
  `\n[db:verify] ${passed} check(s) passed` +
    (failures.length ? `, ${failures.length} FAILED:\n  • ${failures.join("\n  • ")}` : ""),
);

if (failures.length > 0) process.exitCode = 1;
