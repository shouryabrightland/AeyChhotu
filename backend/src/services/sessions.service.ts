import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { signReadToken } from "../lib/jwt.js";
import { iso } from "../lib/util.js";

/* Module 1 — Session & Access Control.
 *
 * Two-layer table security (sql/005_table_session_security.sql):
 *
 *   Layer 1 — the PIN. A 2-digit code ('00'–'99') minted when a table's
 *             session starts. Every other guest types it once on a custom
 *             keypad; three wrong PINs lock the TABLE (not the device), so
 *             a guesser cannot keep trying forever.
 *   Layer 2 — the pass. A 20-character secret that only devices which
 *             already joined ever hold. It is what the QR pass carries and
 *             what a refresh presents to reconnect without retyping
 *             anything. It is NOT a shortcut past layer 1: join-pass only
 *             succeeds once the table is PIN-locked (3 strikes), where it
 *             is the unlock. A normal tablemate must type the 2-digit PIN.
 *
 * Zero-knowledge: neither value is ever returned by a staff endpoint or
 * rendered to staff. The DB additionally denies both columns to the
 * browser roles (005), so this is enforced twice.
 *
 * The first scan of an EMPTY table claims the session: it mints the
 * credentials and hands them to that device. Every later scan of an ACTIVE
 * table gets `{ status: 'locked' }` and must join with the PIN (or, once
 * the table is flagged, a tablemate's pass) — which is what stops a
 * passer-by who photographed the table QR from reading or editing someone
 * else's cart.
 */

export interface TableRecord {
  id: string;
  code: string;
  name: string;
  status: string;
}

/** Wrong PINs tolerated before the table is flagged. Table-wide. */
export const MAX_PIN_ATTEMPTS = 3;

/** The pass length the DB check, the QR payload and join-pass all assume. */
export const SESSION_SECRET_LENGTH = 20;

/* Base62: 62^20 ≈ 118 bits of entropy, and every character survives a QR
   round trip, a URL query string and a manual read-aloud. */
const SECRET_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type BillStatus = "unrequested" | "requested" | "paid";

export interface SessionRow {
  id: string;
  code: string;
  name: string;
  status: string;
  session_pin: string | null;
  session_secret: string | null;
  failed_pin_attempts: number;
  session_started_at: Date | null;
  bill_status: BillStatus;
  /** Last time the table was handed to its next party (sql/011). */
  last_cleared_at: Date | null;
}

const SESSION_COLUMNS =
  "id, code, name, status, session_pin, session_secret, failed_pin_attempts, session_started_at, bill_status, last_cleared_at";

/* The identity a device registers at the table (sql/011 table_members).

   `name` is required by the API schemas — every session entry point carries
   the name the gate collected. `user_id` stays optional so a payload without
   a device id still joins; it just does not get a roster row. */
export interface TableMemberInput {
  user_id?: string;
  name: string;
}

/** Extra context every session entry point accepts. */
export interface SessionEntryOptions {
  /** When the CLIENT opened the page. Older than last_cleared_at ⇒ stale. */
  scan_time?: string;
  member?: TableMemberInput;
}

/** A random '00'–'99'. Leading zeros matter, so this stays a string. */
export function generateSessionPin(): string {
  return String(randomInt(0, 100)).padStart(2, "0");
}

export function generateSessionSecret(length: number = SESSION_SECRET_LENGTH): string {
  let secret = "";
  for (let i = 0; i < length; i += 1) {
    // charAt (not [i]) because noUncheckedIndexedAccess types indexing as
    // `string | undefined`.
    secret += SECRET_ALPHABET.charAt(randomInt(0, SECRET_ALPHABET.length));
  }
  return secret;
}

/** Resolves a table_token (restaurant_tables.code) or throws 404.
    An archived table (006 edit: deleted_at) is not merely hidden — its code
    must stop being a capability, so it is treated as if it never existed. */
export async function requireTable(tableToken: string): Promise<TableRecord> {
  const res = await pool.query<TableRecord>(
    "SELECT id, code, name, status FROM restaurant_tables WHERE code = $1 AND deleted_at IS NULL",
    [tableToken],
  );
  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
  }
  return row;
}

/* The read token the diner's browser hands to Supabase. Its `table_token`
   claim is what the RLS policies in sql/001_init.sql match on; it is issued
   only after the session is GRANTED, never on the `locked` reply, and it
   carries READ scope only — every write still goes through this backend. */

const READ_TOKEN_TTL_SECONDS = 12 * 60 * 60; // one long dining session

function issueTableReadToken(table: { id: string; code: string }): string | null {
  if (!env.supabaseJwtSecret) return null;
  const now = Math.floor(Date.now() / 1000);
  return signReadToken(
    {
      sub: table.id,
      role: "authenticated",
      table_token: table.code,
      iat: now,
      exp: now + READ_TOKEN_TTL_SECONDS,
    },
    env.supabaseJwtSecret,
  );
}

/** The credentials a device holds once it belongs to the table. */
export interface GrantedSession {
  table_id: string;
  code: string;
  name: string;
  status: "active";
  session_pin: string;
  session_secret: string;
  session_started_at: string | null;
  bill_status: BillStatus;
  realtime_token: string | null;
  /* The Chhotu assistant's Gemini key, released with the rest of the
     credentials. DELIBERATE PRODUCT DECISION: the key is not in the JS
     bundle, so an anonymous visitor to the site never gets it; it is only
     handed to a device that has PROVEN it is at a table (initialize on an
     empty table, join-pin, join-pass, reconnect). Anyone sitting at the
     table can still read it — so the key must be a restricted, quota-capped
     one. Null when the deployment has no GEMINI_API_KEY, which simply hides
     the assistant. */
  gemini_api_key: string | null;
}

/** The reply to a scan of a table that already has a live session. */
export interface LockedSession {
  table_id: string;
  code: string;
  name: string;
  status: "locked";
  pin_locked: boolean;
  attempts_remaining: number;
  realtime_token: null;
}

export type InitializeResult = GrantedSession | LockedSession;

function grantedSession(row: SessionRow): GrantedSession {
  if (!row.session_pin || !row.session_secret) {
    // A live row without credentials is a broken invariant, not an invite.
    throw new AppError(
      403,
      "SESSION_ENDED",
      "This table session has ended. Scan the table's QR code to start a new one.",
    );
  }

  return {
    table_id: row.id,
    code: row.code,
    name: row.name,
    status: "active",
    session_pin: row.session_pin,
    session_secret: row.session_secret,
    session_started_at: row.session_started_at ? iso(row.session_started_at) : null,
    bill_status: row.bill_status,
    realtime_token: issueTableReadToken(row),
    gemini_api_key: env.geminiApiKey,
  };
}

function lockedSession(row: SessionRow): LockedSession {
  return {
    table_id: row.id,
    code: row.code,
    name: row.name,
    status: "locked",
    pin_locked: row.failed_pin_attempts >= MAX_PIN_ATTEMPTS,
    attempts_remaining: Math.max(0, MAX_PIN_ATTEMPTS - row.failed_pin_attempts),
    realtime_token: null,
  };
}

const STALE_SESSION_MESSAGE =
  "This table was cleared after your page was opened. Scan the table's QR code again.";

/* Rejects a page that was opened BEFORE the table was cleared. A phone can
   sit on a cached menu for hours (app reopen, bookmark, bfcache); without
   this guard its `initialize` would either claim the next party's table or
   hand a stranger the previous session's credentials. `scan_time` is the
   moment the CLIENT opened the page, which is exactly the fact we need.

   The comparison tolerates SCAN_TIME_SKEW_TOLERANCE_MS of clock skew. Phones
   are not guaranteed to be NTP-synced: a guest whose clock runs two minutes
   behind would otherwise be refused forever after a clear, because their
   brand-new page always looks "older" than the server's timestamp. Two
   minutes still catches the real case (a page cached across a seating), and
   it cannot be used to resurrect a session: the secret is rotated on clear,
   so an old page has nothing valid to present either way. */
export const SCAN_TIME_SKEW_TOLERANCE_MS = 2 * 60_000;

function assertFreshSession(table: SessionRow, scanTime: string | undefined): void {
  if (!scanTime || !table.last_cleared_at) return;

  const scannedAt = Date.parse(scanTime);
  if (Number.isNaN(scannedAt)) return; // validated by Zod; never trust blindly

  if (scannedAt < table.last_cleared_at.getTime() - SCAN_TIME_SKEW_TOLERANCE_MS) {
    throw new AppError(409, "STALE_SESSION", STALE_SESSION_MESSAGE, {
      table_id: table.id,
      cleared_at: iso(table.last_cleared_at),
    });
  }
}

/* Registers (or refreshes) one person at the table. Called on every path
   that GRANTS a session, so the roster always matches who actually joined.
   ON CONFLICT makes a reconnect an update, never a duplicate member. */
const MEMBER_UPSERT_SQL = `INSERT INTO table_members (table_id, user_id, name)
      VALUES ($1, $2, $3)
 ON CONFLICT (table_id, user_id)
   DO UPDATE SET name = EXCLUDED.name`;

async function upsertTableMember(
  client: PoolClient,
  tableId: string,
  member: TableMemberInput | undefined,
): Promise<void> {
  const userId = member?.user_id?.trim();
  if (!userId || !member) return;

  await client.query(MEMBER_UPSERT_SQL, [tableId, userId, member.name]);
}

/* E1 — POST /api/v1/sessions/initialize.
   The first scan of an EMPTY table starts the session and returns the
   credentials; the row is locked (SELECT … FOR UPDATE) for the whole
   read-decide-write, so two guests scanning the same code at the same
   moment cannot mint two PINs and leave one phone holding a dead secret.

   An ACTIVE table releases nothing: no cart lines, no orders, no tokens —
   the caller must join with the PIN or the pass.

   A `scan_time` older than `last_cleared_at` is refused with STALE_SESSION
   before anything is written, so a long-cached page can never take the
   table away from the party sitting at it. */
export async function initializeSession(
  tableToken: string,
  options: SessionEntryOptions = {},
): Promise<InitializeResult> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const found = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM restaurant_tables
        WHERE code = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableToken],
    );
    const table = found.rows[0];
    if (!table) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }

    assertFreshSession(table, options.scan_time);

    if (table.status === "active") {
      // A live table stays the property of the party already seated: no
      // credentials, no roster entry, no read token.
      await client.query("COMMIT");
      committed = true;
      return lockedSession(table);
    }

    const pin = generateSessionPin();
    const secret = generateSessionSecret();

    const updated = await client.query<SessionRow>(
      `UPDATE restaurant_tables
          SET status              = 'active',
              session_pin         = $2,
              session_secret      = $3,
              failed_pin_attempts = 0,
              session_started_at  = now()
        WHERE id = $1
        RETURNING ${SESSION_COLUMNS}`,
      [table.id, pin, secret],
    );

    const row = updated.rows[0];
    if (!row) {
      // Vanishingly unlikely (the row is locked), but never hand out a
      // credential that was not stored.
      throw new AppError(500, "INTERNAL_ERROR", "The table session could not be started.");
    }

    // The guest who claimed the table is its first member.
    await upsertTableMember(client, row.id, options.member);

    await client.query("COMMIT");
    committed = true;

    return grantedSession(row);
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

const SESSION_ENDED_MESSAGE =
  "This table session has ended. Scan the table's QR code to start a new one.";

const PIN_LOCKED_MESSAGE =
  "Table PIN locked after 3 failed attempts. Scan a tablemate's QR pass to unlock and join.";

/* E1b — POST /api/v1/sessions/join-pin.
   Each join is ONE transaction that locks the table row, so the counter can
   never lose an increment: two phones guessing at once serialize, and the
   `failed_pin_attempts < 3` guard is re-checked against the locked row.

   The transaction is also what makes the roster entry and the credential
   reset atomic — a guest is either IN (counter cleared + member registered)
   or still out, never half-joined. A scan that predates the table's last
   clear is refused before the counter moves at all. */
export async function joinWithPin(input: {
  table_token: string;
  pin: string;
} & SessionEntryOptions): Promise<GrantedSession> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const found = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM restaurant_tables
        WHERE code = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [input.table_token],
    );
    const table = found.rows[0];
    if (!table) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }

    assertFreshSession(table, input.scan_time);

    if (table.status !== "active" || !table.session_pin) {
      throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
    }

    // Locked before this attempt even counted.
    if (table.failed_pin_attempts >= MAX_PIN_ATTEMPTS) {
      throw new AppError(423, "TABLE_PIN_LOCKED", PIN_LOCKED_MESSAGE, {
        attempts_remaining: 0,
        failed_attempts: table.failed_pin_attempts,
        locked: true,
      });
    }

    if (table.session_pin !== input.pin) {
      const failed = await client.query<{ failed_pin_attempts: number }>(
        `UPDATE restaurant_tables
            SET failed_pin_attempts = failed_pin_attempts + 1
          WHERE id = $1
          RETURNING failed_pin_attempts`,
        [table.id],
      );
      const attempts = failed.rows[0]?.failed_pin_attempts ?? table.failed_pin_attempts + 1;

      // A wrong PIN is a real state change (the counter), so it commits
      // before the error is raised.
      await client.query("COMMIT");
      committed = true;

      // The 3rd wrong PIN is the one that locks the table: the diner is told
      // immediately, and the keypad is replaced by the scan-a-pass gate.
      if (attempts >= MAX_PIN_ATTEMPTS) {
        throw new AppError(423, "TABLE_PIN_LOCKED", PIN_LOCKED_MESSAGE, {
          attempts_remaining: 0,
          failed_attempts: attempts,
          locked: true,
        });
      }

      const remaining = MAX_PIN_ATTEMPTS - attempts;
      throw new AppError(
        401,
        "INVALID_SESSION_PIN",
        `That PIN is not right. ${remaining} ${remaining === 1 ? "try" : "tries"} left before the table locks.`,
        { attempts_remaining: remaining, failed_attempts: attempts, locked: false },
      );
    }

    const granted = await client.query<SessionRow>(
      `UPDATE restaurant_tables
          SET failed_pin_attempts = 0
        WHERE id = $1
        RETURNING ${SESSION_COLUMNS}`,
      [table.id],
    );

    const row = granted.rows[0];
    if (!row) {
      throw new AppError(500, "INTERNAL_ERROR", "The table session could not be joined.");
    }

    await upsertTableMember(client, row.id, input.member);

    await client.query("COMMIT");
    committed = true;
    return grantedSession(row);
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

/* E1c — POST /api/v1/sessions/join-pass.
   The QR UNLOCK: a 20-character secret from a tablemate's screen. It is
   accepted only when the table is PIN-locked (3 wrongs) — on a table whose
   keypad still works it is refused with 403 PASS_REQUIRES_PIN, because a
   photographed QR must not replace the 2-digit code. A correct pass clears
   the failed-attempt counter, which is what unflags the table. One
   transaction covers the reset, the roster entry and the stale-page check. */
export async function joinWithPass(input: {
  table_token: string;
  secret: string;
} & SessionEntryOptions): Promise<GrantedSession> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const found = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM restaurant_tables
        WHERE code = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [input.table_token],
    );
    const table = found.rows[0];
    if (!table) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
    }

    assertFreshSession(table, input.scan_time);

    if (table.status !== "active" || !table.session_secret) {
      throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
    }

    /* The pass is the UNLOCK, not a shortcut past the PIN. While the keypad
       still works, joining with a photographed pass QR would let anyone skip
       layer 1 entirely — so the only way in is the 2-digit code. Checked
       BEFORE the secret comparison, so a refused pass cannot even be used to
       probe whether a guessed secret is right. */
    if (table.failed_pin_attempts < MAX_PIN_ATTEMPTS) {
      const remaining = MAX_PIN_ATTEMPTS - table.failed_pin_attempts;
      throw new AppError(
        403,
        "PASS_REQUIRES_PIN",
        `Enter the two-digit PIN on the table card to join. A tablemate's pass only unlocks a table after ${MAX_PIN_ATTEMPTS} wrong PINs.`,
        { attempts_remaining: remaining, failed_attempts: table.failed_pin_attempts },
      );
    }

    if (table.session_secret !== input.secret) {
      throw new AppError(
        401,
        "INVALID_SESSION_SECRET",
        "That table pass is not valid for this table. Ask a tablemate to show their pass again.",
      );
    }

    const granted = await client.query<SessionRow>(
      `UPDATE restaurant_tables
          SET failed_pin_attempts = 0
        WHERE id = $1
        RETURNING ${SESSION_COLUMNS}`,
      [table.id],
    );

    const row = granted.rows[0];
    if (!row) {
      throw new AppError(500, "INTERNAL_ERROR", "The table session could not be joined.");
    }

    await upsertTableMember(client, row.id, input.member);

    await client.query("COMMIT");
    committed = true;
    return grantedSession(row);
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

/* E1d — POST /api/v1/sessions/reconnect.
   A refresh, not a re-entry: the device already holds the secret, so it
   never sees the keypad again. If the table was settled (or the secret was
   replaced by a newer session) the answer is 403 SESSION_ENDED and the app
   clears itself rather than showing a stale menu. */
export async function reconnectSession(input: {
  table_token: string;
  secret: string;
} & Pick<SessionEntryOptions, "scan_time" | "member">): Promise<GrantedSession> {
  const table = await requireSessionRow(input.table_token);

  assertFreshSession(table, input.scan_time);

  if (table.status !== "active" || !table.session_secret) {
    throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
  }
  if (table.session_secret !== input.secret) {
    // Deliberately the SAME code as a settled table: a stale secret must not
    // be able to tell an attacker "close, but the session is still live".
    throw new AppError(403, "SESSION_ENDED", SESSION_ENDED_MESSAGE);
  }

  /* A refresh is also the moment a returning guest can fix their name: the
     same upsert refreshes table_members, so the roster and the pass sheet
     stop showing an older spelling. Best-effort by design — a roster write
     must never turn a valid reconnect into a failure. */
  const userId = input.member?.user_id?.trim();
  if (userId && input.member?.name) {
    await pool
      .query(MEMBER_UPSERT_SQL, [table.id, userId, input.member.name])
      .catch(() => undefined);
  }

  return grantedSession(table);
}

async function requireSessionRow(tableToken: string): Promise<SessionRow> {
  const res = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM restaurant_tables
      WHERE code = $1 AND deleted_at IS NULL`,
    [tableToken],
  );
  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
  }
  return row;
}

export type ActiveCheckResult =
  | { has_active_order: true; order_id: string; status: string; message: string }
  | { has_active_order: false; message: string };

/* ---------------------------------------------------------------------
   Bill settlement & automatic table release (sql/007)
   ---------------------------------------------------------------------
   A table is released for the next party only when ALL three independent
   facts agree:

     1. the bill is PAID,
     2. no ticket is still pending / preparing / ready, and
     3. no diner device has sent a heartbeat in the last 45 seconds.

   Condition 3 is what stops a settle from clearing the table while a guest
   is still sitting at it reading the receipt. The 45s window sits just
   inside the frontend's 15s heartbeat, so one missed beat is tolerated and
   two are not.

   All three are read inside ONE transaction that holds a FOR UPDATE lock on
   the table row, so a settle, a new fire and a last-device disconnect that
   land together cannot each decide the table is releasable. */

export const RELEASE_PRESENCE_WINDOW_SECONDS = 45;

export interface AutoReleaseResult {
  released: boolean;
}

interface ReleaseCandidate {
  id: string;
  bill_status: BillStatus;
  active_orders: number;
  active_devices: number;
}

export async function checkAndAutoReleaseTable(tableId: string): Promise<AutoReleaseResult> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const locked = await client.query<{ id: string }>(
      `SELECT id
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableId],
    );
    if (!locked.rows[0]) {
      // Archived or already gone: nothing to release.
      await client.query("COMMIT");
      committed = true;
      return { released: false };
    }

    const candidate = await client.query<ReleaseCandidate>(
      `SELECT t.id,
              t.bill_status,
              (SELECT count(*)::int
                 FROM orders o
                WHERE o.table_id = t.id
                  AND o.status IN ('pending', 'preparing', 'ready')) AS active_orders,
              (SELECT count(*)::int
                 FROM table_device_presence p
                WHERE p.table_id = t.id
                  AND p.last_seen > now() - ($2 || ' seconds')::interval) AS active_devices
         FROM restaurant_tables t
        WHERE t.id = $1`,
      [tableId, RELEASE_PRESENCE_WINDOW_SECONDS],
    );

    const row = candidate.rows[0];
    if (!row || row.bill_status !== "paid" || row.active_orders > 0 || row.active_devices > 0) {
      await client.query("COMMIT");
      committed = true;
      return { released: false };
    }

    await clearTableRows(client, tableId);

    await client.query("COMMIT");
    committed = true;
    return { released: true };
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

/* Shared cleanup for every path that hands a table to its next party:
   auto-release, a staff clear, and an admin override.

   DECISION (docs/14 #21): the ORDERS die with the seating. A table belongs to
   one party at a time, and a new party must never inherit the previous one's
   running total, tracker or "split by person" list. Sales are not lost: the
   moment a ticket reaches `served` the database rolls it up into `sales_day`
   / `sales_rollup` (sql/012), which is what the admin analytics reads. Open
   tickets are blocked from reaching this function by the callers, so the rows
   removed here are already served/denied.

   `last_cleared_at` records WHEN the hand-over happened — that timestamp is
   what makes a long-cached phone page answer STALE_SESSION instead of seating
   a stranger. */
async function clearTableRows(client: PoolClient, tableId: string): Promise<void> {
  await client.query(
    `UPDATE restaurant_tables
        SET status              = 'empty',
            session_pin         = NULL,
            session_secret      = NULL,
            failed_pin_attempts = 0,
            session_started_at  = NULL,
            bill_status         = 'unrequested',
            bill_requested_at   = NULL,
            bill_paid_at        = NULL,
            clear_requested_at  = NULL,
            last_cleared_at     = now()
      WHERE id = $1`,
    [tableId],
  );

  await client.query("DELETE FROM cart_items WHERE table_id = $1", [tableId]);
  await client.query("DELETE FROM table_members WHERE table_id = $1", [tableId]);
  await client.query("DELETE FROM table_device_presence WHERE table_id = $1", [tableId]);
  // order_items cascade with their order. Rolled up first (sql/012 trigger).
  await client.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
}

export type ClearTableOutcome = "cleared" | "not_found" | "active_orders" | "unpaid";

export interface ClearTableResult {
  outcome: ClearTableOutcome;
  bill_status: BillStatus | null;
  active_orders: number;
  order_count: number;
}

/* Explicit clear, used by the floor (staff) and the admin console.

   Rules, in order:
     1. an open ticket always blocks — never yank a table out from under the
        kitchen (a flagged table has none, but the endpoint is reachable);
     2. money owed blocks a STAFF clear: bill_status <> 'paid' with at least
        one order on record. A table with no orders has nothing to charge;
     3. `allowUnpaid` is the manager override — only the admin route sets it.

   Works inside one transaction with a row lock, so a clear cannot race a
   fire or a settle. */
export async function clearTableSession(
  tableId: string,
  options: { allowUnpaid: boolean; cancelActiveOrders?: boolean },
): Promise<ClearTableResult> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const locked = await client.query<{
      id: string;
      bill_status: BillStatus;
      session_started_at: Date | null;
    }>(
      `SELECT id, bill_status, session_started_at
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableId],
    );
    const table = locked.rows[0];
    if (!table) {
      await client.query("COMMIT");
      committed = true;
      return { outcome: "not_found", bill_status: null, active_orders: 0, order_count: 0 };
    }

    /* Money owed is scoped to the CURRENT session. Orders are never deleted
       (history is immutable), so counting every order on the table would
       make one past bill block staff clears forever. Only tickets fired
       after this session started can belong to this party.

       A DENIED ticket is excluded on purpose: no food was cooked or run, so
       it is not a debt. Without this filter one out-of-stock round would
       mark the table permanently unpaid and only a manager could clear it. */
    const counts = await client.query<{
      order_count: number;
      session_order_count: number;
      active_orders: number;
    }>(
      `SELECT count(*)::int AS order_count,
              count(*) FILTER (
                WHERE created_at >= $2
                  AND status <> 'denied'
              )::int AS session_order_count,
              count(*) FILTER (
                WHERE status IN ('pending', 'preparing', 'ready')
              )::int AS active_orders
         FROM orders
        WHERE table_id = $1`,
      [tableId, table.session_started_at],
    );
    const orderCount = counts.rows[0]?.order_count ?? 0;
    const sessionOrderCount = counts.rows[0]?.session_order_count ?? 0;
    const activeOrders = counts.rows[0]?.active_orders ?? 0;

    /* A staff "clear anyway" cancels the open tickets instead of refusing.
       They are DENIED, never served: nobody earned that revenue, and the guest
       sees why the round stopped. The unpaid check below still uses the count
       captured before this update, so cancelling a ticket can never erase a
       debt that only a manager may forgive. */
    if (activeOrders > 0 && options.cancelActiveOrders) {
      await client.query(
        `UPDATE orders
            SET status        = 'denied',
                denial_reason = COALESCE(NULLIF(denial_reason, ''), 'Table cleared by staff'),
                updated_at    = now()
          WHERE table_id = $1
            AND status IN ('pending', 'preparing', 'ready')`,
        [tableId],
      );
    }

    if (activeOrders > 0 && !options.cancelActiveOrders) {
      await client.query("COMMIT");
      committed = true;
      return {
        outcome: "active_orders",
        bill_status: table.bill_status,
        active_orders: activeOrders,
        order_count: orderCount,
      };
    }

    const unpaid = table.bill_status !== "paid" && sessionOrderCount > 0;
    if (unpaid && !options.allowUnpaid) {
      await client.query("COMMIT");
      committed = true;
      return {
        outcome: "unpaid",
        bill_status: table.bill_status,
        active_orders: 0,
        order_count: orderCount,
      };
    }

    await clearTableRows(client, tableId);
    await client.query("COMMIT");
    committed = true;

    return {
      outcome: "cleared",
      bill_status: table.bill_status,
      active_orders: 0,
      order_count: orderCount,
    };
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface BillRequestResult {
  table_id: string;
  bill_status: BillStatus;
  bill_requested_at: string | null;
}

/* POST /api/v1/sessions/:table_token/bill-request.
   Idempotent: asking twice keeps the first request timestamp (a second tap
   must not restart the server's clock), and a settled table is never
   downgraded from 'paid' back to 'requested'. */
export async function requestTableBill(tableToken: string): Promise<BillRequestResult> {
  const table = await requireTable(tableToken);

  const updated = await pool.query<{
    id: string;
    bill_status: BillStatus;
    bill_requested_at: Date | null;
  }>(
    `UPDATE restaurant_tables
        SET bill_status       = 'requested',
            bill_requested_at = now()
      WHERE id = $1
        AND deleted_at IS NULL
        AND bill_status = 'unrequested'
      RETURNING id, bill_status, bill_requested_at`,
    [table.id],
  );

  const row = updated.rows[0];
  if (row) {
    return {
      table_id: row.id,
      bill_status: row.bill_status,
      bill_requested_at: row.bill_requested_at ? iso(row.bill_requested_at) : null,
    };
  }

  const existing = await pool.query<{
    id: string;
    bill_status: BillStatus;
    bill_requested_at: Date | null;
  }>(
    `SELECT id, bill_status, bill_requested_at
       FROM restaurant_tables
      WHERE id = $1 AND deleted_at IS NULL`,
    [table.id],
  );

  const current = existing.rows[0];
  if (!current) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
  }

  return {
    table_id: current.id,
    bill_status: current.bill_status,
    bill_requested_at: current.bill_requested_at ? iso(current.bill_requested_at) : null,
  };
}

/* GET /api/v1/sessions/:table_token — the diner's own table state.

   Why this exists (docs/14 #3 and #5): without Supabase a diner's phone had
   no way to learn that the floor settled the bill or cleared the table, and
   the bill itself lived in a browser-local store. This is the REST read the
   diner's poll uses, so `bill_status` and `status` are SERVER truth on every
   device. It is scoped by the table token, exactly like bill-request, and
   returns no credentials. */
export interface TableStateResult {
  table_id: string;
  code: string;
  name: string;
  status: "active" | "empty";
  bill_status: BillStatus;
  bill_requested_at: string | null;
  bill_paid_at: string | null;
  session_started_at: string | null;
  /** Devices that beat inside the release window. */
  active_devices: number;
  /** pending / preparing / ready tickets on this seating. */
  active_orders: number;
}

export async function getTableState(tableToken: string): Promise<TableStateResult> {
  const res = await pool.query<{
    id: string;
    code: string;
    name: string;
    status: string;
    bill_status: BillStatus;
    bill_requested_at: Date | null;
    bill_paid_at: Date | null;
    session_started_at: Date | null;
    active_devices: number;
    active_orders: number;
  }>(
    `SELECT t.id,
            t.code,
            t.name,
            t.status,
            t.bill_status,
            t.bill_requested_at,
            t.bill_paid_at,
            t.session_started_at,
            (SELECT count(*)::int
               FROM table_device_presence p
              WHERE p.table_id = t.id
                AND p.last_seen > now() - ($2 || ' seconds')::interval) AS active_devices,
            (SELECT count(*)::int
               FROM orders o
              WHERE o.table_id = t.id
                AND o.status IN ('pending', 'preparing', 'ready')) AS active_orders
       FROM restaurant_tables t
      WHERE t.code = $1 AND t.deleted_at IS NULL`,
    [tableToken, RELEASE_PRESENCE_WINDOW_SECONDS],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
  }

  return {
    table_id: row.id,
    code: row.code,
    name: row.name,
    status: row.status === "active" ? "active" : "empty",
    bill_status: row.bill_status,
    bill_requested_at: row.bill_requested_at ? iso(row.bill_requested_at) : null,
    bill_paid_at: row.bill_paid_at ? iso(row.bill_paid_at) : null,
    session_started_at: row.session_started_at ? iso(row.session_started_at) : null,
    active_devices: row.active_devices,
    active_orders: row.active_orders,
  };
}

export interface TableMember {
  user_id: string;
  name: string;
  joined_at: string;
}

/* GET /api/v1/sessions/:table_token/members — the real roster (docs/14 #16).

   `upsertTableMember` has always recorded who joined; nothing exposed it, so
   the Table Pass had to infer names from order/cart `added_by` and a guest
   who joined without ordering was invisible. Capability-scoped by the table
   token, credentials never returned. */
export async function listTableMembers(tableToken: string): Promise<TableMember[]> {
  const table = await requireTable(tableToken);

  const res = await pool.query<{ user_id: string; name: string; joined_at: Date }>(
    `SELECT user_id, name, joined_at
       FROM table_members
      WHERE table_id = $1
      ORDER BY joined_at, id`,
    [table.id],
  );

  return res.rows.map((row) => ({
    user_id: row.user_id,
    name: row.name,
    joined_at: iso(row.joined_at),
  }));
}

export interface HeartbeatResult {
  table_id: string;
  device_id: string;
  last_seen: string;
}

/* POST /api/v1/sessions/:table_token/heartbeat.
   The upsert is the whole protocol: a device that reconnects keeps ONE row
   per table, so a flapping phone cannot fill the registry. */
export async function recordHeartbeat(
  tableToken: string,
  deviceId: string,
): Promise<HeartbeatResult> {
  const table = await requireTable(tableToken);

  const res = await pool.query<{ device_id: string; last_seen: Date }>(
    `INSERT INTO table_device_presence (table_id, device_id, last_seen)
          VALUES ($1, $2, now())
     ON CONFLICT (table_id, device_id)
       DO UPDATE SET last_seen = now()
     RETURNING device_id, last_seen`,
    [table.id, deviceId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(500, "INTERNAL_ERROR", "The device heartbeat could not be recorded.");
  }

  return { table_id: table.id, device_id: row.device_id, last_seen: iso(row.last_seen) };
}

/* DELETE /api/v1/sessions/:table_token/heartbeat.
   Removing the row is a release trigger, not just bookkeeping: the last
   guest closing the tab after paying is precisely the moment the table can
   be cleared. */
export async function removeHeartbeat(
  tableToken: string,
  deviceId: string,
): Promise<{ table_id: string; device_id: string; released: boolean }> {
  const table = await requireTable(tableToken);

  await pool.query("DELETE FROM table_device_presence WHERE table_id = $1 AND device_id = $2", [
    table.id,
    deviceId,
  ]);

  const { released } = await checkAndAutoReleaseTable(table.id);
  return { table_id: table.id, device_id: deviceId, released };
}

/* E9 — GET /api/v1/sessions/:table_token/active-check.
   Read-only guardrail: never 409s, just reports the processing block. */
export async function activeCheck(tableToken: string): Promise<ActiveCheckResult> {
  const table = await requireTable(tableToken);

  const res = await pool.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM orders
      WHERE table_id = $1
        AND status IN ('pending', 'preparing', 'ready')
      ORDER BY created_at DESC
      LIMIT 1`,
    [table.id],
  );

  const order = res.rows[0];
  if (!order) {
    return { has_active_order: false, message: "Ready for new order round initialization." };
  }

  return {
    has_active_order: true,
    order_id: order.id,
    status: order.status,
    message: "Order already sent",
  };
}
