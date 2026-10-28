import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { buildMeta, type PageMeta } from "../lib/util.js";
import { ownedCartLine } from "./ownership.js";
import { requireTable } from "./sessions.service.js";

/* Module 2 — Real-Time Shared Cart (E4 read, E5 upsert, E6 update, E7 remove).
   Every operation is scoped to the owning table via table_token; writes are
   single atomic statements so concurrent phones cannot fork state. */

export interface CartRow {
  id: string;
  table_id: string;
  menu_item_id: string;
  quantity: number;
  request_note: string;
  allergy_note: string;
  added_by: string;
}

export interface CartLineWithTotal extends CartRow {
  total_table_quantity: number;
}

export interface CartListParams {
  table_token: string;
  page: number;
  limit: number;
}

/* E4 — GET /api/v1/cart/items (REST bootstrap before Realtime attaches). */
export async function listCart(params: CartListParams): Promise<{
  data: CartRow[];
  meta: PageMeta;
}> {
  const table = await requireTable(params.table_token);

  const countRes = await pool.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM cart_items WHERE table_id = $1",
    [table.id],
  );

  const rows = await pool.query<CartRow>(
    `SELECT id, table_id, menu_item_id, quantity, request_note, allergy_note, added_by
       FROM cart_items
      WHERE table_id = $1
      ORDER BY created_at, id
      LIMIT $2 OFFSET $3`,
    [table.id, params.limit, (params.page - 1) * params.limit],
  );

  return { data: rows.rows, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}

async function totalForTableItem(tableId: string, menuItemId: string): Promise<number> {
  const res = await pool.query<{ total: number }>(
    "SELECT COALESCE(sum(quantity), 0)::int AS total FROM cart_items WHERE table_id = $1 AND menu_item_id = $2",
    [tableId, menuItemId],
  );
  return res.rows[0]?.total ?? 0;
}

export interface CartAddInput {
  table_token: string;
  menu_item_id: string;
  quantity: number;
  allergy_note?: string;
  request_note?: string;
  added_by?: string;
}

/* E5 — POST /api/v1/cart/items.
   Best-effort availability check here (fast feedback); the authoritative
   check happens atomically inside fire_order() at E8 (docs/7 §1.9).
   The unique index on (table_id, menu_item_id, request_note, allergy_note)
   + ON CONFLICT makes concurrent add-taps from two phones merge into one
   line instead of forking duplicates. */
export async function addCartItem(input: CartAddInput): Promise<CartLineWithTotal> {
  const table = await requireTable(input.table_token);

  const menuRes = await pool.query<{ id: string; name: string; is_available: boolean }>(
    "SELECT id, name, is_available FROM menu_items WHERE id = $1 AND deleted_at IS NULL",
    [input.menu_item_id],
  );
  const menuItem = menuRes.rows[0];
  if (!menuItem) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }
  if (!menuItem.is_available) {
    throw new AppError(409, "ITEM_UNAVAILABLE", `${menuItem.name} just ran out.`);
  }

  const upsert = await pool.query<CartRow>(
    `INSERT INTO cart_items (table_id, menu_item_id, quantity, request_note, allergy_note, added_by)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (table_id, menu_item_id, request_note, allergy_note)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity,
                     added_by = EXCLUDED.added_by
     RETURNING id, table_id, menu_item_id, quantity, request_note, allergy_note, added_by`,
    [
      table.id,
      input.menu_item_id,
      input.quantity,
      input.request_note ?? "",
      input.allergy_note ?? "",
      input.added_by?.trim() || "Guest",
    ],
  );

  const row = upsert.rows[0] as CartRow;
  return { ...row, total_table_quantity: await totalForTableItem(table.id, input.menu_item_id) };
}

export interface CartUpdateInput {
  table_token: string;
  quantity?: number;
  /** +/- stepper intent: applied atomically as quantity = quantity + delta. */
  quantity_delta?: number;
  request_note?: string;
  allergy_note?: string;
}

/* E6 — PATCH /api/v1/cart/items/:cart_item_id.
   Ownership enforced twice: the helper resolves table_token and rejects
   foreign lines, and the UPDATE still re-asserts table_id in SQL.

   TWO write modes:
   * quantity_delta (what the +/- steppers send) — ONE atomic statement
     does the arithmetic (`quantity = quantity + $3`) inside the WHERE
     range guard, so two phones tapping at the same time serialize in the
     database and neither tap is lost. No read-modify-write, no lock needed.
   * quantity (contract's absolute "set to N") — single UPDATE, last write
     wins by definition; note edits behave the same way.

   BOTH modes carry the note columns through COALESCE. That is the fix for a
   real data-loss bug: a delta tap that also edited the note (or a client
   that echoes the notes back with a stepper update) used to hit the branch
   that only wrote `quantity`, so the note change was silently dropped and
   the kitchen cooked the wrong thing. COALESCE means "write it if it was
   sent, keep what is stored if it was not" — never "blank it out". */
export async function updateCartItem(
  cartItemId: string,
  input: CartUpdateInput,
): Promise<CartLineWithTotal> {
  if (input.quantity_delta !== undefined) {
    const table = await requireTable(input.table_token);

    const deltaRes = await pool.query<CartRow>(
      `UPDATE cart_items
          SET quantity     = quantity + $3,
              request_note = COALESCE($4, request_note),
              allergy_note = COALESCE($5, allergy_note)
        WHERE id = $1 AND table_id = $2
          AND quantity + $3 BETWEEN 1 AND 99
        RETURNING id, table_id, menu_item_id, quantity, request_note, allergy_note, added_by`,
      [
        cartItemId,
        table.id,
        input.quantity_delta,
        input.request_note ?? null,
        input.allergy_note ?? null,
      ],
    );

    const deltaRow = deltaRes.rows[0];
    if (deltaRow) {
      return {
        ...deltaRow,
        total_table_quantity: await totalForTableItem(table.id, deltaRow.menu_item_id),
      };
    }

    // 0 rows updated: the line is gone/foreign (404) or the result would
    // leave 1..99 (400). Classify — this path never writes anything.
    await ownedCartLine(cartItemId, input.table_token);
    throw new AppError(400, "VALIDATION_ERROR", "Quantity must stay between 1 and 99.", {
      fields: { quantity_delta: "Resulting quantity must be between 1 and 99." },
    });
  }

  const { table, line } = await ownedCartLine(cartItemId, input.table_token);

  const res = await pool.query<CartRow>(
    `UPDATE cart_items
        SET quantity     = COALESCE($3, quantity),
            request_note = COALESCE($4, request_note),
            allergy_note = COALESCE($5, allergy_note)
      WHERE id = $1 AND table_id = $2
      RETURNING id, table_id, menu_item_id, quantity, request_note, allergy_note, added_by`,
    [
      line.id,
      table.id,
      input.quantity ?? null,
      input.request_note ?? null,
      input.allergy_note ?? null,
    ],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
  }

  return { ...row, total_table_quantity: await totalForTableItem(table.id, row.menu_item_id) };
}

/* E7 — DELETE /api/v1/cart/items (same double ownership check). */
export async function removeCartItem(tableToken: string, cartItemId: string) {
  const { table, line } = await ownedCartLine(cartItemId, tableToken);

  const res = await pool.query<{ id: string }>(
    "DELETE FROM cart_items WHERE id = $1 AND table_id = $2 RETURNING id",
    [line.id, table.id],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "CART_ITEM_NOT_FOUND", "That cart line no longer exists.");
  }

  return { id: row.id, message: "Line item purged from table cart." };
}
