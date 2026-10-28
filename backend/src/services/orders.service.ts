import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { buildMeta, iso, type PageMeta } from "../lib/util.js";
import { requireTable } from "./sessions.service.js";

/* Module 2 — Review & Fire (E8, atomic via fire_order RPC) +
   Module 4 — status polling (E15) and order history (E16). */

type FireResultCode = "OK" | "TABLE_NOT_FOUND" | "DUPLICATE_ORDER" | "EMPTY_CART" | "INVENTORY_FAILURE";

interface FireResult {
  code: FireResultCode;
  order_id?: string;
  table_id?: string;
  status?: string;
  created_at?: string;
  sold_out?: string[];
}

export interface FiredOrder {
  order_id: string;
  table_id: string;
  status: string;
  created_at: string;
  message: string;
}

/* E8 — POST /api/v1/orders/fire.
   Delegates to the fire_order() Postgres function (docs/7 §1.9): duplicate
   guard, cart freeze, inventory check, ticket build and cart drain all run
   in ONE transaction. Business outcomes come back as jsonb codes so that
   the INVENTORY_FAILURE cart purge still commits. */
export async function fireOrder(tableToken: string): Promise<FiredOrder> {
  /* The RPC was written before archived tables existed (006). Resolving the
     token through requireTable FIRST is the one place that owns the
     `deleted_at IS NULL` rule, so an archived table's URL can never fire. */
  await requireTable(tableToken);

  const res = await pool.query<{ result: FireResult }>("SELECT fire_order($1) AS result", [
    tableToken,
  ]);
  const result = res.rows[0]?.result;
  if (!result) {
    throw new AppError(500, "INTERNAL_ERROR", "Unexpected server error.");
  }

  switch (result.code) {
    case "TABLE_NOT_FOUND":
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");

    case "DUPLICATE_ORDER":
      throw new AppError(409, "DUPLICATE_ORDER", "Order already sent", {
        order_id: result.order_id,
        status: result.status,
      });

    case "EMPTY_CART":
      throw new AppError(409, "EMPTY_CART", "The table cart is empty — nothing to fire.");

    case "INVENTORY_FAILURE": {
      const sold = result.sold_out ?? [];
      const names = sold.join(", ");
      const verb = sold.length > 1 ? "have" : "has";
      throw new AppError(409, "INVENTORY_FAILURE", `${names} ${verb} sold out. Cart updated.`, {
        sold_out: sold,
      });
    }

    case "OK":
      return {
        order_id: result.order_id as string,
        table_id: result.table_id as string,
        status: result.status as string,
        created_at: iso(result.created_at),
        message: "Order successfully routed to KDS line.",
      };

    default:
      throw new AppError(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

/* E15 — GET /api/v1/orders/:order_id/status?table_token=… (diner polling).
   Scoped to the caller's table: an order id on its own must not be a
   universal reader (docs/7 §1.4 capability model + the ownership rule).
   Unknown id and foreign id both surface as the same 404 — existence of
   another table's order is never leaked. */
export async function getOrderStatus(orderId: string, tableToken: string) {
  const table = await requireTable(tableToken);

  const res = await pool.query<{ order_id: string; table_id: string; status: string; created_at: Date }>(
    "SELECT id AS order_id, table_id, status, created_at FROM orders WHERE id = $1 AND table_id = $2",
    [orderId, table.id],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "ORDER_NOT_FOUND", "That order no longer exists.");
  }

  return {
    order_id: row.order_id,
    table_id: row.table_id,
    status: row.status,
    created_at: iso(row.created_at),
  };
}

export interface OrderListItem {
  order_id: string;
  table_id: string;
  status: string;
  created_at: string;
  items: Array<{
    menu_item_id: string;
    name: string;
    quantity: number;
    request_note: string;
    allergy_note: string;
    /** Frozen at fire time — see sql/004_hardening.sql. */
    unit_price: number;
  }>;
  /** Bill frozen at fire time (sql/004_hardening.sql). */
  total: number;
}

/* E16 — GET /api/v1/orders?table_token=… (tracker bootstrap + history). */
export async function listOrders(params: {
  table_token: string;
  page: number;
  limit: number;
}): Promise<{ data: OrderListItem[]; meta: PageMeta }> {
  const tableRes = await pool.query<{ id: string }>(
    "SELECT id FROM restaurant_tables WHERE code = $1 AND deleted_at IS NULL",
    [params.table_token],
  );
  const table = tableRes.rows[0];
  if (!table) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
  }

  const countRes = await pool.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM orders WHERE table_id = $1",
    [table.id],
  );

  const rows = await pool.query<{
    order_id: string;
    table_id: string;
    status: string;
    created_at: Date;
    total: string;
    items: OrderListItem["items"];
  }>(
    `SELECT o.id AS order_id,
            o.table_id,
            o.status,
            o.created_at,
            o.total,
            COALESCE(
              (
                SELECT jsonb_agg(
                         jsonb_build_object(
                           'menu_item_id', oi.menu_item_id,
                           'name',         mi.name,
                           'quantity',      oi.quantity,
                           'request_note',  oi.request_note,
                           'allergy_note',  oi.allergy_note,
                           -- price CHARGED at fire time, not today's menu
                           -- price: a re-priced dish must not rewrite an
                           -- old ticket's bill (sql/004_hardening.sql)
                           'unit_price',    oi.unit_price
                         )
                         ORDER BY oi.id
                       )
                  FROM order_items oi
                  JOIN menu_items mi ON mi.id = oi.menu_item_id
                 WHERE oi.order_id = o.id
              ),
              '[]'::jsonb
            ) AS items
       FROM orders o
      WHERE o.table_id = $1
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $2 OFFSET $3`,
    [table.id, params.limit, (params.page - 1) * params.limit],
  );

  const data: OrderListItem[] = rows.rows.map((row) => ({
    order_id: row.order_id,
    table_id: row.table_id,
    status: row.status,
    created_at: iso(row.created_at),
    total: Number(row.total ?? 0),
    items: row.items ?? [],
  }));

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}
