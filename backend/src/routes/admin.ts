import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  archiveMenuItem,
  archiveTable,
  clearTableAsAdmin,
  createMenuItem,
  createTable,
  listAdminMenu,
  listAdminTables,
  regenerateTableToken,
  topSellingAnalytics,
  updateMenuItem,
  updateTableName,
} from "../services/admin.service.js";
import {
  adminCreateMenuItemSchema,
  adminCreateTableSchema,
  adminMenuItemParamsSchema,
  adminTableParamsSchema,
  adminUpdateMenuItemSchema,
  adminUpdateTableSchema,
  parseOrThrow,
} from "../validation/schemas.js";

/* Module 5 — the executive console's REST surface.
 *
 *   POST   /api/v1/admin/tables                              create a table
 *   GET    /api/v1/admin/tables                              live table grid
 *   PATCH  /api/v1/admin/tables/:table_id                    rename
 *   POST   /api/v1/admin/tables/:table_id/regenerate-token   reset QR + session
 *   POST   /api/v1/admin/tables/:table_id/clear              override a staff clear
 *   DELETE /api/v1/admin/tables/:table_id                    archive
 *
 *   GET    /api/v1/admin/menu                                full live catalog
 *   POST   /api/v1/admin/menu                                add a dish
 *   PATCH  /api/v1/admin/menu/:menu_item_id                  edit a dish
 *   DELETE /api/v1/admin/menu/:menu_item_id                  archive a dish
 *
 *   GET    /api/v1/admin/analytics/top-selling               money + leaderboard
 *
 * Every route lands behind requireAuth (401) and requireRole("admin") (403):
 * a kitchen or floor shift token is a VALID token with the wrong role, which
 * is exactly the distinction the two middlewares draw. The login itself is
 * mounted on /api/v1/auth (see routes/auth.ts) because it is an auth action,
 * not a resource action. */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("admin"));

// ---- Tables ----------------------------------------------------------

adminRouter.get("/tables", async (_req, res) => {
  const data = await listAdminTables();
  res.status(200).json({ success: true, data });
});

adminRouter.post("/tables", async (req, res) => {
  const body = parseOrThrow(adminCreateTableSchema, req.body);
  const data = await createTable(body);
  res.status(201).json({ success: true, data });
});

adminRouter.patch("/tables/:table_id", async (req, res) => {
  const params = parseOrThrow(adminTableParamsSchema, req.params);
  const body = parseOrThrow(adminUpdateTableSchema, req.body);
  const data = await updateTableName(params.table_id, body);
  res.status(200).json({ success: true, data });
});

adminRouter.post("/tables/:table_id/regenerate-token", async (req, res) => {
  const params = parseOrThrow(adminTableParamsSchema, req.params);
  const data = await regenerateTableToken(params.table_id);
  res.status(200).json({ success: true, data });
});

/* Confirming a staff clear-request for an unpaid table. This is the only
   path that can clear a table with money owed. */
adminRouter.post("/tables/:table_id/clear", async (req, res) => {
  const params = parseOrThrow(adminTableParamsSchema, req.params);
  const data = await clearTableAsAdmin(params.table_id);
  res.status(200).json({ success: true, data });
});

adminRouter.delete("/tables/:table_id", async (req, res) => {
  const params = parseOrThrow(adminTableParamsSchema, req.params);
  const data = await archiveTable(params.table_id);
  res.status(200).json({ success: true, data });
});

// ---- Menu catalog ----------------------------------------------------

adminRouter.get("/menu", async (_req, res) => {
  const data = await listAdminMenu();
  res.status(200).json({ success: true, data });
});

adminRouter.post("/menu", async (req, res) => {
  const body = parseOrThrow(adminCreateMenuItemSchema, req.body);
  const data = await createMenuItem(body);
  res.status(201).json({ success: true, data });
});

adminRouter.patch("/menu/:menu_item_id", async (req, res) => {
  const params = parseOrThrow(adminMenuItemParamsSchema, req.params);
  const body = parseOrThrow(adminUpdateMenuItemSchema, req.body);
  const data = await updateMenuItem(params.menu_item_id, body);
  res.status(200).json({ success: true, data });
});

adminRouter.delete("/menu/:menu_item_id", async (req, res) => {
  const params = parseOrThrow(adminMenuItemParamsSchema, req.params);
  const data = await archiveMenuItem(params.menu_item_id);
  res.status(200).json({ success: true, data });
});

// ---- Analytics -------------------------------------------------------

adminRouter.get("/analytics/top-selling", async (_req, res) => {
  const data = await topSellingAnalytics();
  res.status(200).json({ success: true, data });
});
