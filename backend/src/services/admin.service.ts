import { randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { signToken, type ShiftClaims } from "../lib/jwt.js";
import { iso } from "../lib/util.js";
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
  /** Whether this table currently has a PIN/pass issued. */
  has_session: boolean;
  session_started_at: string | null;
  created_at: string;
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
  has_session: boolean;
  session_started_at: Date | null;
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
              WHERE ci.table_id = t.id) AS cart_line_count
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
    has_session: row.has_session,
    session_started_at: row.session_started_at ? iso(row.session_started_at) : null,
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
                     0::int AS cart_line_count`,
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
        has_session: false,
        session_started_at: null,
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

/* POST /api/v1/admin/tables/:table_id/regenerate-token.
   The "reset the table" button. Rotating the code invalidates every phone
   that still holds the old URL (a photographed QR stops working), and the
   three writes below are ONE transaction so a table can never end up with a
   new code but yesterday's cart, or a cleared cart but a live session.

   Serving the open orders is deliberate: the operator is archiving THIS
   seating, and the orders stay in history as served tickets — deleting them
   would rewrite the day's sales. */
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
       in 004 expects (closing from any live state is allowed). */
    await client.query("DELETE FROM cart_items WHERE table_id = $1", [table.id]);
    await client.query(
      `UPDATE orders
          SET status = 'served', updated_at = now()
        WHERE table_id = $1 AND status <> 'served'`,
      [table.id],
    );

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
              clear_requested_at  = NULL
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

export async function archiveTable(tableId: string): Promise<{ table_id: string }> {
  const res = await pool.query<{ id: string }>(
    `UPDATE restaurant_tables
        SET deleted_at = now(),
            status = 'empty',
            session_pin = NULL,
            session_secret = NULL
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [tableId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Unknown table.");
  }

  return { table_id: row.id };
}

// ---------------------------------------------------------------------------
// Menu catalog
// ---------------------------------------------------------------------------

export interface AdminMenuItem {
  menu_item_id: string;
  name: string;
  price: number;
  category: string;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
}

const MENU_COLUMNS =
  "id, name, price::float8 AS price, category, description, vegetarian, is_available";

function menuRowToDto(row: {
  id: string;
  name: string;
  price: number;
  category: string;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
}): AdminMenuItem {
  return {
    menu_item_id: row.id,
    name: row.name,
    price: Number(row.price),
    category: row.category,
    description: row.description,
    vegetarian: row.vegetarian,
    is_available: row.is_available,
  };
}

/* GET /api/v1/admin/menu — includes 86'd dishes (the console must be able to
   bring one back), excludes archived ones. */
export async function listAdminMenu(): Promise<AdminMenuItem[]> {
  const res = await pool.query(
    `SELECT ${MENU_COLUMNS}
       FROM menu_items
      WHERE deleted_at IS NULL
      ORDER BY category, name`,
  );
  return res.rows.map(menuRowToDto);
}

export interface CreateMenuItemInput {
  name: string;
  price: number;
  category: string;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
}

/* POST /api/v1/admin/menu */
export async function createMenuItem(input: CreateMenuItemInput): Promise<AdminMenuItem> {
  const res = await pool.query(
    `INSERT INTO menu_items (name, price, category, description, vegetarian, is_available)
          VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${MENU_COLUMNS}`,
    [
      input.name.trim(),
      input.price,
      input.category.trim(),
      input.description.trim(),
      input.vegetarian,
      input.is_available,
    ],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(500, "INTERNAL_ERROR", "The dish could not be created.");
  }
  return menuRowToDto(row);
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
  const res = await pool.query(
    `UPDATE menu_items
        SET name         = COALESCE($2, name),
            price        = COALESCE($3, price),
            category     = COALESCE($4, category),
            description  = COALESCE($5, description),
            vegetarian   = COALESCE($6, vegetarian),
            is_available = COALESCE($7, is_available)
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING ${MENU_COLUMNS}`,
    [
      menuItemId,
      input.name !== undefined ? input.name.trim() : null,
      input.price ?? null,
      input.category !== undefined ? input.category.trim() : null,
      input.description !== undefined ? input.description.trim() : null,
      input.vegetarian ?? null,
      input.is_available ?? null,
    ],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }
  return menuRowToDto(row);
}

/* DELETE /api/v1/admin/menu/:menu_item_id — soft delete (order history keeps
   pointing at the row, and ON DELETE RESTRICT would refuse a hard delete). */
export async function archiveMenuItem(menuItemId: string): Promise<{ menu_item_id: string }> {
  const res = await pool.query<{ id: string }>(
    `UPDATE menu_items
        SET deleted_at = now(), is_available = false
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [menuItemId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }

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
   Sold quantities come from `order_items`, never from the cart, and only
   fully SERVED orders count — a ticket still on the line has not earned its
   revenue yet. Prices are the fire-time snapshot (004), so re-pricing a dish
   today cannot inflate yesterday's takings. */
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
              COALESCE(SUM(oi.quantity), 0)::int AS total_sold,
              COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric(10,2) AS total_revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN menu_items mi ON mi.id = oi.menu_item_id
        WHERE o.status = 'served'
        GROUP BY mi.id, mi.name, mi.category
        ORDER BY total_sold DESC
        LIMIT 10`,
    ),
    pool.query<{ total_revenue: string; total_orders_served: number }>(
      `SELECT COALESCE(SUM(total), 0)::numeric(10,2) AS total_revenue,
              count(*)::int AS total_orders_served
         FROM orders
        WHERE status = 'served'`,
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
