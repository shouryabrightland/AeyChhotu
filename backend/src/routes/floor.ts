import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  clearFloorTable,
  listFloorTables,
  notifyAdminForTable,
  requestServe,
  settleTableBill,
} from "../services/floor.service.js";
import {
  floorClearSchema,
  floorQuerySchema,
  floorTableParamsSchema,
  parseOrThrow,
} from "../validation/schemas.js";

/* Module 4 — E17 GET /api/v1/floor/tables (staff-gated Floor View feed)
   plus the settle/notify/clear actions on one table.

   Settling is a staff action, not an admin one: the server holding the card
   reader is the person who knows the bill was actually paid.

   ROLE: these routes accept BOTH `floor` and `kitchen`. The Floor surface is
   normally unlocked with the floor role, and requiring `kitchen` here meant a
   waiter could see the room but every button (take payment, notify a
   manager, clear an abandoned table) answered 403. The two shifts are
   different jobs, not different trust levels for the floor; the admin
   override stays behind `admin`. */
export const floorRouter = Router();
const FLOOR_ROLES = ["floor", "kitchen"] as const;

/* The floor feed is a STAFF read (docs/14 #13): it carries every table's
   order lines and allergy notes, so a valid token of the wrong role — e.g. a
   manager token — must not be able to read the room. Same roles as the
   actions below. */
floorRouter.get("/tables", requireAuth, requireRole(...FLOOR_ROLES), async (req, res) => {
  const query = parseOrThrow(floorQuerySchema, req.query);
  const { data, meta } = await listFloorTables(query);
  res.status(200).json({ success: true, data, meta });
});

floorRouter.patch(
  "/tables/:table_id/settle",
  requireAuth,
  requireRole(...FLOOR_ROLES),
  async (req, res) => {
    const params = parseOrThrow(floorTableParamsSchema, req.params);
    const data = await settleTableBill(params.table_id);
    res.status(200).json({ success: true, data });
  },
);

/* The explicit "manager, please come" action for an unpaid flagged table. */
floorRouter.post(
  "/tables/:table_id/notify",
  requireAuth,
  requireRole(...FLOOR_ROLES),
  async (req, res) => {
    const params = parseOrThrow(floorTableParamsSchema, req.params);
    const data = await notifyAdminForTable(params.table_id);
    res.status(200).json({ success: true, data });
  },
);

/* "I'll serve this" — tells the KITCHEN a server is carrying the plate over.
   Requires a Ready ticket; the kitchen clears the flag when it serves or
   refuses that ticket. DELETE is the waiter's Release. */
floorRouter.post(
  "/tables/:table_id/serve-request",
  requireAuth,
  requireRole(...FLOOR_ROLES),
  async (req, res) => {
    const params = parseOrThrow(floorTableParamsSchema, req.params);
    const data = await requestServe(params.table_id, true);
    res.status(200).json({ success: true, data });
  },
);

floorRouter.delete(
  "/tables/:table_id/serve-request",
  requireAuth,
  requireRole(...FLOOR_ROLES),
  async (req, res) => {
    const params = parseOrThrow(floorTableParamsSchema, req.params);
    const data = await requestServe(params.table_id, false);
    res.status(200).json({ success: true, data });
  },
);

/* Staff clear a flagged table. An unpaid table is refused with 409
   BILL_UNPAID and an admin alert; the admin route below is the override. */
floorRouter.patch(
  "/tables/:table_id/clear",
  requireAuth,
  requireRole(...FLOOR_ROLES),
  async (req, res) => {
    const params = parseOrThrow(floorTableParamsSchema, req.params);
    const body = parseOrThrow(floorClearSchema, req.body ?? {});
    const data = await clearFloorTable(params.table_id, { force: body.force });
    res.status(200).json({ success: true, data });
  },
);
