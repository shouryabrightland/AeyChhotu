import { z } from "zod";
import { AppError } from "../errors/app-error.js";

/* Zod schemas for every endpoint (docs/7 §1.7 validation rules).
   Unknown keys are stripped (never rejected) per §1.7. */

const TABLE_TOKEN_RE = /^[a-z0-9]{4,16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tableToken = z.string().regex(TABLE_TOKEN_RE, "Must be a 4-16 character lowercase table token.");
const uuid = (label: string) => z.string().regex(UUID_RE, `Must be a valid ${label} UUID.`);

/** §1.5 pagination — shared by every list endpoint. */
const pagination = {
  page: z.coerce.number().int().min(1, "page must be an integer >= 1.").default(1),
  limit: z.coerce.number().int().min(1, "limit must be between 1 and 100.").max(100, "limit must be between 1 and 100.").default(20),
};

const note = z.string().max(500, "Notes must be 500 characters or fewer.");

// ---- Module 1: Session & Access -------------------------------------

/* When the CLIENT opened the page. The backend refuses a session whose
   scan_time predates restaurant_tables.last_cleared_at (STALE_SESSION), so a
   long-cached page cannot resurrect the previous party's table. Parsed rather
   than pattern-matched: any string Date can read is a valid instant. */
const scanTime = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "scan_time must be an ISO timestamp.")
  .optional();

/* The device identity registered in table_members.

   `name` is REQUIRED on every entry point: an anonymous "Guest" is what used
   to lump several people's dishes onto one split-bill tab and leave the
   kitchen with no name to call at a crowded table. The gate asks for it
   before the first session call, and the roster and every ticket inherit it.
   `user_id` stays optional only for older clients — a payload without one
   joins without a roster row, exactly as before. */
const sessionMember = {
  user_id: z.string().trim().min(1, "user_id cannot be empty.").max(64, "user_id must be 64 characters or fewer.").optional(),
  name: z
    .string()
    .trim()
    .min(1, "name is required — enter your name so the table knows who ordered.")
    .max(40, "name must be 40 characters or fewer."),
};

/** E1 POST /api/v1/sessions/initialize */
export const initializeSchema = z.object({
  table_token: tableToken,
  scan_time: scanTime,
  ...sessionMember,
});

/** E1b POST /api/v1/sessions/join-pin — the 2-digit table PIN.
    '00'–'99' only: the keypad can never produce anything else, so a
    payload that is not exactly two digits is a client bug, not a typo. */
export const joinPinSchema = z.object({
  table_token: tableToken,
  pin: z.string().regex(/^\d{2}$/, "PIN must be exactly two digits (00-99)."),
  scan_time: scanTime,
  ...sessionMember,
});

/** The 20-character pass shared by join-pass and reconnect. */
const tableSecret = z
  .string()
  .regex(/^[A-Za-z0-9]{20}$/, "The table pass must be 20 letters or digits.");

/** E1c POST /api/v1/sessions/join-pass — unlock a flagged table. */
export const joinPassSchema = z.object({
  table_token: tableToken,
  secret: tableSecret,
  scan_time: scanTime,
  ...sessionMember,
});

/** E1d POST /api/v1/sessions/reconnect — a returning device, no keypad. */
export const reconnectSchema = z.object({
  table_token: tableToken,
  secret: tableSecret,
  scan_time: scanTime,
  ...sessionMember,
});

/** E2 POST /api/v1/auth/kds-login.
    `surface` is optional and only feeds the rate limiter: kitchen and floor
    share this endpoint, so each PIN wall gets its own failed-attempt counter
    (docs/14 #18). It never changes the role the server issues. */
export const kdsLoginSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits."),
  surface: z.enum(["kitchen", "floor"]).optional(),
});

/** POST /api/v1/auth/admin-login — the owner/manager PIN (ADMIN_PIN).
    Same shape as the staff PIN, different secret and different role claim. */
export const adminLoginSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits."),
});

/** E9 GET /api/v1/sessions/:table_token/active-check */
export const activeCheckParamsSchema = z.object({ table_token: tableToken });

/** POST /api/v1/sessions/:table_token/bill-request
    DELETE /api/v1/sessions/:table_token/heartbeat — same table-token scope. */
export const sessionTableParamsSchema = z.object({ table_token: tableToken });

/** POST/DELETE /api/v1/sessions/:table_token/heartbeat body. */
export const heartbeatSchema = z.object({
  device_id: z
    .string()
    .trim()
    .min(1, "device_id is required.")
    .max(64, "device_id must be 64 characters or fewer."),
});

// ---- Module 2: Menu & Cart ------------------------------------------

/** E3 GET /api/v1/menu */
export const menuQuerySchema = z.object({
  table_token: tableToken,
  category: z.string().max(80, "Category filter must be 80 characters or fewer.").optional(),
  q: z.string().max(50, "Search query must be 50 characters or fewer.").optional(),
  ...pagination,
});

/** E4 GET /api/v1/cart/items */
export const cartListQuerySchema = z.object({ table_token: tableToken, ...pagination });

/** E5 POST /api/v1/cart/items */
export const cartAddSchema = z.object({
  table_token: tableToken,
  menu_item_id: uuid("menu_item_id"),
  quantity: z.coerce.number().int("quantity must be an integer between 1 and 99.").min(1, "quantity must be an integer between 1 and 99.").max(99, "quantity must be an integer between 1 and 99.").default(1),
  allergy_note: note.optional(),
  request_note: note.optional(),
  /* Who put it in the cart, taken from the name the gate collected. Required:
     an unnamed cart line becomes an unnamed ticket, which is what made the
     split bill read as one anonymous "Guest" tab. */
  added_by: z
    .string()
    .trim()
    .min(1, "added_by is required — a dish must belong to someone at the table.")
    .max(40, "added_by must be 40 characters or fewer."),
});

/** E6 PATCH /api/v1/cart/items/:cart_item_id */
export const cartUpdateSchema = z
  .object({
    table_token: tableToken,
    // Absolute "set to N" (last write wins) — kept for contract compat.
    quantity: z.coerce.number().int("quantity must be an integer between 1 and 99.").min(1, "quantity must be an integer between 1 and 99; use DELETE to remove a line.").max(99, "quantity must be an integer between 1 and 99.").optional(),
    // +/- steppers send a DELTA instead: the server applies it atomically
    // (quantity = quantity + delta), so two phones tapping at once can no
    // longer overwrite each other with stale absolute values.
    quantity_delta: z.coerce
      .number()
      .int("quantity_delta must be a whole number between -99 and 99.")
      .min(-99, "quantity_delta must be between -99 and 99.")
      .max(99, "quantity_delta must be between -99 and 99.")
      .refine((value) => value !== 0, {
        message: "quantity_delta must not be 0; use DELETE to remove a line.",
      })
      .optional(),
    request_note: note.optional(),
    allergy_note: note.optional(),
  })
  .refine(
    (body) =>
      body.quantity !== undefined ||
      body.quantity_delta !== undefined ||
      body.request_note !== undefined ||
      body.allergy_note !== undefined,
    { message: "Provide at least one of quantity, quantity_delta, request_note, allergy_note." },
  );

/** E6 path params */
export const cartItemParamsSchema = z.object({ cart_item_id: uuid("cart_item_id") });

/** E7 DELETE /api/v1/cart/items */
export const cartDeleteSchema = z.object({
  table_token: tableToken,
  cart_item_id: uuid("cart_item_id"),
});

/** E8 POST /api/v1/orders/fire */
export const fireSchema = z.object({ table_token: tableToken });

/** E16 GET /api/v1/orders */
export const ordersListQuerySchema = z.object({ table_token: tableToken, ...pagination });

// ---- Module 3: KDS ---------------------------------------------------

/** E10 GET /api/v1/kds/tickets */
export const kdsTicketsQuerySchema = z.object({
  status: z.enum(["pending", "preparing", "ready"]).optional(),
  ...pagination,
});

/** E11 / E12 path params */
export const orderParamsSchema = z.object({ order_id: uuid("order_id") });

/** E11 PATCH /api/v1/kds/tickets/:order_id/status */
export const orderStatusSchema = z.object({
  status: z.enum(["preparing", "ready"]),
});

/** PATCH /api/v1/kds/tickets/:order_id/deny — the chef's refusal.
    The reason is mandatory and is what the diner's tracker renders. */
export const denyTicketSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Tell the diner why the order was refused.")
    .max(300, "The denial reason must be 300 characters or fewer."),
});

/** E13 POST /api/v1/kds/shift/activate */
export const shiftActivateSchema = z.object({
  device_id: z.string().min(1, "device_id is required.").max(64, "device_id must be 64 characters or fewer."),
});

// ---- Module 4: Floor & availability ----------------------------------

/** E14 PATCH /api/v1/menu/items/:menu_item_id/availability */
export const menuItemParamsSchema = z.object({ menu_item_id: uuid("menu_item_id") });
export const availabilitySchema = z.object({ is_available: z.boolean() });

/** E15 GET /api/v1/orders/:order_id/status — the table_token query is the
    scope check: an order id alone must not be a universal reader. */
export const orderStatusParamsSchema = z.object({ order_id: uuid("order_id") });
export const orderStatusQuerySchema = z.object({ table_token: tableToken });

/** E17 GET /api/v1/floor/tables */
export const floorQuerySchema = z.object({ ...pagination });

/** PATCH /api/v1/floor/tables/:table_id/settle */
export const floorTableParamsSchema = z.object({ table_id: uuid("table_id") });

// ---- Module 5: Executive admin console --------------------------------

/** POST /api/v1/admin/tables */
export const adminCreateTableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the table a name.")
    .max(60, "Table names must be 60 characters or fewer."),
});

/** PATCH /api/v1/admin/tables/:table_id */
export const adminUpdateTableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The table name cannot be empty.")
    .max(60, "Table names must be 60 characters or fewer.")
    .optional(),
});

/** PATCH /api/v1/admin/tables/:table_id/code — repair a table's printed QR
    code. Uppercase is accepted and folded down by the service; the shape is
    the same 5–8 character alphabet every generated code uses. */
export const adminUpdateTableCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{5,8}$/, "Use 5–8 letters or digits, e.g. k7x2p16."),
});

/** Shared path params for the admin table sub-routes. */
export const adminTableParamsSchema = z.object({ table_id: uuid("table_id") });

const adminDishName = z
  .string()
  .trim()
  .min(1, "Give the dish a name.")
  .max(120, "Dish names must be 120 characters or fewer.");

const adminDishPrice = z.coerce
  .number()
  .finite("Price must be a number.")
  .min(0, "Price cannot be negative.")
  .max(1_000_000, "Price is unrealistically high.");

const adminDishCategory = z
  .string()
  .trim()
  .min(1, "Pick a category.")
  .max(80, "Categories must be 80 characters or fewer.");

const adminDishDescription = z
  .string()
  .trim()
  .max(500, "Descriptions must be 500 characters or fewer.");

/** POST /api/v1/admin/menu */
export const adminCreateMenuItemSchema = z.object({
  name: adminDishName,
  price: adminDishPrice,
  /* The folder id is authoritative when supplied; the text label remains for
     clients that predate folders and is resolved to a root folder. */
  category_id: uuid("category_id").nullable().optional(),
  category: adminDishCategory.optional(),
  description: adminDishDescription.default(""),
  vegetarian: z.boolean().default(true),
  is_available: z.boolean().default(true),
});

/* PATCH /api/v1/admin/menu/:menu_item_id — all fields optional, but at least
   one must be present: an empty PATCH is a client bug, not a no-op. */
export const adminUpdateMenuItemSchema = z
  .object({
    name: adminDishName.optional(),
    price: adminDishPrice.optional(),
    category_id: uuid("category_id").nullable().optional(),
    category: adminDishCategory.optional(),
    description: adminDishDescription.optional(),
    vegetarian: z.boolean().optional(),
    is_available: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Provide at least one field to update.",
  });

/** Path params for the admin menu item routes. */
export const adminMenuItemParamsSchema = z.object({ menu_item_id: uuid("menu_item_id") });

/** GET /api/v1/menu/items/:menu_item_id/image/:size — public dish photo. */
export const menuImageParamsSchema = z.object({
  menu_item_id: uuid("menu_item_id"),
  size: z.enum(["original", "small", "tiny"]),
});

/** POST /api/v1/admin/categories */
export const adminCreateCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the folder a name.")
    .max(60, "Folder names must be 60 characters or fewer."),
  parent_id: uuid("parent_id").nullable().optional(),
});

/** PATCH /api/v1/admin/categories/:category_id */
export const adminUpdateCategorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "The folder name cannot be empty.")
      .max(60, "Folder names must be 60 characters or fewer.")
      .optional(),
    parent_id: uuid("parent_id").nullable().optional(),
    sort_order: z.coerce.number().int().min(0).max(100_000).optional(),
    thumbnail_menu_item_id: uuid("thumbnail_menu_item_id").nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Provide at least one field to update.",
  });

/** Path params for the admin category routes. */
export const adminCategoryParamsSchema = z.object({ category_id: uuid("category_id") });

/* Validates a request slice and converts failures into the contract's
   400 VALIDATION_ERROR envelope with per-field messages (docs/7 §1.1). */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    fields[issue.path.length > 0 ? issue.path.join(".") : "body"] = issue.message;
  }
  throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", { fields });
}
