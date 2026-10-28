import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { clearFloorTable, listFloorTables, settleTableBill } from "../services/floor.service.js";
import {
  floorQuerySchema,
  floorTableParamsSchema,
  parseOrThrow,
} from "../validation/schemas.js";

/* Module 4 — E17 GET /api/v1/floor/tables (staff-gated Floor View feed)
   plus the settle action that takes payment on one table.

   Settling is a staff action, not an admin one: the server holding the card
   reader is the person who knows the bill was actually paid. requireRole
   keeps a manager token from being required for the room's most frequent
   write. */
export const floorRouter = Router();

floorRouter.get("/tables", requireAuth, async (req, res) => {
  const query = parseOrThrow(floorQuerySchema, req.query);
  const { data, meta } = await listFloorTables(query);
  res.status(200).json({ success: true, data, meta });
});

floorRouter.patch(
  "/tables/:table_id/settle",
  requireAuth,
  requireRole("kitchen"),
  async (req, res) => {
    const params = parseOrThrow(floorTableParamsSchema, req.params);
    const data = await settleTableBill(params.table_id);
    res.status(200).json({ success: true, data });
  },
);

/* Staff clear a flagged table. An unpaid table is refused with 409
   BILL_UNPAID and an admin alert; the admin route below is the override. */
floorRouter.patch(
  "/tables/:table_id/clear",
  requireAuth,
  requireRole("kitchen"),
  async (req, res) => {
    const params = parseOrThrow(floorTableParamsSchema, req.params);
    const data = await clearFloorTable(params.table_id);
    res.status(200).json({ success: true, data });
  },
);
