/* Contract typings — docs/7-api-contract.md (v2).
   Field names are verbatim DB-blueprint names; nothing is renamed client-side.
   Envelope: success { success: true, data, meta? }
             error   { success: false, error: { code, message, ...details } } */

/** A ticket the kitchen refused (an 86 after firing, or a chef's manual
    denial). It is CLOSED — not served, not active — and it never appears on
    the KDS board or in the bill. */
export type OrderStatus = "pending" | "preparing" | "ready" | "served" | "denied";
/** The three states that are still being worked on the line. */
export type ActiveOrderStatus = "pending" | "preparing" | "ready";
export type TableStatus = "active" | "empty";
/** Bill lifecycle: a table is only releasable once 'paid'. */
export type BillStatus = "unrequested" | "requested" | "paid";
/** Only sequential forward steps are accepted by the KDS status mutator. */
export type KdsStatusInput = "preparing" | "ready";

/** docs/7 §1.5 — present on every paginated list response. */
export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  meta?: PageMeta;
}

/** Result of every paginated wrapper: payload + its meta. */
export interface Paged<T> {
  data: T[];
  meta: PageMeta;
}

// ---- Resources -------------------------------------------------------

/** E3 menu row. */
export interface MenuItem {
  menu_item_id: string;
  name: string;
  price: number;
  category: string;
  /** Catalogue folder the dish lives in (absent on older payloads). */
  category_id?: string | null;
  is_available: boolean;
  description: string;
  vegetarian: boolean;
  /** An uploaded photo. Null/absent means the app's curated photography. */
  image_url?: string | null;
  image_small_url?: string | null;
  blur_data_url?: string | null;
}

/** E4 cart row. */
export interface CartLine {
  id: string;
  table_id: string;
  menu_item_id: string;
  quantity: number;
  request_note: string;
  allergy_note: string;
  added_by: string;
}

/** E5/E6 — cart row plus the table-wide quantity aggregate. */
export interface CartLineWithTotal extends CartLine {
  total_table_quantity: number;
}

/** E1 session. */
export interface TableSession {
  table_id: string;
  code: string;
  name: string;
  status: TableStatus;
  /** E1 Supabase-scoped read token (RLS scope). Absent/null without
      SUPABASE_JWT_SECRET — the app then runs REST-only. */
  realtime_token?: string | null;
}

/** E1 — a claimed / joined table session. The credentials are the diner's
    own: they are what `join-pin`, `join-pass` and `reconnect` return, and
    they are never present in a staff payload. */
export interface TableSessionGrant {
  table_id: string;
  code: string;
  name: string;
  status: "active";
  session_pin: string;
  session_secret: string;
  session_started_at: string | null;
  bill_status: BillStatus;
  realtime_token: string | null;
}

/** E1 — the reply to a scan of a table that already has a live session.
    Deliberately carries no credentials and no read token. */
export interface TableSessionLocked {
  table_id: string;
  code: string;
  name: string;
  status: "locked";
  pin_locked: boolean;
  attempts_remaining: number;
  realtime_token: null;
}

/** E1 — the discriminated reply to a scan. */
export type TableScan = TableSessionGrant | TableSessionLocked;

/** Extra context every session entry point sends.

    `scan_time` is when THIS page was opened. The backend refuses a session
    whose scan_time predates the table's last clear (STALE_SESSION), which is
    what stops a long-cached page from joining the previous party's table.
    `user_id`/`name` register the device in table_members. */
export interface SessionEntryPayload {
  scan_time?: string;
  user_id?: string;
  name?: string;
}

/** E9 anti-duplicate guardrail (discriminated union). */
export interface ActiveOrderBlocked {
  has_active_order: true;
  order_id: string;
  status: OrderStatus;
  message: string;
}
export interface ActiveOrderClear {
  has_active_order: false;
  message: string;
}
export type ActiveCheck = ActiveOrderBlocked | ActiveOrderClear;

/** E2 shift login. */
export interface ShiftLogin {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  role: string;
  terminal_id: string | null;
  /** E2 Supabase-scoped read token for the KDS realtime channels. */
  realtime_token?: string | null;
  message: string;
}

/** E2b — decoded terminal session identity. */
export interface SessionIdentity {
  authenticated: true;
  role: string;
  terminal_id: string | null;
  issued_at: string;
  expires_at: string;
  source: "header" | "cookie";
}

/** Order line as embedded in E17 floor rows / E10 tickets / E16 history.
    `name` is joined LIVE from menu_items (a rename shows through), while
    `unit_price` is the price CHARGED at fire time — a re-priced dish must
    never rewrite an old ticket's bill. */
export interface OrderItemLine {
  menu_item_id: string;
  name: string;
  quantity: number;
  request_note: string;
  allergy_note: string;
  /** Who ordered the line — copied from the cart at fire time (sql/011). */
  added_by?: string;
  unit_price?: number;
}

/** E8 — fired order (201). */
export interface FiredOrder {
  order_id: string;
  table_id: string;
  status: OrderStatus;
  created_at: string;
  message: string;
}

/** E15 — polling fallback payload. */
export interface LiveOrderStatus {
  order_id: string;
  table_id: string;
  status: OrderStatus;
  created_at: string;
}

/** E16 — table order history row. */
export interface OrderHistoryItem {
  order_id: string;
  table_id: string;
  status: OrderStatus;
  created_at: string;
  /** Why the kitchen refused this round ('' unless status = 'denied'). */
  denial_reason?: string;
  /** Bill frozen at fire time (sql/004_hardening.sql). */
  total?: number;
  items: OrderItemLine[];
}

/** E10 — KDS ticket. */
export interface KdsTicket {
  order_id: string;
  table: { id: string; code: string; name: string };
  status: ActiveOrderStatus;
  created_at: string;
  items: OrderItemLine[];
}

/** E11 response. */
export interface KdsStatusUpdate {
  order_id: string;
  status: OrderStatus;
}

/** E12 response. */
export interface KdsPruneResult {
  order_id: string;
  status: "served";
  table_cleared: boolean;
}

/** E13 response. */
export interface ShiftActivation {
  device_id: string;
  audio_armed: true;
  message: string;
}

/** E14 response. `denied_orders` counts the PENDING rounds the 86 stopped. */
export interface AvailabilityResult {
  menu_item_id: string;
  is_available: boolean;
  denied_orders?: number;
}

/** PATCH /api/v1/kds/tickets/:order_id/deny — the chef's refusal. */
export interface KdsDenyResult {
  order_id: string;
  status: "denied";
  denial_reason: string;
  table_cleared: boolean;
}

/** POST /api/v1/orders/:order_id/requeue — "Move to list" / "Retry". */
export interface RequeuedDeniedOrder {
  order_id: string;
  moved: number;
  /** Dish names the cart could not take because the kitchen has none left. */
  omitted: string[];
}

/** POST /api/v1/orders/:order_id/dismiss — the diner's "Cancel". */
export interface DismissedDeniedOrder {
  order_id: string;
  dismissed: true;
}

/** E7 response. */
export interface CartRemovalResult {
  id: string;
  message: string;
}

/** E17 — floor row.
    `active_order.items` is the v2.1 addition documented in docs/7: the
    ticket lines travel with the floor row so a runner can see the table's
    allergy alerts without calling the kitchen board as well. */
export interface FloorActiveOrder {
  order_id: string;
  status: ActiveOrderStatus;
  created_at: string;
  items?: OrderItemLine[];
}

export interface FloorTable {
  table_id: string;
  code: string;
  name: string;
  status: TableStatus;
  bill_status: BillStatus;
  /** Set when staff tried to clear the table with an unpaid bill. */
  clear_requested_at: string | null;
  /** This seating has tickets and the bill is not marked paid. */
  bill_unpaid: boolean;
  active_order: FloorActiveOrder | null;
  cart_line_count: number;
  /** Devices that sent a heartbeat in the stale-detection window. */
  active_devices: number;
  /** Active session, no connected device, no open order, no bill request. */
  needs_attention: boolean;
}

/** PATCH /api/v1/floor/tables/:table_id/clear and the admin override. */
export interface TableClearResult {
  table_id: string;
  cleared: true;
  bill_status: BillStatus;
}

/** PATCH /api/v1/floor/tables/:table_id/settle */
export interface BillSettlement {
  table_id: string;
  bill_status: "paid";
  bill_paid_at: string;
  /** True when the paid bill was also the last blocker to clearing the table. */
  released: boolean;
}

/** POST /api/v1/sessions/:table_token/bill-request */
export interface BillRequest {
  table_id: string;
  bill_status: BillStatus;
  bill_requested_at: string | null;
}

/** POST /api/v1/sessions/:table_token/heartbeat */
export interface DeviceHeartbeat {
  table_id: string;
  device_id: string;
  last_seen: string;
}

/** DELETE /api/v1/sessions/:table_token/heartbeat */
export interface HeartbeatRemoval {
  table_id: string;
  device_id: string;
  released: boolean;
}

// ---- Request payloads ------------------------------------------------

/** E5 POST /api/v1/cart/items */
export interface UpsertCartItemPayload {
  table_token: string;
  menu_item_id: string;
  quantity?: number;
  allergy_note?: string;
  request_note?: string;
  added_by?: string;
}

/** E6 PATCH /api/v1/cart/items/:cart_item_id */
export interface UpdateCartItemPayload {
  table_token: string;
  /** Absolute "set to N" (last write wins). */
  quantity?: number;
  /** +/- stepper intent — applied atomically server-side (no lost updates). */
  quantity_delta?: number;
  request_note?: string;
  allergy_note?: string;
}

/** E7 DELETE /api/v1/cart/items */
export interface RemoveCartItemPayload {
  table_token: string;
  cart_item_id: string;
}

// ---- List queries ----------------------------------------------------

export interface ListQuery {
  page?: number;
  limit?: number;
}

export interface MenuQuery extends ListQuery {
  category?: string;
  q?: string;
}

export interface KdsTicketsQuery extends ListQuery {
  status?: ActiveOrderStatus;
}

// ---- Executive admin console -----------------------------------------

/** POST /api/v1/auth/admin-login — the manager session. */
export interface AdminLogin {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  role: "admin";
  message: string;
}

/** A live table row in the admin grid. `has_session` is whether a PIN/pass is
    currently issued; `status` is the table's own active/empty state. */
export interface AdminTable {
  table_id: string;
  code: string;
  name: string;
  status: TableStatus;
  bill_status: BillStatus;
  /** Manager action required: staff clear was refused for an unpaid bill. */
  clear_requested_at: string | null;
  active_order_count: number;
  cart_line_count: number;
  /** Phones heartbeating on this table inside the stale window. */
  active_devices: number;
  has_session: boolean;
  session_started_at: string | null;
  created_at: string;
}

/** POST /api/v1/admin/tables/:table_id/regenerate-token */
export interface AdminTableToken {
  table_id: string;
  code: string;
  name: string;
}

/** GET /api/v1/admin/menu — includes 86'd dishes, excludes archived ones. */
export interface AdminMenuItem extends MenuItem {
  category_id: string | null;
  image_url: string | null;
  image_small_url: string | null;
  blur_data_url: string | null;
}

export interface CreateAdminMenuItemInput {
  name: string;
  price: number;
  category_id?: string | null;
  category?: string;
  description: string;
  vegetarian: boolean;
  is_available: boolean;
}

export type UpdateAdminMenuItemInput = Partial<CreateAdminMenuItemInput>;

/** The three derivatives the API exposes for one dish photo. */
export interface MenuImage {
  image_url: string;
  image_small_url: string;
  blur_data_url: string;
}

/** POST /api/v1/admin/menu/:menu_item_id/image */
export interface AdminMenuImage extends MenuImage {
  width: number;
  height: number;
  size_bytes: number;
}

/** One node of the public category tree (GET /api/v1/menu/categories). */
export interface MenuCategoryNode {
  category_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

/** One folder in the catalogue explorer. */
export interface AdminCategory {
  category_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  item_count: number;
  thumbnail_menu_item_id: string | null;
  thumbnail: MenuImage | null;
}

export interface CreateAdminCategoryInput {
  name: string;
  parent_id?: string | null;
}

export interface UpdateAdminCategoryInput {
  name?: string;
  parent_id?: string | null;
  sort_order?: number;
  thumbnail_menu_item_id?: string | null;
}

/** One row of the best-sellers leaderboard. */
export interface TopSellingItem {
  menu_item_id: string;
  name: string;
  category: string;
  total_sold: number;
  total_revenue: number;
}

/** GET /api/v1/admin/analytics/top-selling */
export interface AdminAnalytics {
  items: TopSellingItem[];
  total_revenue: number;
  total_orders_served: number;
  active_tables_count: number;
}
