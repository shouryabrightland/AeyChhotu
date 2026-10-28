import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { buildMeta, iso, type PageMeta } from "../lib/util.js";

/* Module 3 — Kitchen Display System (E10 tickets, E11 status machine,
   E12 prune, E13 shift activation). All callers are staff-gated by the
   requireStaff middleware before reaching this layer. */

export interface KdsTicket {
  order_id: string;
  table: { id: string; code: string; name: string };
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
}

/* E10 — GET /api/v1/kds/tickets (active columns; served tickets pruned). */
export async function listTickets(params: {
  status?: string;
  page: number;
  limit: number;
}): Promise<{ data: KdsTicket[]; meta: PageMeta }> {
  const args: unknown[] = [];
  let where = "o.status <> 'served'";
  if (params.status) {
    args.push(params.status);
    where = `o.status = $${args.length}`;
  }

  const countRes = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM orders o WHERE ${where}`,
    args,
  );

  args.push(params.limit, (params.page - 1) * params.limit);
  const rows = await pool.query<{
    order_id: string;
    status: string;
    created_at: Date;
    table: { id: string; code: string; name: string };
    items: KdsTicket["items"];
  }>(
    `SELECT o.id AS order_id,
            o.status,
            o.created_at,
            jsonb_build_object('id', t.id, 'code', t.code, 'name', t.name) AS "table",
            COALESCE(
              (
                SELECT jsonb_agg(
                         jsonb_build_object(
                           'menu_item_id', oi.menu_item_id,
                           'name',         mi.name,
                           'quantity',      oi.quantity,
                           'request_note',  oi.request_note,
                           'allergy_note',  oi.allergy_note,
                           -- price charged at fire time (sql/004_hardening.sql)
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
       JOIN restaurant_tables t ON t.id = o.table_id
      WHERE ${where}
      ORDER BY o.created_at, o.id
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );

  const data: KdsTicket[] = rows.rows.map((row) => ({
    order_id: row.order_id,
    table: row.table,
    status: row.status,
    created_at: iso(row.created_at),
    items: row.items ?? [],
  }));

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}

const NEXT_STATUS: Record<string, string> = { preparing: "pending", ready: "preparing" };

/* E11 — PATCH /api/v1/kds/tickets/:order_id/status.
   Sequential state machine enforced by a conditional UPDATE (single
   atomic statement): pending→preparing→ready; served comes only from E12. */
export async function advanceStatus(orderId: string, target: "preparing" | "ready") {
  const from = NEXT_STATUS[target];

  const updated = await pool.query<{ id: string; status: string }>(
    `UPDATE orders
        SET status = $1, updated_at = now()
      WHERE id = $2 AND status = $3
      RETURNING id, status`,
    [target, orderId, from],
  );

  const row = updated.rows[0];
  if (row) {
    return { order_id: row.id, status: row.status };
  }

  const current = await pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [
    orderId,
  ]);
  const currentRow = current.rows[0];
  if (!currentRow) {
    throw new AppError(404, "ORDER_NOT_FOUND", "That ticket no longer exists.");
  }

  throw new AppError(
    409,
    "INVALID_STATUS_TRANSITION",
    `Ticket cannot move from ${currentRow.status} to ${target}.`,
    { current_status: currentRow.status, requested_status: target },
  );
}

/* E12 — PATCH /api/v1/kds/tickets/:order_id/prune.
   One transaction: serve the ticket (only valid from 'ready'), then flag
   the parent table 'empty' when its last active order is gone. */
export async function pruneTicket(orderId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query<{ id: string; table_id: string; status: string }>(
      "SELECT id, table_id, status FROM orders WHERE id = $1 FOR UPDATE",
      [orderId],
    );
    const order = current.rows[0];
    if (!order) {
      throw new AppError(404, "ORDER_NOT_FOUND", "That ticket no longer exists.");
    }
    if (order.status !== "ready") {
      throw new AppError(
        409,
        "INVALID_STATUS_TRANSITION",
        `Ticket cannot be pruned from ${order.status}; only Ready tickets can be served.`,
        { current_status: order.status, requested_status: "served" },
      );
    }

    await client.query("UPDATE orders SET status = 'served', updated_at = now() WHERE id = $1", [
      orderId,
    ]);

    const active = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM orders WHERE table_id = $1 AND status <> 'served'",
      [order.table_id],
    );
    const tableCleared = (active.rows[0]?.count ?? 0) === 0;
    if (tableCleared) {
      /* Settling the table ENDS its session (sql/005_table_session_security.sql).
         The PIN and the pass are bearer credentials for the guests who were
         sitting here; if they survived, the next party to scan the same QR
         would inherit a session somebody else could still reconnect to. The
         attempt counter goes back to zero with them, so a locked table is
         also unlocked by settling. */
      await client.query(
        `UPDATE restaurant_tables
            SET status              = 'empty',
                session_pin         = NULL,
                session_secret      = NULL,
                failed_pin_attempts = 0,
                session_started_at  = NULL
          WHERE id = $1`,
        [order.table_id],
      );
    }

    await client.query("COMMIT");
    return { order_id: orderId, status: "served", table_cleared: tableCleared };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* E13 — POST /api/v1/kds/shift/activate (in-memory registry per docs/4;
   no table is touched). */
const armedDevices = new Map<string, number>();

export function armShift(deviceId: string) {
  armedDevices.set(deviceId, Date.now());

  // Keep the registry bounded if tablets re-register with fresh ids.
  if (armedDevices.size > 100) {
    const oldest = [...armedDevices.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) armedDevices.delete(oldest[0]);
  }

  return {
    device_id: deviceId,
    audio_armed: true,
    message: "Audio chimes armed for this device. Incoming tickets will ping.",
  };
}
