import { randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { signToken, type ShiftClaims } from "../lib/jwt.js";
import { iso } from "../lib/util.js";
import { resolveCategoryForWrite } from "./catalog.service.js";
import { imageDtoFromRow } from "./menu-image.service.js";
import { denyPendingOrdersForItem } from "./orders.service.js";
import { clearTableSession, type BillStatus } from "./sessions.service.js";

/* Module 5 — Executive Admin Engine.
 *
 * The owner/manager console: live sales analytics, physical-table management
 * and the menu catalog. Everything here is reached through an `admin` JWT
 * (see admin.routes.ts), never through a kitchen/floor shift token — the same
 * credential that lets a cook tap "start cooking" must not be able to archive
 * a table or rewrite prices.
 *
 * ZERO-EXPOSURE: ADMIN_PIN never appears in a response, a log line or an
 * error message. The PIN is compared with timingSafeEqual and the only thing
 * that leaves this module is the signed role claim.
 *
 * HISTORY IS IMMUTABLE: "delete" is always `deleted_at = now()` (006). An old
 * ticket still points at its table and its dishes, and a re-priced dish must
 * not rewrite last week's bill (004).
 */

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // one management shift

/** Codes are lowercase alphanumeric, 5–8 chars: short enough to type into the
    manual-entry dialog, long enough that guessing one is not a shortcut. */
export const TABLE_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const TABLE_CODE_MIN = 5;
export const TABLE_CODE_MAX = 8;
const TABLE_CODE_RE = /^[a-z0-9]{5,8}$/;

/**
 * A fresh table code. `randomInt` is the crypto RNG (not Math.random), so two
 * tables can never be minted from a predictable sequence.
 */
export function generateTableCode(length = 6): string {
  const size = Math.min(TABLE_CODE_MAX, Math.max(TABLE_CODE_MIN, length));
  let code = "";
  for (let i = 0; i < size; i += 1) {
    code += TABLE_CODE_ALPHABET.charAt(randomInt(0, TABLE_CODE_ALPHABET.length));
  }
  return code;
}

/** Constant-time PIN comparison; both sides are fixed-length digit strings. */
export function adminPinMatches(attempt: string, expected: string): boolean {
  const a = Buffer.from(attempt);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AdminLoginResult {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  role: "admin";
  message: string;
}

/* POST /api/v1/auth/admin-login.
   Issues the role:"admin" claim the router enforces. The JWT is signed with
   the same HMAC secret as the shift token — the difference is the `role`
   claim, which requireRole() checks on every admin request. */
export async function authenticateAdmin(pin: string): Promise<AdminLoginResult> {
  if (!adminPinMatches(pin, env.adminPin)) {
    // Static message: the attempted PIN is never echoed, hashed or logged.
    throw new AppError(401, "INVALID_ADMIN_PIN", "That manager PIN is not correct.");
  }

  const now = Math.floor(Date.now() / 1000);
  const claims: ShiftClaims = {
    role: "admin",
    terminal_id: null,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };

  return {
    token: signToken(claims, env.kdsTokenSecret),
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    role: "admin",
    message: "Manager console unlocked.",
  };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface AdminTable {
  table_id: string;
  code: string;
  name: string;
  /** 'active' while a dining session is open, 'empty' otherwise. */
  status: string;
  bill_status: BillStatus;
  /** Set when staff tried to clear an unpaid table; this is the admin alert. */
  clear_requested_at: string | null;
  active_order_count: number;
  cart_line_count: number;
  /** Phones heartbeating on this table inside the stale window. */
  active_devices: number;
  /** Whether this table currently has a PIN/pass issued. */
  has_session: boolean;
  session_started_at: string | null;
  /** The guests on the session roster, oldest first (empty when unseated). */
  members: AdminTableMember[];
  created_at: string;
}

/** One person seated at a table, as recorded when their phone joined. */
export interface AdminTableMember {
  user_id: string;
  name: string;
  joined_at: string;
}

interface AdminTableRow {
  table_id: string;
  code: string;
  name: string;
  status: string;
  bill_status: BillStatus;
  clear_requested_at: Date | null;
  active_order_count: number;
  cart_line_count: number;
  active_devices: number;
  has_session: boolean;
  session_started_at: Date | null;
  members: AdminTableMember[];
  created_at: Date;
}

/* GET /api/v1/admin/tables.
   Every live table with the two numbers that decide what an operator does
   next: how many tickets are open on it, and whether a session is pinned to
   it right now. Archived tables are gone by definition. */
export async function listAdminTables(): Promise<AdminTable[]> {
  const res = await pool.query<AdminTableRow>(
    `SELECT t.id AS table_id,
            t.code,
            t.name,
            t.status,
            t.bill_status,
            t.clear_requested_at,
            t.session_pin IS NOT NULL AS has_session,
            t.session_started_at,
            t.created_at,
            (SELECT count(*)::int
               FROM orders o
              WHERE o.table_id = t.id
                AND o.status IN ('pending', 'preparing', 'ready')) AS active_order_count,
            (SELECT count(*)::int
               FROM cart_items ci
              WHERE ci.table_id = t.id) AS cart_line_count,
            (SELECT count(*)::int
               FROM table_device_presence p
              WHERE p.table_id = t.id
                AND p.last_seen > now() - interval '120 seconds') AS active_devices,
            /* Who is sitting here. The roster is written when a phone joins
               (E1/E1b/E1c) and wiped with the seating, so this is the party
               actually at the table — not last night's history. */
            COALESCE(
              (SELECT json_agg(json_build_object(
                          'user_id', m.user_id,
                          'name', m.name,
                          'joined_at', m.joined_at
                        ) ORDER BY m.joined_at, m.id)
                 FROM table_members m
                WHERE m.table_id = t.id),
              '[]'::json
            ) AS members
       FROM restaurant_tables t
      WHERE t.deleted_at IS NULL
      ORDER BY t.created_at, t.code`,
  );

  return res.rows.map((row) => ({
    table_id: row.table_id,
    code: row.code,
    name: row.name,
    status: row.status,
    bill_status: row.bill_status,
    clear_requested_at: row.clear_requested_at ? iso(row.clear_requested_at) : null,
    active_order_count: row.active_order_count,
    cart_line_count: row.cart_line_count,
    active_devices: row.active_devices,
    has_session: row.has_session,
    session_started_at: row.session_started_at ? iso(row.session_started_at) : null,
    members: row.members.map((member) => ({
      user_id: member.user_id,
      name: member.name,
      joined_at: iso(member.joined_at),
    })),
    created_at: iso(row.created_at),
  }));
}

/* A collision is astronomically unlikely (36^6 ≈ 2.2 bn) but it is a UNIQUE
   violation, not a server bug: retry with a fresh code instead of 500ing. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/* POST /api/v1/admin/tables — create a physical table with a generated code. */
export async function createTable(input: { name: string }): Promise<AdminTable> {
  const name = input.name.trim();
  if (!name) {
    throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
      fields: { name: "Give the table a name." },
    });
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateTableCode();
    try {
      const res = await pool.query<AdminTableRow>(
        `INSERT INTO restaurant_tables (code, name, status)
              VALUES ($1, $2, 'empty')
           RETURNING id AS table_id, code, name, status, bill_status, created_at,
                     session_started_at, clear_requested_at,
                     false AS has_session,
                     0::int AS active_order_count,
                     0::int AS cart_line_count,
                     0::int AS active_devices`,
        [code, name],
      );

      const row = res.rows[0];
      if (!row) break;
      return {
        table_id: row.table_id,
        code: row.code,
        name: row.name,
        status: row.status,
        bill_status: row.bill_status,
        clear_requested_at: null,
        active_order_count: 0,
        cart_line_count: 0,
        active_devices: 0,
        has_session: false,
        session_started_at: null,
        members: [],
        created_at: iso(row.created_at),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  throw new AppError(500, "INTERNAL_ERROR", "A unique table code could not be generated.");
}

/* PATCH /api/v1/admin/tables/:table_id — rename in place. */
export async function updateTableName(
  tableId: string,
  input: { name?: string },
): Promise<{ table_id: string; name: string }> {
  if (input.name === undefined) {
    throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
      fields: { name: "Provide a name to update." },
    });
  }

  const name = input.name.trim();
  if (!name) {
    throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
      fields: { name: "The table name cannot be empty." },
    });
  }

  const res = await pool.query<{ id: string; name: string }>(
    `UPDATE restaurant_tables
        SET name = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, name`,
    [tableId, name],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
  }

  return { table_id: row.id, name: row.name };
}

/* PATCH /api/v1/admin/tables/:table_id/code — repair the code printed on a
   QR stand.

   Regenerating mints a random code, so a stand can end up with a code nobody
   wrote down. This lets a manager set the code back to a known value. It is
   deliberately narrow: an EMPTY table only. Once a party is seated, their
   phones hold `/table/<code>` and their pass is scoped to the row, so moving
   the code under them would break the table they are looking at — a session,
   a staged cart or an open ticket all refuse the change (409).

   The row is locked FOR UPDATE so two admins editing the same table cannot
   both pass the emptiness check, and a UNIQUE violation is reported as
   TABLE_CODE_TAKEN rather than a 500. */
export async function updateTableCode(
  tableId: string,
  input: { code: string },
): Promise<{ table_id: string; code: string; name: string }> {
  const code = input.code.trim().toLowerCase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query<{
      id: string;
      code: string;
      name: string;
      status: string;
      bill_status: string;
      has_session: boolean;
    }>(
      `SELECT id, code, name, status, bill_status,
              (session_pin IS NOT NULL OR session_started_at IS NOT NULL) AS has_session
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableId],
    );

    const table = found.rows[0];
    if (!table) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
    }

    // Re-saving the same code is a no-op, not a conflict.
    if (table.code === code) {
      await client.query("COMMIT");
      return { table_id: table.id, code: table.code, name: table.name };
    }

    /* STRICT emptiness, server-side and inside the row lock. A code change
       rewrites the capability printed on a QR stand, so it is only safe when
       NOTHING about the current seating survives: the table must be 'empty',
       hold no issued credentials, no staged cart, no open (or denied-but-
       unread) ticket, no bill conversation and no connected device. Each of
       those is a separate fact, so each gets its own count — a single
       `status` flag would miss a deactivated-but-pinned row. */
    const activity = await client.query<{
      cart_lines: number;
      open_orders: number;
      roster: number;
      devices: number;
    }>(
      `SELECT (SELECT count(*)::int FROM cart_items WHERE table_id = $1) AS cart_lines,
              (SELECT count(*)::int
                 FROM orders
                WHERE table_id = $1
                  AND status IN ('pending', 'preparing', 'ready')) AS open_orders,
              (SELECT count(*)::int FROM table_members WHERE table_id = $1) AS roster,
              (SELECT count(*)::int
                 FROM table_device_presence
                WHERE table_id = $1
                  AND last_seen > now() - interval '120 seconds') AS devices`,
      [table.id],
    );
    const row = activity.rows[0];

    if (
      table.status !== "empty" ||
      table.has_session ||
      table.bill_status !== "unrequested" ||
      (row?.cart_lines ?? 0) > 0 ||
      (row?.open_orders ?? 0) > 0 ||
      (row?.roster ?? 0) > 0 ||
      (row?.devices ?? 0) > 0
    ) {
      throw new AppError(
        409,
        "TABLE_NOT_EMPTY",
        "This table is not empty. Clear it before changing its code.",
        { table_id: table.id },
      );
    }

    const updated = await client.query<{ id: string; code: string; name: string }>(
      `UPDATE restaurant_tables
          SET code = $2
        WHERE id = $1
        RETURNING id, code, name`,
      [table.id, code],
    );

    await client.query("COMMIT");

    const saved = updated.rows[0];
    if (!saved) {
      throw new AppError(500, "INTERNAL_ERROR", "The table code could not be updated.");
    }

    return { table_id: saved.id, code: saved.code, name: saved.name };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);

    // Archived tables keep their code, so the UNIQUE index also covers history.
    if (isUniqueViolation(err)) {
      throw new AppError(409, "TABLE_CODE_TAKEN", "Another table already uses that code.");
    }

    throw err;
  } finally {
    client.release();
  }
}

/* POST /api/v1/admin/tables/:table_id/regenerate-token.
   The "reset the table" button. Rotating the code invalidates every phone
   that still holds the old URL (a photographed QR stops working), and the
   three writes below are ONE transaction so a table can never end up with a
   new code but yesterday's cart, or a cleared cart but a live session.

   The seating's tickets are REMOVED with it (docs/14 #21): the next party
   starts empty. Sales are safe — a served ticket was already rolled up into
   `sales_day` / `sales_rollup` by sql/012 before it is deleted here. */
export async function regenerateTableToken(tableId: string): Promise<{
  table_id: string;
  code: string;
  name: string;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query<{ id: string; name: string; code: string }>(
      `SELECT id, name, code
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableId],
    );
    const table = found.rows[0];
    if (!table) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
    }

    /* Clear the session's contents, then its credentials. Each step keeps its
       own WHERE: `status <> 'served'` is what the status-transition trigger
       in 004 expects (closing from any live state is allowed). A DENIED
       round is already closed, so it is left exactly as the diner last saw
       it (the tracker may still be showing the reason on a phone) — but the
       roster and the presence registry MUST go, or the next party inherits a
       table that still claims its previous guests are sitting at it. */
    await client.query("DELETE FROM cart_items WHERE table_id = $1", [table.id]);
    await client.query("DELETE FROM table_members WHERE table_id = $1", [table.id]);
    await client.query("DELETE FROM table_device_presence WHERE table_id = $1", [table.id]);
    await client.query("DELETE FROM orders WHERE table_id = $1", [table.id]);

    const newCode = generateTableCode();
    const updated = await client.query<{ id: string; code: string; name: string }>(
      `UPDATE restaurant_tables
          SET code                = $2,
              status              = 'empty',
              session_pin         = NULL,
              session_secret      = NULL,
              failed_pin_attempts = 0,
              session_started_at  = NULL,
              bill_status         = 'unrequested',
              bill_requested_at   = NULL,
              bill_paid_at        = NULL,
              clear_requested_at  = NULL,
              last_cleared_at     = now()
        WHERE id = $1
        RETURNING id, code, name`,
      [table.id, newCode],
    );

    await client.query("COMMIT");

    const row = updated.rows[0];
    if (!row) {
      throw new AppError(500, "INTERNAL_ERROR", "The table token could not be regenerated.");
    }

    return { table_id: row.id, code: row.code, name: row.name };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* DELETE /api/v1/admin/tables/:table_id — archive, never drop the row. */
/* POST /api/v1/admin/tables/:table_id/clear — the manager override.

   Staff cannot clear a table that owes money; the manager can, once there is
   no open ticket. This also resolves the clear-request alert and ends the
   session for the next party. */
export interface AdminClearTableResult {
  table_id: string;
  cleared: true;
  bill_status: BillStatus;
}

export async function clearTableAsAdmin(tableId: string): Promise<AdminClearTableResult> {
  const result = await clearTableSession(tableId, { allowUnpaid: true });

  if (result.outcome === "not_found") {
    throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
  }

  if (result.outcome === "active_orders") {
    throw new AppError(
      409,
      "TABLE_HAS_ACTIVE_ORDERS",
      "This table still has an open ticket. Serve or prune it before clearing the table.",
      { table_id: tableId, active_orders: result.active_orders },
    );
  }

  return {
    table_id: tableId,
    cleared: true,
    bill_status: result.bill_status ?? "paid",
  };
}

/* POST /api/v1/admin/tables/:table_id/deactivate

   The manager's "stop this table now", available at any moment. Unlike a
   staff clear it does not check for owed money or an open ticket: the manager
   decides. The seating's tickets are removed (docs/14 #21 — anything already
   served was rolled up into sales_day first), the cart and presence rows go
   with them, the session ends and the bill/alert reset — but the CODE IS
   KEPT, so the printed QR stand still works when the table opens again. */
export interface DeactivateTableResult {
  table_id: string;
  deactivated: true;
  closed_orders: number;
}

export async function deactivateTableAsAdmin(tableId: string): Promise<DeactivateTableResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query<{ id: string }>(
      `SELECT id FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableId],
    );

    if (!found.rows[0]) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
    }

    // Count what is being stopped BEFORE removing it, for the console receipt.
    const closed = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM orders
        WHERE table_id = $1 AND status IN ('pending', 'preparing', 'ready')`,
      [tableId],
    );

    await client.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
    await client.query("DELETE FROM cart_items WHERE table_id = $1", [tableId]);
    await client.query("DELETE FROM table_members WHERE table_id = $1", [tableId]);
    await client.query("DELETE FROM table_device_presence WHERE table_id = $1", [tableId]);

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

    await client.query("COMMIT");

    return {
      table_id: tableId,
      deactivated: true,
      closed_orders: closed.rows[0]?.count ?? 0,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* DELETE /api/v1/admin/tables/:table_id — archive, never drop the row.

   The archive used to be a single UPDATE, which left the archived table
   holding a live cart, a device registry and its members. Nobody can reach
   those rows any more (every read filters `deleted_at IS NULL`), so they
   were pure leakage: a table re-created with the same code would inherit a
   cart from a party that left months ago. Archiving therefore closes the
   seating completely — tickets, cart, roster and presence are deleted,
   credentials and bill state are wiped, and `last_cleared_at` records when —
   in ONE transaction, so an archive can never half-happen. Served tickets
   were rolled up into sales_day (sql/012) before they are removed. */
export async function archiveTable(tableId: string): Promise<{ table_id: string }> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const found = await client.query<{ id: string }>(
      `SELECT id FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableId],
    );
    if (!found.rows[0]) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
    }

    await client.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
    await client.query("DELETE FROM cart_items WHERE table_id = $1", [tableId]);
    await client.query("DELETE FROM table_members WHERE table_id = $1", [tableId]);
    await client.query("DELETE FROM table_device_presence WHERE table_id = $1", [tableId]);

    await client.query(
      `UPDATE restaurant_tables
          SET deleted_at          = now(),
              status              = 'empty',
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

    await client.query("COMMIT");
    committed = true;

    return { table_id: tableId };
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Menu catalog
// ---------------------------------------------------------------------------

export interface AdminMenuItem {
  menu_item_id: string;
  name: string;
  price: number;
  /** The legacy label, kept in step with the folder's name. */
  category: string;
  category_id: string | null;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
  /** Uploaded photo URLs, or null when the dish still uses the curated
      frontend photography. */
  image_url: string | null;
  image_small_url: string | null;
  blur_data_url: string | null;
}

interface AdminMenuRow {
  id: string;
  name: string;
  price: number;
  category: string;
  category_id: string | null;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
  storage_driver: string | null;
  original_key: string | null;
  small_key: string | null;
  tiny_key: string | null;
  blur_data_url: string | null;
}

const MENU_COLUMNS = `mi.id,
       mi.name,
       mi.price::float8 AS price,
       mi.category,
       mi.category_id,
       mi.description,
       mi.vegetarian,
       mi.is_available,
       img.storage_driver,
       img.original_key,
       img.small_key,
       img.tiny_key,
       img.blur_data_url`;

const MENU_FROM = `FROM menu_items mi
  LEFT JOIN menu_item_images img ON img.menu_item_id = mi.id`;

function menuRowToDto(row: AdminMenuRow): AdminMenuItem {
  const image =
    row.storage_driver && row.original_key && row.small_key && row.tiny_key
      ? imageDtoFromRow({
          menu_item_id: row.id,
          storage_driver: row.storage_driver,
          original_key: row.original_key,
          small_key: row.small_key,
          tiny_key: row.tiny_key,
          blur_data_url: row.blur_data_url ?? "",
        })
      : null;

  return {
    menu_item_id: row.id,
    name: row.name,
    price: Number(row.price),
    category: row.category,
    category_id: row.category_id,
    description: row.description,
    vegetarian: row.vegetarian,
    is_available: row.is_available,
    image_url: image?.image_url ?? null,
    image_small_url: image?.image_small_url ?? null,
    blur_data_url: image?.blur_data_url ?? null,
  };
}

async function getAdminMenuItem(menuItemId: string): Promise<AdminMenuItem> {
  const res = await pool.query<AdminMenuRow>(
    `SELECT ${MENU_COLUMNS} ${MENU_FROM}
      WHERE mi.id = $1 AND mi.deleted_at IS NULL`,
    [menuItemId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }
  return menuRowToDto(row);
}

/* GET /api/v1/admin/menu — includes 86'd dishes (the console must be able to
   bring one back), excludes archived ones. */
export async function listAdminMenu(): Promise<AdminMenuItem[]> {
  const res = await pool.query<AdminMenuRow>(
    `SELECT ${MENU_COLUMNS} ${MENU_FROM}
      WHERE mi.deleted_at IS NULL
      ORDER BY mi.category, mi.name`,
  );
  return res.rows.map((row) => menuRowToDto(row));
}

export interface CreateMenuItemInput {
  name: string;
  price: number;
  category_id?: string | null;
  category?: string;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
}

/* POST /api/v1/admin/menu */
export async function createMenuItem(input: CreateMenuItemInput): Promise<AdminMenuItem> {
  const folder = await resolveCategoryForWrite({
    category_id: input.category_id ?? undefined,
    category: input.category,
  });

  const res = await pool.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, category_id, description, vegetarian, is_available)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
    [
      input.name.trim(),
      input.price,
      folder.category,
      folder.category_id,
      input.description.trim(),
      input.vegetarian,
      input.is_available,
    ],
  );

  const id = res.rows[0]?.id;
  if (!id) {
    throw new AppError(500, "INTERNAL_ERROR", "The dish could not be created.");
  }
  return getAdminMenuItem(id);
}

export type UpdateMenuItemInput = Partial<CreateMenuItemInput>;

/* PATCH /api/v1/admin/menu/:menu_item_id — only the supplied fields change.
   COALESCE carries this because every column is NOT NULL and no patch value
   is ever NULL: `false` and `0` and `""` are all legitimate and must win over
   the stored value, which COALESCE does (only SQL NULL defers). */
export async function updateMenuItem(
  menuItemId: string,
  input: UpdateMenuItemInput,
): Promise<AdminMenuItem> {
  /* A folder change carries both halves: the id and the label it implies. */
  const folder =
    input.category_id !== undefined || input.category !== undefined
      ? await resolveCategoryForWrite({
          category_id: input.category_id ?? undefined,
          category: input.category,
        })
      : null;

  const res = await pool.query<{ id: string }>(
    `UPDATE menu_items
        SET name         = COALESCE($2, name),
            price        = COALESCE($3, price),
            category     = COALESCE($4, category),
            description  = COALESCE($5, description),
            vegetarian   = COALESCE($6, vegetarian),
            is_available = COALESCE($7, is_available),
            category_id  = CASE WHEN $8::boolean THEN $9 ELSE category_id END
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [
      menuItemId,
      input.name !== undefined ? input.name.trim() : null,
      input.price ?? null,
      folder ? folder.category : null,
      input.description !== undefined ? input.description.trim() : null,
      input.vegetarian ?? null,
      input.is_available ?? null,
      folder !== null,
      folder ? folder.category_id : null,
    ],
  );

  if (!res.rows[0]) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }

  const updated = await getAdminMenuItem(menuItemId);

  /* The console's 86 switch must behave exactly like E14: anything still
     PENDING that contains this dish is refused automatically. Without this,
     a manager could take a dish off the menu while a fired round sat waiting
     for it, and the kitchen would have no way to say so. */
  if (input.is_available === false) {
    await denyPendingOrdersForItem(menuItemId, updated.name);
  }

  return updated;
}

/* DELETE /api/v1/admin/menu/:menu_item_id — soft delete (order history keeps
   pointing at the row, and ON DELETE RESTRICT would refuse a hard delete).
   Archiving also marks the dish unavailable, so any PENDING round holding it
   is denied with the same reason as an E14 86. */
export async function archiveMenuItem(menuItemId: string): Promise<{ menu_item_id: string }> {
  const res = await pool.query<{ id: string; name: string }>(
    `UPDATE menu_items
        SET deleted_at = now(), is_available = false
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, name`,
    [menuItemId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }

  await denyPendingOrdersForItem(row.id, row.name);

  return { menu_item_id: row.id };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface TopSellingItem {
  menu_item_id: string;
  name: string;
  category: string;
  total_sold: number;
  total_revenue: number;
}

export interface AnalyticsSummary {
  items: TopSellingItem[];
  total_revenue: number;
  total_orders_served: number;
  active_tables_count: number;
}

/* GET /api/v1/admin/analytics/top-selling.

   Reads the SALES ROLLUP (sql/012), not the order rows. A ticket is counted
   the moment it reaches `served`, and the rollup outlives the ticket when a
   seating is cleared (docs/14 #21). Online tickets are absent on purpose — a
   ticket still on the line has not earned its revenue yet. Revenue is the
   fire-time price snapshot (sql/004), so re-pricing a dish today cannot
   inflate yesterday's takings. */
export async function topSellingAnalytics(): Promise<AnalyticsSummary> {
  const [items, summary, tables] = await Promise.all([
    pool.query<{
      menu_item_id: string;
      name: string;
      category: string;
      total_sold: number;
      total_revenue: string;
    }>(
      `SELECT mi.id AS menu_item_id,
              mi.name,
              mi.category,
              COALESCE(SUM(sr.quantity), 0)::int AS total_sold,
              COALESCE(SUM(sr.revenue), 0)::numeric(10,2) AS total_revenue
         FROM sales_rollup sr
         JOIN menu_items mi ON mi.id = sr.menu_item_id
        GROUP BY mi.id, mi.name, mi.category
        ORDER BY total_sold DESC
        LIMIT 10`,
    ),
    pool.query<{ total_revenue: string; total_orders_served: number }>(
      `SELECT COALESCE(SUM(revenue), 0)::numeric(10,2) AS total_revenue,
              COALESCE(SUM(orders_served), 0)::int AS total_orders_served
         FROM sales_day`,
    ),
    pool.query<{ active_tables_count: number }>(
      `SELECT count(*)::int AS active_tables_count
         FROM restaurant_tables
        WHERE deleted_at IS NULL AND status = 'active'`,
    ),
  ]);

  return {
    items: items.rows.map((row) => ({
      menu_item_id: row.menu_item_id,
      name: row.name,
      category: row.category,
      total_sold: row.total_sold,
      total_revenue: Number(row.total_revenue),
    })),
    total_revenue: Number(summary.rows[0]?.total_revenue ?? 0),
    total_orders_served: summary.rows[0]?.total_orders_served ?? 0,
    active_tables_count: tables.rows[0]?.active_tables_count ?? 0,
  };
}

/** Exposed so a script or test can assert the shape without inventing one. */
export { TABLE_CODE_RE };
