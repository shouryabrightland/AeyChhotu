import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { iso } from "../lib/util.js";

/* Module 6 — the manager console's reporting reads.
 *
 * These are AGGREGATES over data the restaurant already records, not a new
 * source of truth:
 *
 *   sales_day / sales_rollup   rolled up when a ticket is served (sql/012)
 *   orders                     live tickets (pending / preparing / ready)
 *   restaurant_tables          who is seated right now
 *   menu_items                 availability + optional stock counts (sql/016)
 *   guest_feedback             ratings a diner left in the assistant (sql/016)
 *
 * Everything here is admin-only: routes/admin.ts mounts the router behind
 * requireAuth + requireRole("admin"), so a diner table token and a kitchen
 * shift token both get 403/401 before reaching this file.
 *
 * MONEY: `::float8` casts keep the JSON numeric (pg would otherwise hand back
 * a string for NUMERIC). Nothing here mutates a sale, so the frozen prices of
 * 004 are never in play. */

export interface DailySalesSummary {
  day: string;
  revenue_today: number;
  orders_today: number;
  items_sold_today: number;
  average_ticket_today: number;
  revenue_yesterday: number;
  orders_yesterday: number;
  revenue_7d: number;
  orders_7d: number;
}

export interface BestSeller {
  menu_item_id: string;
  name: string;
  category: string;
  units: number;
  revenue: number;
}

export interface PendingOrder {
  order_id: string;
  table_name: string;
  table_code: string;
  status: string;
  total: number;
  created_at: string;
  age_minutes: number;
}

export interface TableOccupancyRow {
  table_id: string;
  name: string;
  code: string;
  status: string;
  bill_status: string;
  devices: number;
  guests: number;
  /** Names the roster recorded when each phone joined, oldest first. */
  member_names: string[];
  open_orders: number;
}

export interface Occupancy {
  total: number;
  occupied: number;
  free: number;
  tables: TableOccupancyRow[];
}

export type StockState = "out" | "low" | "ok" | "untracked";

export interface InventoryItem {
  menu_item_id: string;
  name: string;
  category: string;
  price: number;
  is_available: boolean;
  stock_quantity: number | null;
  low_stock_threshold: number;
  state: StockState;
}

export interface Inventory {
  tracked: number;
  out: number;
  low: number;
  untracked: number;
  items: InventoryItem[];
}

export interface FeedbackRow {
  feedback_id: string;
  rating: number;
  comment: string;
  created_at: string;
  table_name: string;
  table_code: string;
}

/* The one definition of "today", shared with the writer (sql/017): the
   business day starts at 05:00 IST, so the 2 am order belongs to last night.
   Reading CURRENT_DATE here would key on the database's timezone instead. */
const BUSINESS_TODAY = "((now() AT TIME ZONE 'Asia/Kolkata') - interval '5 hours')::date";

/** Today (05:00→05:00 IST), yesterday and the last seven business days. */
export async function dailySalesSummary(): Promise<DailySalesSummary> {
  const { rows } = await pool.query<DailySalesSummary>(
    `WITH b AS (SELECT ${BUSINESS_TODAY} AS today)
     SELECT to_char((SELECT today FROM b), 'YYYY-MM-DD') AS day,
            COALESCE((SELECT revenue FROM sales_day WHERE day = (SELECT today FROM b)), 0)::float8 AS revenue_today,
            COALESCE((SELECT orders_served FROM sales_day WHERE day = (SELECT today FROM b)), 0)::int AS orders_today,
            COALESCE((SELECT SUM(quantity) FROM sales_rollup WHERE day = (SELECT today FROM b)), 0)::int AS items_sold_today,
            COALESCE((
              SELECT CASE WHEN orders_served > 0 THEN revenue / orders_served ELSE 0 END
                FROM sales_day WHERE day = (SELECT today FROM b)
            ), 0)::float8 AS average_ticket_today,
            COALESCE((SELECT revenue FROM sales_day WHERE day = (SELECT today FROM b) - 1), 0)::float8 AS revenue_yesterday,
            COALESCE((SELECT orders_served FROM sales_day WHERE day = (SELECT today FROM b) - 1), 0)::int AS orders_yesterday,
            COALESCE((SELECT SUM(revenue) FROM sales_day WHERE day >= (SELECT today FROM b) - 6), 0)::float8 AS revenue_7d,
            COALESCE((SELECT SUM(orders_served) FROM sales_day WHERE day >= (SELECT today FROM b) - 6), 0)::int AS orders_7d`,
  );

  const row = rows[0];
  if (!row) {
    throw new AppError(500, "INTERNAL_ERROR", "The sales summary could not be read.");
  }
  return row;
}

/** Units and revenue per dish over a window, best first. */
export async function bestSellingDishes(limit: number, days: number): Promise<BestSeller[]> {
  const { rows } = await pool.query<BestSeller>(
    `WITH b AS (SELECT ${BUSINESS_TODAY} AS today)
     SELECT mi.id AS menu_item_id,
            mi.name,
            mi.category,
            SUM(sr.quantity)::int AS units,
            SUM(sr.revenue)::float8 AS revenue
       FROM sales_rollup sr
       JOIN menu_items mi ON mi.id = sr.menu_item_id
      WHERE sr.day BETWEEN (SELECT today FROM b) - ($1::int - 1) AND (SELECT today FROM b)
      GROUP BY mi.id, mi.name, mi.category
      ORDER BY units DESC, revenue DESC
      LIMIT $2::int`,
    [Math.max(1, days), Math.max(1, limit)],
  );
  return rows;
}

/** Every ticket the kitchen still owns, oldest first. */
export async function pendingOrders(): Promise<PendingOrder[]> {
  const { rows } = await pool.query<PendingOrder>(
    `SELECT o.id AS order_id,
            t.name AS table_name,
            t.code AS table_code,
            o.status,
            o.total::float8 AS total,
            o.created_at,
            GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - o.created_at)) / 60))::int AS age_minutes
       FROM orders o
       JOIN restaurant_tables t ON t.id = o.table_id
      WHERE o.status IN ('pending', 'preparing', 'ready')
      ORDER BY o.created_at ASC`,
  );
  return rows.map((row) => ({ ...row, created_at: iso(row.created_at) }));
}

/** Seated vs free, with who is at each table right now. */
export async function tableOccupancy(): Promise<Occupancy> {
  const { rows } = await pool.query<TableOccupancyRow>(
    `SELECT t.id AS table_id,
            t.name,
            t.code,
            t.status,
            t.bill_status,
            (SELECT count(*)::int FROM table_device_presence p WHERE p.table_id = t.id) AS devices,
            (SELECT count(*)::int FROM table_members m WHERE m.table_id = t.id) AS guests,
            COALESCE((
              SELECT json_agg(m.name ORDER BY m.joined_at)
                FROM table_members m WHERE m.table_id = t.id
            ), '[]'::json) AS member_names,
            (SELECT count(*)::int FROM orders o
              WHERE o.table_id = t.id AND o.status IN ('pending', 'preparing', 'ready')) AS open_orders
       FROM restaurant_tables t
      WHERE t.deleted_at IS NULL
      ORDER BY t.name`,
  );

  return {
    total: rows.length,
    occupied: rows.filter((row) => row.status === "active").length,
    free: rows.filter((row) => row.status !== "active").length,
    tables: rows,
  };
}

/** Stock state per live dish. NULL stock is "untracked", never "zero". */
export async function inventoryStatus(): Promise<Inventory> {
  const { rows } = await pool.query<InventoryItem>(
    `SELECT id AS menu_item_id,
            name,
            category,
            price::float8 AS price,
            is_available,
            stock_quantity,
            low_stock_threshold,
            CASE
              WHEN stock_quantity IS NULL            THEN 'untracked'
              WHEN stock_quantity <= 0               THEN 'out'
              WHEN stock_quantity <= low_stock_threshold THEN 'low'
              ELSE 'ok'
            END AS state
       FROM menu_items
      WHERE deleted_at IS NULL
      ORDER BY (stock_quantity IS NULL), stock_quantity ASC, name`,
  );

  return {
    tracked: rows.filter((row) => row.state !== "untracked").length,
    out: rows.filter((row) => row.state === "out").length,
    low: rows.filter((row) => row.state === "low").length,
    untracked: rows.filter((row) => row.state === "untracked").length,
    items: rows,
  };
}

/* The full dish catalogue, metadata included.

   Why the console needs more than a name and a price: the owner asks "what
   goes into the paneer butter masala", "which dishes have peanuts", "what
   can I offer a vegan". Those answers live in the metadata columns added by
   sql/015, not in the sales rollup. Read-only, admin-gated by the router. */
export interface CatalogItem {
  menu_item_id: string;
  name: string;
  category: string;
  price: number;
  description: string;
  vegetarian: boolean;
  spice_level: number;
  ingredients: string[];
  allergens: string[];
  diet_tags: string[];
  portion_description: string;
  is_available: boolean;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
}

export async function menuCatalog(): Promise<CatalogItem[]> {
  const { rows } = await pool.query<CatalogItem>(
    `SELECT id AS menu_item_id,
            name,
            category,
            price::float8 AS price,
            description,
            vegetarian,
            spice_level,
            ingredients,
            allergens,
            diet_tags,
            portion_description,
            is_available,
            stock_quantity,
            low_stock_threshold
       FROM menu_items
      WHERE deleted_at IS NULL
      ORDER BY category, name`,
  );

  return rows;
}

/** The most recent guest ratings. */
export async function listFeedback(limit: number): Promise<FeedbackRow[]> {
  const { rows } = await pool.query<FeedbackRow>(
    `SELECT f.id AS feedback_id,
            f.rating,
            f.comment,
            f.created_at,
            t.name AS table_name,
            t.code AS table_code
       FROM guest_feedback f
       JOIN restaurant_tables t ON t.id = f.table_id
      ORDER BY f.created_at DESC
      LIMIT $1::int`,
    [Math.max(1, limit)],
  );
  return rows.map((row) => ({ ...row, created_at: iso(row.created_at) }));
}

/* Written from the DINER's table session (routes/sessions.ts), never from an
   admin token: the person who ate is the person who rates. Resolving the
   table from the capability token is what stops a rating being filed against
   someone else's table. */
export async function recordFeedback(
  tableToken: string,
  input: { rating: number; comment: string },
): Promise<{ feedback_id: string; rating: number; created_at: string }> {
  const table = await pool.query<{ id: string }>(
    `SELECT id FROM restaurant_tables
      WHERE code = $1 AND deleted_at IS NULL`,
    [tableToken],
  );

  const row = table.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
  }

  const inserted = await pool.query<{ id: string; rating: number; created_at: Date }>(
    `INSERT INTO guest_feedback (table_id, rating, comment)
     VALUES ($1, $2, $3)
     RETURNING id, rating, created_at`,
    [row.id, input.rating, input.comment],
  );

  const created = inserted.rows[0];
  if (!created) {
    throw new AppError(500, "INTERNAL_ERROR", "The feedback could not be saved.");
  }

  return {
    feedback_id: created.id,
    rating: created.rating,
    created_at: iso(created.created_at),
  };
}
