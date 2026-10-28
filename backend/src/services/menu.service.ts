import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { buildMeta, type PageMeta } from "../lib/util.js";
import { requireTable } from "./sessions.service.js";

/* Module 2 — Live Menu Browsing (E3) + Module 4 — 86ing (E14). */

export interface MenuListParams {
  table_token: string;
  page: number;
  limit: number;
  category?: string;
  q?: string;
}

export interface MenuItemDto {
  menu_item_id: string;
  name: string;
  price: number;
  category: string;
  is_available: boolean;
  description: string;
  vegetarian: boolean;
}

/* E3 — GET /api/v1/menu.
   Unavailable items are returned with is_available:false (clients grey
   them out; they are never hidden from the catalog). */
export async function listMenu(params: MenuListParams): Promise<{
  data: MenuItemDto[];
  meta: PageMeta;
}> {
  await requireTable(params.table_token);

  const args: unknown[] = [];
  const where: string[] = [];
  if (params.category) {
    args.push(params.category);
    where.push(`category = $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`name ILIKE $${args.length}`);
  }
  /* An archived dish is gone from the diner's world (006). The filter is
     written into the WHERE list rather than added afterwards so the count and
     the page can never disagree about what "the menu" contains. */
  where.push("deleted_at IS NULL");
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const countRes = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM menu_items ${whereSql}`,
    args,
  );

  args.push(params.limit, (params.page - 1) * params.limit);
  const rows = await pool.query(
    `SELECT id, name, price::float8 AS price, category, is_available, description, vegetarian
       FROM menu_items
       ${whereSql}
      ORDER BY category, name
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );

  const data: MenuItemDto[] = rows.rows.map((row) => ({
    menu_item_id: row.id,
    name: row.name,
    price: Number(row.price),
    category: row.category,
    is_available: row.is_available,
    description: row.description,
    vegetarian: row.vegetarian,
  }));

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}

/* E14 — PATCH /api/v1/menu/items/:menu_item_id/availability (86ing). */
export async function setAvailability(menuItemId: string, isAvailable: boolean) {
  const res = await pool.query<{ id: string; is_available: boolean }>(
    "UPDATE menu_items SET is_available = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_available",
    [menuItemId, isAvailable],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }

  return { menu_item_id: row.id, is_available: row.is_available };
}
