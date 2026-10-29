import { Router, raw } from "express";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  archiveMenuItem,
  archiveTable,
  clearTableAsAdmin,
  createMenuItem,
  deactivateTableAsAdmin,
  createTable,
  listAdminMenu,
  listAdminTables,
  regenerateTableToken,
  topSellingAnalytics,
  updateMenuItem,
  updateTableCode,
  updateTableName,
} from "../services/admin.service.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "../services/catalog.service.js";
import {
  MAX_IMAGE_BYTES,
  removeMenuItemImage,
  replaceMenuItemImage,
} from "../services/menu-image.service.js";
import {
  bestSellingDishes,
  dailySalesSummary,
  inventoryStatus,
  listFeedback,
  menuCatalog,
  pendingOrders,
  tableOccupancy,
} from "../services/insights.service.js";
import {
  adminCategoryParamsSchema,
  adminCreateCategorySchema,
  adminCreateMenuItemSchema,
  adminCreateTableSchema,
  adminMenuItemParamsSchema,
  adminTableParamsSchema,
  adminUpdateCategorySchema,
  adminUpdateMenuItemSchema,
  adminUpdateTableCodeSchema,
  adminUpdateTableSchema,
  parseOrThrow,
} from "../validation/schemas.js";

/* Module 5 — the executive console's REST surface.
 *
 *   POST   /api/v1/admin/tables                              create a table
 *   GET    /api/v1/admin/tables                              live table grid
 *   PATCH  /api/v1/admin/tables/:table_id                    rename
 *   PATCH  /api/v1/admin/tables/:table_id/code               repair the table code (empty tables only)
 *   POST   /api/v1/admin/tables/:table_id/regenerate-token   reset QR + session
 *   POST   /api/v1/admin/tables/:table_id/clear              override a staff clear
 *   POST   /api/v1/admin/tables/:table_id/deactivate         close the table now, unconditionally
 *   DELETE /api/v1/admin/tables/:table_id                    archive
 *
 *   GET    /api/v1/admin/menu                                full live catalog
 *   POST   /api/v1/admin/menu                                add a dish
 *   PATCH  /api/v1/admin/menu/:menu_item_id                  edit a dish
 *   DELETE /api/v1/admin/menu/:menu_item_id                  archive a dish
 *   POST   /api/v1/admin/menu/:menu_item_id/image            upload/replace a photo
 *   DELETE /api/v1/admin/menu/:menu_item_id/image            remove a photo
 *
 *   GET    /api/v1/admin/categories                          catalogue folders
 *   POST   /api/v1/admin/categories                          create a folder
 *   PATCH  /api/v1/admin/categories/:category_id             rename/move/cover
 *   DELETE /api/v1/admin/categories/:category_id             archive an empty folder
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

/* Correcting the code a QR stand was printed with. A separate path from the
   rename PATCH because it carries its own rule: the table must be empty. */
adminRouter.patch("/tables/:table_id/code", async (req, res) => {
  const params = parseOrThrow(adminTableParamsSchema, req.params);
  const body = parseOrThrow(adminUpdateTableCodeSchema, req.body);
  const data = await updateTableCode(params.table_id, body);
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

/* The manager's unconditional "stop this table". */
adminRouter.post("/tables/:table_id/deactivate", async (req, res) => {
  const params = parseOrThrow(adminTableParamsSchema, req.params);
  const data = await deactivateTableAsAdmin(params.table_id);
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

// ---- Catalogue folders -----------------------------------------------

adminRouter.get("/categories", async (_req, res) => {
  const data = await listCategories();
  res.status(200).json({ success: true, data });
});

adminRouter.post("/categories", async (req, res) => {
  const body = parseOrThrow(adminCreateCategorySchema, req.body);
  const data = await createCategory(body);
  res.status(201).json({ success: true, data });
});

adminRouter.patch("/categories/:category_id", async (req, res) => {
  const params = parseOrThrow(adminCategoryParamsSchema, req.params);
  const body = parseOrThrow(adminUpdateCategorySchema, req.body);
  const data = await updateCategory(params.category_id, body);
  res.status(200).json({ success: true, data });
});

adminRouter.delete("/categories/:category_id", async (req, res) => {
  const params = parseOrThrow(adminCategoryParamsSchema, req.params);
  const data = await deleteCategory(params.category_id);
  res.status(200).json({ success: true, data });
});

// ---- Dish photos ------------------------------------------------------

/* The body IS the file, with its own Content-Type — no multipart envelope.
   That keeps the handler free of a form parser and makes the 8 MB ceiling a
   property of the route itself. What lands in `req.body` is untrusted bytes;
   the service sniffs the magic number before sharp ever touches it. */
adminRouter.post(
  "/menu/:menu_item_id/image",
  raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
  async (req, res) => {
    const params = parseOrThrow(adminMenuItemParamsSchema, req.params);

    if (!Buffer.isBuffer(req.body)) {
      throw new AppError(
        415,
        "INVALID_IMAGE",
        "Send the image file itself as the request body.",
      );
    }

    const data = await replaceMenuItemImage(
      params.menu_item_id,
      req.body,
      String(req.headers["content-type"] ?? ""),
    );
    res.status(200).json({ success: true, data });
  },
);

adminRouter.delete("/menu/:menu_item_id/image", async (req, res) => {
  const params = parseOrThrow(adminMenuItemParamsSchema, req.params);
  const data = await removeMenuItemImage(params.menu_item_id);
  res.status(200).json({ success: true, data });
});

// ---- Analytics -------------------------------------------------------

adminRouter.get("/analytics/top-selling", async (_req, res) => {
  const data = await topSellingAnalytics();
  res.status(200).json({ success: true, data });
});

/* ---- Console insights (Module 6) -------------------------------------
 *
 * The reads behind the manager console's assistant. They sit on the SAME
 * router, so requireAuth + requireRole("admin") already applies: a diner
 * table token cannot reach them and a kitchen/floor shift token gets 403.
 *
 * Query parameters are clamped here rather than trusted: `days` and `limit`
 * come from a language model, and an unbounded window would scan the whole
 * rollup table on a demo box. */

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

adminRouter.get("/insights/sales", async (_req, res) => {
  const data = await dailySalesSummary();
  res.status(200).json({ success: true, data });
});

adminRouter.get("/insights/best-selling", async (req, res) => {
  const days = clampInt(req.query.days, 1, 1, 90);
  const limit = clampInt(req.query.limit, 5, 1, 20);
  const data = await bestSellingDishes(limit, days);
  res.status(200).json({ success: true, data: { days, limit, items: data } });
});

adminRouter.get("/insights/pending-orders", async (_req, res) => {
  const data = await pendingOrders();
  res.status(200).json({ success: true, data: { count: data.length, orders: data } });
});

adminRouter.get("/insights/tables", async (_req, res) => {
  const data = await tableOccupancy();
  res.status(200).json({ success: true, data });
});

adminRouter.get("/insights/inventory", async (_req, res) => {
  const data = await inventoryStatus();
  res.status(200).json({ success: true, data });
});

/* The full catalogue with ingredients, allergens, spice and diet tags, so the
   console can answer "what's in this dish" from data instead of guessing. */
adminRouter.get("/insights/menu", async (_req, res) => {
  const data = await menuCatalog();
  res.status(200).json({ success: true, data: { count: data.length, items: data } });
});

adminRouter.get("/insights/feedback", async (req, res) => {
  const limit = clampInt(req.query.limit, 10, 1, 50);
  const data = await listFeedback(limit);
  res.status(200).json({ success: true, data: { count: data.length, feedback: data } });
});

/* The assistant's own key, released to an ADMIN session only. It is the same
   restricted key the diner side hands out with a table grant; this endpoint
   exists so the console can voice-answer without a table session. */
adminRouter.get("/assistant/key", (_req, res) => {
  res.status(200).json({ success: true, data: { gemini_api_key: env.geminiApiKey } });
});
