import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { buildMeta, iso, type PageMeta } from "../lib/util.js";
import {
  checkAndAutoReleaseTable,
  clearTableSession,
  type BillStatus,
} from "./sessions.service.js";

/* Module 4 — E17 GET /api/v1/floor/tables (Floor View summary) and the
   settle action that takes payment and hands the table to auto-release. */

/* A table is FLAGGED for staff when its session looks abandoned:

     status = 'active'          someone claimed this table,
     bill_status = 'unrequested' no payment conversation is in progress,
     no open order               nothing is being cooked or run, and
     no device in 2 minutes      every phone that claimed it has gone.

   Two minutes (not the 45 s release window) is deliberate: this flag asks a
   server to walk over and check, so it should tolerate a phone that slept or
   briefly lost Wi-Fi. Release still uses the stricter 45 s rule. */
export const FLOOR_STALE_DEVICE_WINDOW_SECONDS = 120;

export interface FloorTable {
  table_id: string;
  code: string;
  name: string;
  status: string;
  /** 'unrequested' | 'requested' | 'paid' — the floor board's bill banner. */
  bill_status: BillStatus;
  /** Set when a staff clear was refused for an unpaid bill. */
  clear_requested_at: string | null;
  active_order: {
    order_id: string;
    status: string;
    created_at: string;
    /** Ticket lines, same shape as E10 — lets the floor card surface allergy
        alerts without a second round trip. */
    items: Array<{
      menu_item_id: string;
      name: string;
      quantity: number;
      request_note: string;
      allergy_note: string;
      /** Frozen at fire time — see sql/004_hardening.sql. */
      unit_price: number;
    }>;
  } | null;
  cart_line_count: number;
  /** Devices with a heartbeat inside the stale-detection window. */
  active_devices: number;
  /** Active session with no device, no open order and no bill request. */
  needs_attention: boolean;
}

export async function listFloorTables(params: {
  page: number;
  limit: number;
}): Promise<{ data: FloorTable[]; meta: PageMeta }> {
  /* Archived tables (006) are off the floor: nobody can scan them any more,
     so keeping their cards on the board would be noise a server has to learn
     to ignore. */
  const countRes = await pool.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM restaurant_tables WHERE deleted_at IS NULL",
  );

  const rows = await pool.query<{
    table_id: string;
    code: string;
    name: string;
    status: string;
    bill_status: BillStatus;
    clear_requested_at: Date | null;
    active_order: FloorTable["active_order"];
    cart_line_count: number;
    active_devices: number;
  }>(
    `SELECT t.id AS table_id,
            t.code,
            t.name,
            t.status,
            t.bill_status,
            t.clear_requested_at,
            (
              SELECT jsonb_build_object(
                       'order_id',   o.id,
                       'status',     o.status,
                       'created_at', to_jsonb(o.created_at),
                       'items',      COALESCE(
                         (
                           SELECT jsonb_agg(
                                    jsonb_build_object(
                                      'menu_item_id', oi.menu_item_id,
                                      'name',         mi.name,
                                      'quantity',     oi.quantity,
                                      'request_note', oi.request_note,
                                      'allergy_note', oi.allergy_note,
                                      -- price charged at fire time (sql/004_hardening.sql)
                                      'unit_price',   oi.unit_price
                                    )
                                    ORDER BY oi.id
                                  )
                             FROM order_items oi
                             JOIN menu_items mi ON mi.id = oi.menu_item_id
                            WHERE oi.order_id = o.id
                         ),
                         '[]'::jsonb
                       )
                     )
                FROM orders o
               WHERE o.table_id = t.id
                 AND o.status IN ('pending', 'preparing', 'ready')
               ORDER BY o.created_at DESC
               LIMIT 1
            ) AS active_order,
            (
              SELECT count(*)::int FROM cart_items ci WHERE ci.table_id = t.id
            ) AS cart_line_count,
            (
              SELECT count(*)::int
                FROM table_device_presence p
               WHERE p.table_id = t.id
                 AND p.last_seen > now() - ($3 || ' seconds')::interval
            ) AS active_devices
       FROM restaurant_tables t
      WHERE t.deleted_at IS NULL
      ORDER BY t.code
      LIMIT $1 OFFSET $2`,
    [params.limit, (params.page - 1) * params.limit, FLOOR_STALE_DEVICE_WINDOW_SECONDS],
  );

  const data: FloorTable[] = rows.rows.map((row) => {
    const activeOrder = row.active_order
      ? {
          order_id: row.active_order.order_id,
          status: row.active_order.status,
          created_at: iso(row.active_order.created_at),
          items: row.active_order.items ?? [],
        }
      : null;

    return {
      table_id: row.table_id,
      code: row.code,
      name: row.name,
      status: row.status,
      bill_status: row.bill_status,
      clear_requested_at: row.clear_requested_at ? iso(row.clear_requested_at) : null,
      active_order: activeOrder,
      cart_line_count: row.cart_line_count,
      active_devices: row.active_devices,
      needs_attention:
        row.status === "active" &&
        row.bill_status === "unrequested" &&
        activeOrder === null &&
        row.active_devices === 0,
    };
  });

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}

/* PATCH /api/v1/floor/tables/:table_id/settle.
   Taking payment records 'paid' and then asks the release engine whether
   the table is also empty and device-free. The response tells the floor
   whether the table was cleared in this call, so the card can stop showing
   the bill banner immediately. */
export interface SettleTableResult {
  table_id: string;
  bill_status: "paid";
  bill_paid_at: string;
  released: boolean;
}

export async function settleTableBill(tableId: string): Promise<SettleTableResult> {
  const paid = await pool.query<{
    id: string;
    bill_status: "paid";
    bill_paid_at: Date;
  }>(
    `UPDATE restaurant_tables
        SET bill_status  = 'paid',
            bill_paid_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, bill_status, bill_paid_at`,
    [tableId],
  );

  const row = paid.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table id parsed.");
  }

  const { released } = await checkAndAutoReleaseTable(tableId);

  return {
    table_id: row.id,
    bill_status: "paid",
    bill_paid_at: iso(row.bill_paid_at),
    released,
  };
}

/* PATCH /api/v1/floor/tables/:table_id/clear.

   Staff clear a flagged table directly when nothing is owed. If this
   session has a ticket and its bill is not marked paid, the clear is
   refused and `clear_requested_at` is stamped — that column is the alert
   the manager console renders, and the manager's own clear is the only one
   that can override it. Older served tickets are history, not this party's
   debt. */
export interface ClearFloorTableResult {
  table_id: string;
  cleared: true;
  bill_status: BillStatus;
}

export async function clearFloorTable(tableId: string): Promise<ClearFloorTableResult> {
  const result = await clearTableSession(tableId, { allowUnpaid: false });

  if (result.outcome === "not_found") {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table id parsed.");
  }

  if (result.outcome === "active_orders") {
    throw new AppError(
      409,
      "TABLE_HAS_ACTIVE_ORDERS",
      "This table still has an open ticket. Serve or prune it before clearing the table.",
      { table_id: tableId, active_orders: result.active_orders },
    );
  }

  if (result.outcome === "unpaid") {
    const alert = await pool.query<{ clear_requested_at: Date }>(
      `UPDATE restaurant_tables
          SET clear_requested_at = COALESCE(clear_requested_at, now())
        WHERE id = $1
        RETURNING clear_requested_at`,
      [tableId],
    );
    const requestedAt = alert.rows[0]?.clear_requested_at;

    throw new AppError(
      409,
      "BILL_UNPAID",
      "This table's bill is unpaid. A manager has been alerted and only a manager can clear it.",
      {
        table_id: tableId,
        admin_required: true,
        clear_requested_at: requestedAt ? iso(requestedAt) : null,
      },
    );
  }

  return { table_id: tableId, cleared: true, bill_status: result.bill_status ?? "paid" };
}
