import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import { buildMeta, iso, type PageMeta } from "../lib/util.js";
import { checkAndAutoReleaseTable } from "./sessions.service.js";

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
    /** Who ordered it — copied off the cart at fire time (sql/011). */
    added_by: string;
    /** Frozen at fire time — see sql/004_hardening.sql. */
    unit_price: number;
  }>;
}

/* E10 — GET /api/v1/kds/tickets (active columns only).
   `status IN (...)` rather than `<> 'served'`:
   a DENIED ticket is closed as well — it must not sit on the line waiting
   for a cook who has already refused it. */
export async function listTickets(params: {
  status?: string;
  page: number;
  limit: number;
}): Promise<{ data: KdsTicket[]; meta: PageMeta }> {
  const args: unknown[] = [];
  let where = "o.status IN ('pending', 'preparing', 'ready')";
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
                           'added_by',      oi.added_by,
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
   Serve the ticket (only valid from 'ready'), then ask the auto-release
   engine whether the table is now free. Serving the last ticket no longer
   clears the table unconditionally: the guests are usually still sitting
   there, and their bill has not necessarily been paid. The table is
   released only when the bill is paid, no tickets remain AND every device
   has disconnected (sql/007_bill_and_auto_release.sql). */
export async function pruneTicket(orderId: string) {
  const client = await pool.connect();
  let committed = false;

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

    await client.query("COMMIT");
    committed = true;

    // Separate transaction: the release engine takes its own FOR UPDATE lock
    // on the table row, which must not be nested inside the ticket lock.
    const { released } = await checkAndAutoReleaseTable(order.table_id);
    return { order_id: orderId, status: "served", table_cleared: released };
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

/* PATCH /api/v1/kds/tickets/:order_id/deny — the kitchen's refusal.

   Available from EVERY active status (pending, preparing, ready): a dish can
   run out before it is started or after it is plated. The reason is
   required — a ticket the diner sees as "denied" with no explanation is
   worse than one that never changed state — and it is stored on the row so
   the tracker can render it without a second read.

   Denial leaves the ticket in history (nothing is deleted) but frees the
   table to fire a replacement round, because the one-active-ticket index
   only covers pending/preparing/ready. The release engine then runs, since
   refusing the last open ticket on a paid, device-free table means the
   table can be handed over. */
export interface DenyTicketResult {
  order_id: string;
  status: "denied";
  denial_reason: string;
  table_cleared: boolean;
}

export async function denyTicket(orderId: string, reason: string): Promise<DenyTicketResult> {
  const denialReason = reason.trim();
  if (!denialReason) {
    throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
      fields: { reason: "Tell the diner why the order was refused." },
    });
  }

  const updated = await pool.query<{ id: string; table_id: string }>(
    `UPDATE orders
        SET status        = 'denied',
            denial_reason = $2,
            updated_at    = now()
      WHERE id = $1
        AND status IN ('pending', 'preparing', 'ready')
      RETURNING id, table_id`,
    [orderId, denialReason],
  );

  const row = updated.rows[0];
  if (!row) {
    const current = await pool.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [orderId],
    );
    const currentStatus = current.rows[0]?.status;
    if (!currentStatus) {
      throw new AppError(404, "ORDER_NOT_FOUND", "That ticket no longer exists.");
    }
    throw new AppError(
      409,
      "INVALID_STATUS_TRANSITION",
      `Ticket cannot be denied from ${currentStatus}.`,
      { current_status: currentStatus, requested_status: "denied" },
    );
  }

  // Separate transaction: the release engine takes its own FOR UPDATE lock on
  // the table row, which must not be nested inside the order UPDATE.
  const { released } = await checkAndAutoReleaseTable(row.table_id);

  return {
    order_id: row.id,
    status: "denied",
    denial_reason: denialReason,
    table_cleared: released,
  };
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
