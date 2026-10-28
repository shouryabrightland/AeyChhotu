import { Router } from "express";
import {
  dismissDeniedOrder,
  fireOrder,
  getOrderStatus,
  listOrders,
  requeueDeniedOrder,
} from "../services/orders.service.js";
import {
  fireSchema,
  orderStatusParamsSchema,
  orderStatusQuerySchema,
  ordersListQuerySchema,
  parseOrThrow,
} from "../validation/schemas.js";

/* Module 2 E8 (fire) + Module 4 E15 (status poll) / E16 (history). */
export const ordersRouter = Router();

// E8 — POST /api/v1/orders/fire (atomic inside fire_order())
ordersRouter.post("/fire", async (req, res) => {
  const body = parseOrThrow(fireSchema, req.body);
  const data = await fireOrder(body.table_token);
  res.status(201).json({ success: true, data });
});

// E16 — GET /api/v1/orders?table_token=…
ordersRouter.get("/", async (req, res) => {
  const query = parseOrThrow(ordersListQuerySchema, req.query);
  const { data, meta } = await listOrders(query);
  res.status(200).json({ success: true, data, meta });
});

// E15 — GET /api/v1/orders/:order_id/status?table_token=…
// The table_token is required and enforced in SQL (WHERE id AND table_id):
// an order id alone must not be able to read another table's ticket.
ordersRouter.get("/:order_id/status", async (req, res) => {
  const params = parseOrThrow(orderStatusParamsSchema, req.params);
  const query = parseOrThrow(orderStatusQuerySchema, req.query);
  const data = await getOrderStatus(params.order_id, query.table_token);
  res.status(200).json({ success: true, data });
});

/* POST /api/v1/orders/:order_id/requeue?table_token=…
   The diner's "Move to list" (and the second half of "Retry"): the denied
   round's still-available lines go back into the shared cart for editing and
   the refused ticket is removed. Scoped to the caller's table like E15. */
ordersRouter.post("/:order_id/requeue", async (req, res) => {
  const params = parseOrThrow(orderStatusParamsSchema, req.params);
  const query = parseOrThrow(orderStatusQuerySchema, req.query);
  const data = await requeueDeniedOrder(params.order_id, query.table_token);
  res.status(200).json({ success: true, data });
});

/* POST /api/v1/orders/:order_id/dismiss?table_token=…
   The diner's "Cancel": only a denied round may be discarded, and it is
   removed outright because it was never cooked or billed. */
ordersRouter.post("/:order_id/dismiss", async (req, res) => {
  const params = parseOrThrow(orderStatusParamsSchema, req.params);
  const query = parseOrThrow(orderStatusQuerySchema, req.query);
  const data = await dismissDeniedOrder(params.order_id, query.table_token);
  res.status(200).json({ success: true, data });
});
