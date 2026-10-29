import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { buildMeta, type PageMeta } from "../lib/util.js";
import { imageDtoFromRow } from "./menu-image.service.js";
import { denyPendingOrdersForItem } from "./orders.service.js";
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
  category_id: string | null;
  is_available: boolean;
  description: string;
  vegetarian: boolean;
  /** Uploaded photo (null = the app's curated photography applies). */
  image_url: string | null;
  image_small_url: string | null;
  blur_data_url: string | null;
  /* Kitchen-maintained dish metadata (sql/015). Empty means "not recorded",
     never "none" — the AI assistant and its allergy check rely on that
     distinction, so these fields travel with every menu row. */
  ingredients: string[];
  spice_level: number;
  allergens: string[];
  diet_tags: string[];
  portion_description: string;
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
    where.push(`mi.category = $${args.length}`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`mi.name ILIKE $${args.length}`);
  }
  /* An archived dish is gone from the diner's world (006). The filter is
     written into the WHERE list rather than added afterwards so the count and
     the page can never disagree about what "the menu" contains. */
  where.push("mi.deleted_at IS NULL");
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const countRes = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM menu_items mi ${whereSql}`,
    args,
  );

  args.push(params.limit, (params.page - 1) * params.limit);
  const rows = await pool.query(
    `SELECT mi.id,
            mi.name,
            mi.price::float8 AS price,
            mi.category,
            mi.category_id,
            mi.is_available,
            mi.description,
            mi.vegetarian,
            mi.ingredients,
            mi.spice_level,
            mi.allergens,
            mi.diet_tags,
            mi.portion_description,
            img.storage_driver,
            img.original_key,
            img.small_key,
            img.tiny_key,
            img.blur_data_url
       FROM menu_items mi
       LEFT JOIN menu_item_images img ON img.menu_item_id = mi.id
       ${whereSql}
      ORDER BY mi.category, mi.name
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );

  const data: MenuItemDto[] = rows.rows.map((row) => {
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
      category_id: row.category_id ?? null,
      is_available: row.is_available,
      description: row.description,
      vegetarian: row.vegetarian,
      ingredients: row.ingredients ?? [],
      spice_level: row.spice_level ?? 0,
      allergens: row.allergens ?? [],
      diet_tags: row.diet_tags ?? [],
      portion_description: row.portion_description ?? "",
      image_url: image?.image_url ?? null,
      image_small_url: image?.image_small_url ?? null,
      blur_data_url: image?.blur_data_url ?? null,
    };
  });

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}

/* E14 — PATCH /api/v1/menu/items/:menu_item_id/availability (86ing).

   Turning a dish OFF is not just a catalog flag: any round still waiting in
   `pending` that contains it can no longer be cooked, so those tickets are
   denied automatically with the dish's name in the reason. The diner then
   sees a denial it can act on (retry without the dish, move it back to the
   cart, or cancel) instead of food that silently never arrives.

   Tickets already `preparing` or `ready` are NOT touched: the kitchen has
   committed to them, and a cook refusing a plated dish is a human decision
   (the KDS deny action), not a stock flip. */
export async function setAvailability(menuItemId: string, isAvailable: boolean) {
  const res = await pool.query<{ id: string; name: string; is_available: boolean }>(
    `UPDATE menu_items
        SET is_available = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, name, is_available`,
    [menuItemId, isAvailable],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }

  const deniedOrders = row.is_available
    ? 0
    : await denyPendingOrdersForItem(row.id, row.name);

  return {
    menu_item_id: row.id,
    is_available: row.is_available,
    /** Rounds automatically refused because of this 86 (0 when re-stocking). */
    denied_orders: deniedOrders,
  };
}
