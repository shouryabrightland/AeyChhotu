import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  advanceStatus,
  armShift,
  denyTicket,
  listTickets,
  pruneTicket,
} from "../services/kds.service.js";
import {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
  parseOrThrow,
  shiftActivateSchema,
} from "../validation/schemas.js";

/* Module 3 — every route here sits behind requireAuth (401) then
   requireRole('kitchen') (403) — docs/7 §1.4. */
export const kdsRouter = Router();
kdsRouter.use(requireAuth, requireRole("kitchen"));

// E10 — GET /api/v1/kds/tickets
kdsRouter.get("/tickets", async (req, res) => {
  const query = parseOrThrow(kdsTicketsQuerySchema, req.query);
  const { data, meta } = await listTickets(query);
  res.status(200).json({ success: true, data, meta });
});

// E11 — PATCH /api/v1/kds/tickets/:order_id/status
kdsRouter.patch("/tickets/:order_id/status", async (req, res) => {
  const params = parseOrThrow(orderParamsSchema, req.params);
  const body = parseOrThrow(orderStatusSchema, req.body);
  const data = await advanceStatus(params.order_id, body.status);
  res.status(200).json({ success: true, data });
});

/* PATCH /api/v1/kds/tickets/:order_id/deny — refuse a ticket with a reason.
   Valid from pending, preparing AND ready; a dish can run out at any point
   before it reaches the table. */
kdsRouter.patch("/tickets/:order_id/deny", async (req, res) => {
  const params = parseOrThrow(orderParamsSchema, req.params);
  const body = parseOrThrow(denyTicketSchema, req.body);
  const data = await denyTicket(params.order_id, body.reason);
  res.status(200).json({ success: true, data });
});

// E12 — PATCH /api/v1/kds/tickets/:order_id/prune
kdsRouter.patch("/tickets/:order_id/prune", async (req, res) => {
  const params = parseOrThrow(orderParamsSchema, req.params);
  const data = await pruneTicket(params.order_id);
  res.status(200).json({ success: true, data });
});

// E13 — POST /api/v1/kds/shift/activate
kdsRouter.post("/shift/activate", async (req, res) => {
  const body = parseOrThrow(shiftActivateSchema, req.body);
  const data = await armShift(body.device_id);
  res.status(200).json({ success: true, data });
});
