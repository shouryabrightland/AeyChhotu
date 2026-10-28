import { Router } from "express";
import { AppError } from "../errors/app-error.js";
import { listPublicCategories } from "../services/catalog.service.js";
import { readMenuItemImage } from "../services/menu-image.service.js";
import { listMenu, setAvailability } from "../services/menu.service.js";
import {
  availabilitySchema,
  menuImageParamsSchema,
  menuItemParamsSchema,
  menuQuerySchema,
  parseOrThrow,
} from "../validation/schemas.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

/* Module 2 E3 (live menu, public) + Module 4 E14 (86ing, staff). */
export const menuRouter = Router();

// E3 — GET /api/v1/menu?table_token=…
menuRouter.get("/", async (req, res) => {
  const query = parseOrThrow(menuQuerySchema, req.query);
  const { data, meta } = await listMenu(query);
  res.status(200).json({ success: true, data, meta });
});

/* GET /api/v1/menu/items/:menu_item_id/image/:size — a dish photo.

   Public on purpose: it is the same picture a diner sees on the card, and a
   signed URL would force every <img> through auth for no privacy gain. Keys
   change on every replacement, so the immutable cache is safe. */
menuRouter.get("/items/:menu_item_id/image/:size", async (req, res) => {
  const params = parseOrThrow(menuImageParamsSchema, req.params);
  const image = await readMenuItemImage(params.menu_item_id, params.size);

  if (!image) {
    throw new AppError(404, "IMAGE_NOT_FOUND", "No photo for this dish.");
  }

  res.setHeader("Content-Type", image.contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Length", String(image.bytes.length));
  res.status(200).send(image.bytes);
});

/* GET /api/v1/categories — the folder tree, names only. The diner app uses it
   to render nested sections without pulling the admin catalogue. */
menuRouter.get("/categories", async (_req, res) => {
  const data = await listPublicCategories();
  res.status(200).json({ success: true, data });
});

// E14 — PATCH /api/v1/menu/items/:menu_item_id/availability
// (administrative change: requireAuth → 401, requireRole → 403)
menuRouter.patch("/items/:menu_item_id/availability", requireAuth, requireRole("kitchen"), async (req, res) => {
  const params = parseOrThrow(menuItemParamsSchema, req.params);
  const body = parseOrThrow(availabilitySchema, req.body);
  const data = await setAvailability(params.menu_item_id, body.is_available);
  res.status(200).json({ success: true, data });
});
