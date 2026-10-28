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
  /** Why the kitchen refused this round; '' for every other status. */
  denial_reason: string;
  items: Array<{
    menu_item_id: string;
    name: string;
    quantity: number;
    request_note: string;
    allergy_note: string;
    /** Who put it in the cart — copied onto the ticket by fire_order(). */
    added_by: string;
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
    denial_reason: string;
    total: string;
    items: OrderListItem["items"];
  }>(
    `SELECT o.id AS order_id,
            o.table_id,
            o.status,
            o.created_at,
            o.denial_reason,
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
                           -- attribution copied off the cart at fire time
                           'added_by',     oi.added_by,
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
    denial_reason: row.denial_reason ?? "",
    total: Number(row.total ?? 0),
    items: row.items ?? [],
  }));

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}

/* ---------------------------------------------------------------------
   Order denial (sql/011)
   ---------------------------------------------------------------------
   A round can be refused in two ways, and both must be visible to the
   diner rather than silently disappearing:

     * automatic — staff 86 a dish while a PENDING ticket contains it;
     * manual — the chef refuses an active ticket from the KDS, with a
       reason a human typed.

   A denied ticket keeps its lines, its frozen total and its place in
   history, but it is NOT an active ticket any more (the partial unique
   index from 002 only keys pending/preparing/ready), so the table can fire
   a replacement round immediately. Denied tickets are also excluded from
   "money owed", because nothing was cooked. */

/** Item-name copy the diner reads on the tracker. */
export function denialReasonForSoldOutItem(name: string): string {
  return `Item ${name} went out of stock`;
}

/* Called by E14 (and the admin catalog edit) whenever a dish flips to
   unavailable. Returns how many pending tickets were refused, so the caller
   can report it. Runs as ONE statement: the UPDATE + its EXISTS see the same
   snapshot, and the row count is exactly the number of rounds it stopped. */
export async function denyPendingOrdersForItem(
  menuItemId: string,
  itemName: string,
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `UPDATE orders o
        SET status        = 'denied',
            denial_reason = $2,
            updated_at    = now()
      WHERE o.status = 'pending'
        AND EXISTS (
              SELECT 1
                FROM order_items oi
               WHERE oi.order_id = o.id
                 AND oi.menu_item_id = $1
            )
      RETURNING o.id`,
    [menuItemId, denialReasonForSoldOutItem(itemName)],
  );

  return res.rowCount ?? 0;
}

export interface RequeuedDeniedOrder {
  order_id: string;
  /** How many lines went back into the shared cart. */
  moved: number;
  /** Names the cart could not take because the kitchen has none left. */
  omitted: string[];
}

/* POST /api/v1/orders/:order_id/requeue — "Move to list" / the second half
   of "Retry".

   The denied round is dismantled atomically: every line that is still
   available is merged back into the table's shared cart (same upsert key as
   E5, so two guests requeueing at once cannot fork duplicate lines), lines
   the kitchen no longer has are reported instead of silently added, and the
   denied ticket is removed. Removing it is correct here — it was never
   cooked, so it is not sales history, and leaving it behind would make the
   tracker keep showing a round the guest already re-ordered.

   `quantity` is clamped to the cart's 1..99 CHECK with LEAST() rather than
   letting a merge overflow the constraint and fail the whole requeue. */
export async function requeueDeniedOrder(
  orderId: string,
  tableToken: string,
): Promise<RequeuedDeniedOrder> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const found = await client.query<{ id: string; table_id: string; status: string }>(
      `SELECT o.id, o.table_id, o.status
         FROM orders o
         JOIN restaurant_tables t ON t.id = o.table_id
        WHERE o.id = $1
          AND t.code = $2
          AND t.deleted_at IS NULL
          FOR UPDATE OF o`,
      [orderId, tableToken],
    );

    const order = found.rows[0];
    if (!order) {
      throw new AppError(404, "ORDER_NOT_FOUND", "That order no longer exists.");
    }
    if (order.status !== "denied") {
      throw new AppError(
        409,
        "ORDER_NOT_DENIED",
        "Only a denied order can be moved back to the cart.",
        { current_status: order.status },
      );
    }

    const lines = await client.query<{
      menu_item_id: string;
      name: string;
      quantity: number;
      request_note: string;
      allergy_note: string;
      added_by: string;
      is_available: boolean;
    }>(
      `SELECT oi.menu_item_id,
              mi.name,
              oi.quantity,
              oi.request_note,
              oi.allergy_note,
              oi.added_by,
              mi.is_available
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
        WHERE oi.order_id = $1
        ORDER BY oi.id`,
      [orderId],
    );

    const available = lines.rows.filter((line) => line.is_available);
    const omitted = lines.rows
      .filter((line) => !line.is_available)
      .map((line) => line.name);

    /* Nothing can be moved: keep the denied ticket exactly where the diner
       can still read WHY it was refused. Deleting it here would erase the
       only explanation on screen for a round that never happened. */
    if (available.length === 0) {
      await client.query("ROLLBACK");
      committed = true;
      return { order_id: orderId, moved: 0, omitted };
    }

    for (const line of available) {
      await client.query(
        `INSERT INTO cart_items (table_id, menu_item_id, quantity, request_note, allergy_note, added_by)
              VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (table_id, menu_item_id, request_note, allergy_note)
           DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, 99),
                         added_by = EXCLUDED.added_by`,
        [
          order.table_id,
          line.menu_item_id,
          line.quantity,
          line.request_note,
          line.allergy_note,
          line.added_by,
        ],
      );
    }

    await client.query("DELETE FROM orders WHERE id = $1", [orderId]);

    await client.query("COMMIT");
    committed = true;

    return { order_id: orderId, moved: available.length, omitted };
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface DismissedDeniedOrder {
  order_id: string;
  dismissed: true;
}

/* POST /api/v1/orders/:order_id/dismiss — the diner's "Cancel".

   A denied round never reached the kitchen, so discarding it deletes the
   row outright instead of inventing a sixth status or marking it served
   (which would inflate revenue, since analytics only counts served orders).
   Only a DENIED order can be dismissed: a real ticket must stay in history. */
export async function dismissDeniedOrder(
  orderId: string,
  tableToken: string,
): Promise<DismissedDeniedOrder> {
  const found = await pool.query<{ id: string; status: string }>(
    `SELECT o.id, o.status
       FROM orders o
       JOIN restaurant_tables t ON t.id = o.table_id
      WHERE o.id = $1
        AND t.code = $2
        AND t.deleted_at IS NULL`,
    [orderId, tableToken],
  );

  const order = found.rows[0];
  if (!order) {
    throw new AppError(404, "ORDER_NOT_FOUND", "That order no longer exists.");
  }
  if (order.status !== "denied") {
    throw new AppError(
      409,
      "ORDER_NOT_DENIED",
      "Only a denied order can be discarded.",
      { current_status: order.status },
    );
  }

  await pool.query("DELETE FROM orders WHERE id = $1 AND status = 'denied'", [orderId]);

  return { order_id: orderId, dismissed: true };
}
