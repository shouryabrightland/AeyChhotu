/* Endpoint wrappers — exactly one typed async function per REST contract
   endpoint (docs/7-api-contract.md E1–E17 + E2b). All 12 required core
   functions are present with their specified names.

   Diner routes pass the validation token string (table_token) per request;
   back-of-house routes set `auth: true` and receive the injected
   `Authorization: Bearer <shift token>` header automatically. */

import { apiRequest } from "./apiClient";
import { storeAdminToken } from "./admin-token";
import { setRealtimeAuth } from "./realtime-auth";
import { storeKdsToken } from "./token";
import type {
  ActiveCheck,
  AdminAnalytics,
  AdminCategory,
  AdminLogin,
  AdminMenuImage,
  AdminMenuItem,
  AdminTable,
  AdminTableToken,
  AvailabilityResult,
  CreateAdminCategoryInput,
  CreateAdminMenuItemInput,
  UpdateAdminCategoryInput,
  UpdateAdminMenuItemInput,
  DeviceHeartbeat,
  HeartbeatRemoval,
  BillRequest,
  BillSettlement,
  CartLine,
  CartLineWithTotal,
  CartRemovalResult,
  FiredOrder,
  FloorTable,
  KdsPruneResult,
  KdsStatusInput,
  KdsStatusUpdate,
  KdsTicketsQuery,
  KdsTicket,
  LiveOrderStatus,
  MenuCategoryNode,
  MenuItem,
  MenuQuery,
  OrderHistoryItem,
  Paged,
  RemoveCartItemPayload,
  RequeuedDeniedOrder,
  RetriedDeniedOrder,
  DismissedDeniedOrder,
  TableMember,
  TableState,
  KdsDenyResult,
  SessionEntryPayload,
  SessionIdentity,
  ShiftActivation,
  TableClearResult,
  TableScan,
  TableSessionGrant,
  ShiftLogin,
  TableSession,
  UpdateCartItemPayload,
  UpsertCartItemPayload,
} from "./types";

const BASE = "/api/v1";

// ---- Module 1: Session & Access --------------------------------------

/** E1 — POST /api/v1/sessions/initialize.
    Also arms the realtime RLS scope: the returned `realtime_token` is what
    Supabase sees as the JWT for this browser, so its channels only receive
    this table's rows. Null/absent ⇒ REST-only (policies match no rows). */
export async function initializeSession(
  tableToken: string,
  entry: SessionEntryPayload,
): Promise<TableSession> {
  const { data } = await apiRequest<TableSession>(`${BASE}/sessions/initialize`, {
    method: "POST",
    body: { table_token: tableToken, ...entry },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E1 — POST /api/v1/sessions/initialize, as the session GATE sees it.
    Same endpoint as `initializeSession`, but typed for the discriminated
    reply: an empty table is claimed (credentials returned), a live one is
    `locked` (nothing returned). The gate — not the data hook — decides
    which of those the guest sees, which is what keeps `useLiveTable` out of
    the authentication business. */
export async function startTableSession(
  tableToken: string,
  entry: SessionEntryPayload,
): Promise<TableScan> {
  const { data } = await apiRequest<TableScan>(`${BASE}/sessions/initialize`, {
    method: "POST",
    body: { table_token: tableToken, ...entry },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/* ---- Two-layer table session (E1b–E1d) -------------------------------
   E1 itself is `initializeSession` above, kept for the token wiring. These
   three are the join paths the gate drives. Each writes the realtime scope
   only when the server actually GRANTED the session: a `locked` reply sets
   it to null, so a browser that has not joined cannot subscribe to the
   table's rows even if it guessed the channel name. */

/** E1b — POST /api/v1/sessions/join-pin (2-digit keypad). */
export async function joinTableWithPin(
  tableToken: string,
  pin: string,
  entry: SessionEntryPayload,
): Promise<TableSessionGrant> {
  const { data } = await apiRequest<TableSessionGrant>(`${BASE}/sessions/join-pin`, {
    method: "POST",
    body: { table_token: tableToken, pin, ...entry },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E1c — POST /api/v1/sessions/join-pass (the 20-character QR pass). */
export async function joinTableWithPass(
  tableToken: string,
  secret: string,
  entry: SessionEntryPayload,
): Promise<TableSessionGrant> {
  const { data } = await apiRequest<TableSessionGrant>(`${BASE}/sessions/join-pass`, {
    method: "POST",
    body: { table_token: tableToken, secret, ...entry },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E1d — POST /api/v1/sessions/reconnect (a returning device, no keypad).
    Carries the same identity as every other entry point: the server refreshes
    this device's row in table_members, so a renamed guest is renamed on the
    roster too. */
export async function reconnectTableSession(
  tableToken: string,
  secret: string,
  entry: SessionEntryPayload,
): Promise<TableSessionGrant> {
  const { data } = await apiRequest<TableSessionGrant>(`${BASE}/sessions/reconnect`, {
    method: "POST",
    body: { table_token: tableToken, secret, ...entry },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E2 — POST /api/v1/auth/kds-login (stores the issued shift JWT).
    `surface` is rate-limit metadata only (docs/14 #18): kitchen and floor
    share this endpoint, so each PIN wall keeps its own failed-attempt budget.
    The server still issues the same staff role. */
export async function loginKDS(
  pin: string,
  surface: "kitchen" | "floor" = "kitchen",
): Promise<ShiftLogin> {
  const { data } = await apiRequest<ShiftLogin>(`${BASE}/auth/kds-login`, {
    method: "POST",
    body: { pin, surface },
  });
  storeKdsToken(data.token);
  // Staff-scoped read token: channel B (kds_orders) may read every order.
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E2b — GET /api/v1/auth/me (active terminal session identity) */
export async function getMe(): Promise<SessionIdentity> {
  const { data } = await apiRequest<SessionIdentity>(`${BASE}/auth/me`, { auth: true });
  return data;
}

/** GET /api/v1/sessions/:table_token — the diner's own table state.
    Server truth for `bill_status` and `status`, so a phone without realtime
    still sees a settle or a clear. */
export async function getTableState(tableToken: string): Promise<TableState> {
  const { data } = await apiRequest<TableState>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}`,
  );
  return data;
}

/** GET /api/v1/sessions/:table_token/members — the live table roster.
    The Table Pass reads this so a guest who joined but has not ordered yet
    still appears. */
export async function getTableMembers(tableToken: string): Promise<TableMember[]> {
  const { data } = await apiRequest<TableMember[]>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}/members`,
  );
  return data;
}

/** E9 — GET /api/v1/sessions/:table_token/active-check */
export async function checkActiveOrder(tableToken: string): Promise<ActiveCheck> {
  const { data } = await apiRequest<ActiveCheck>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}/active-check`,
  );
  return data;
}

/** POST /api/v1/sessions/:table_token/bill-request — the diner asks to pay. */
export async function requestTableBill(tableToken: string): Promise<BillRequest> {
  const { data } = await apiRequest<BillRequest>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}/bill-request`,
    { method: "POST" },
  );
  return data;
}

/** POST /api/v1/sessions/:table_token/heartbeat — this device is still here.
    The 15 s cadence is wired in use-presence. */
export async function sendHeartbeat(
  tableToken: string,
  deviceId: string,
): Promise<DeviceHeartbeat> {
  const { data } = await apiRequest<DeviceHeartbeat>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}/heartbeat`,
    { method: "POST", body: { device_id: deviceId } },
  );
  return data;
}

/** DELETE /api/v1/sessions/:table_token/heartbeat — this device left.
    `keepalive` lets the request outlive a pagehide/close; removing the row
    is one of the three triggers that can release a paid table. */
export async function removeHeartbeat(
  tableToken: string,
  deviceId: string,
): Promise<HeartbeatRemoval> {
  const { data } = await apiRequest<HeartbeatRemoval>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}/heartbeat`,
    { method: "DELETE", body: { device_id: deviceId }, keepalive: true },
  );
  return data;
}

// ---- Module 2: Menu & Collaborative Cart ------------------------------

/** E3 — GET /api/v1/menu?table_token=… (paginated) */
export async function getMenu(tableToken: string, query: MenuQuery = {}): Promise<Paged<MenuItem>> {
  const { data, meta } = await apiRequest<MenuItem[]>(`${BASE}/menu`, {
    query: { table_token: tableToken, page: query.page, limit: query.limit, category: query.category, q: query.q },
  });
  return { data, meta: meta! };
}

/** E4 — GET /api/v1/cart/items?table_token=… (REST bootstrap before Realtime) */
export async function getCartItems(
  tableToken: string,
  query: { page?: number; limit?: number } = {},
): Promise<Paged<CartLine>> {
  const { data, meta } = await apiRequest<CartLine[]>(`${BASE}/cart/items`, {
    query: { table_token: tableToken, page: query.page, limit: query.limit },
  });
  return { data, meta: meta! };
}

/** E5 — POST /api/v1/cart/items (atomic upsert on the server) */
export async function upsertCartItem(payload: UpsertCartItemPayload): Promise<CartLineWithTotal> {
  const { data } = await apiRequest<CartLineWithTotal>(`${BASE}/cart/items`, {
    method: "POST",
    body: payload,
  });
  return data;
}

/** E6 — PATCH /api/v1/cart/items/:cart_item_id */
export async function updateCartItem(
  cartItemId: string,
  payload: UpdateCartItemPayload,
): Promise<CartLineWithTotal> {
  const { data } = await apiRequest<CartLineWithTotal>(
    `${BASE}/cart/items/${encodeURIComponent(cartItemId)}`,
    { method: "PATCH", body: payload },
  );
  return data;
}

/** E7 — DELETE /api/v1/cart/items */
export async function removeCartItem(payload: RemoveCartItemPayload): Promise<CartRemovalResult> {
  const { data } = await apiRequest<CartRemovalResult>(`${BASE}/cart/items`, {
    method: "DELETE",
    body: payload,
  });
  return data;
}

/** E8 — POST /api/v1/orders/fire (201; atomic on the server).
    Throws ApiError 409 INVENTORY_FAILURE | DUPLICATE_ORDER | EMPTY_CART. */
export async function fireTableOrder(tableToken: string): Promise<FiredOrder> {
  const { data } = await apiRequest<FiredOrder>(`${BASE}/orders/fire`, {
    method: "POST",
    body: { table_token: tableToken },
  });
  return data;
}

/* POST /api/v1/orders/:order_id/requeue — the diner's "Move to list" (and
   the second half of "Retry"). Available lines go back into the shared cart
   for editing; lines the kitchen no longer has come back in `omitted`. */
export async function requeueDeniedOrder(
  orderId: string,
  tableToken: string,
): Promise<RequeuedDeniedOrder> {
  const { data } = await apiRequest<RequeuedDeniedOrder>(
    `${BASE}/orders/${encodeURIComponent(orderId)}/requeue`,
    { method: "POST", query: { table_token: tableToken } },
  );
  return data;
}

/** POST /api/v1/orders/:order_id/retry — atomic re-fire of a refused round.
    If the new ticket cannot be fired the refused one is left untouched. */
export async function retryDeniedOrder(
  orderId: string,
  tableToken: string,
): Promise<RetriedDeniedOrder> {
  const { data } = await apiRequest<RetriedDeniedOrder>(
    `${BASE}/orders/${encodeURIComponent(orderId)}/retry`,
    { method: "POST", query: { table_token: tableToken } },
  );
  return data;
}

/** POST /api/v1/orders/:order_id/dismiss — the diner's "Cancel". */
export async function dismissDeniedOrder(
  orderId: string,
  tableToken: string,
): Promise<DismissedDeniedOrder> {
  const { data } = await apiRequest<DismissedDeniedOrder>(
    `${BASE}/orders/${encodeURIComponent(orderId)}/dismiss`,
    { method: "POST", query: { table_token: tableToken } },
  );
  return data;
}

// ---- Module 3: Kitchen Display System (back-of-house → bearer token) --

/** E10 — GET /api/v1/kds/tickets (auth) */
export async function getKdsTickets(query: KdsTicketsQuery = {}): Promise<Paged<KdsTicket>> {
  const { data, meta } = await apiRequest<KdsTicket[]>(`${BASE}/kds/tickets`, {
    auth: true,
    query: { status: query.status, page: query.page, limit: query.limit },
  });
  return { data, meta: meta! };
}

/** E11 — PATCH /api/v1/kds/tickets/:order_id/status (auth; sequential only) */
export async function updateKdsStatus(
  orderId: string,
  status: KdsStatusInput,
): Promise<KdsStatusUpdate> {
  const { data } = await apiRequest<KdsStatusUpdate>(
    `${BASE}/kds/tickets/${encodeURIComponent(orderId)}/status`,
    { method: "PATCH", auth: true, body: { status } },
  );
  return data;
}

/** PATCH /api/v1/kds/tickets/:order_id/deny — refuse a ticket with a reason.
    Valid from pending, preparing and ready. */
export async function denyKdsTicket(orderId: string, reason: string): Promise<KdsDenyResult> {
  const { data } = await apiRequest<KdsDenyResult>(
    `${BASE}/kds/tickets/${encodeURIComponent(orderId)}/deny`,
    { method: "PATCH", auth: true, body: { reason } },
  );
  return data;
}

/** E12 — PATCH /api/v1/kds/tickets/:order_id/prune (auth) */
export async function pruneKdsTicket(orderId: string): Promise<KdsPruneResult> {
  const { data } = await apiRequest<KdsPruneResult>(
    `${BASE}/kds/tickets/${encodeURIComponent(orderId)}/prune`,
    { method: "PATCH", auth: true },
  );
  return data;
}

/** E13 — POST /api/v1/kds/shift/activate (auth; arms audio chimes) */
export async function activateShift(deviceId: string): Promise<ShiftActivation> {
  const { data } = await apiRequest<ShiftActivation>(`${BASE}/kds/shift/activate`, {
    method: "POST",
    auth: true,
    body: { device_id: deviceId },
  });
  return data;
}

// ---- Module 4: Floor operations ---------------------------------------

/** PATCH /api/v1/floor/tables/:table_id/settle (auth; staff role).
    Takes payment and asks the engine whether the table can be cleared now. */
export async function settleTableBill(tableId: string): Promise<BillSettlement> {
  const { data } = await apiRequest<BillSettlement>(
    `${BASE}/floor/tables/${encodeURIComponent(tableId)}/settle`,
    { method: "PATCH", auth: true },
  );
  return data;
}

/** POST /api/v1/floor/tables/:table_id/notify (auth; staff role).
    The explicit alert for a flagged table whose bill is unpaid. */
export async function notifyFloorTable(
  tableId: string,
): Promise<{ table_id: string; notified: true; clear_requested_at: string }> {
  const { data } = await apiRequest<{
    table_id: string;
    notified: true;
    clear_requested_at: string;
  }>(`${BASE}/floor/tables/${encodeURIComponent(tableId)}/notify`, {
    method: "POST",
    auth: true,
  });
  return data;
}

/** PATCH /api/v1/floor/tables/:table_id/clear (auth; staff role).
    Clears a flagged table when nothing is owed. Throws 409 BILL_UNPAID when
    the table has history and an unpaid bill — that call also alerts admin. */
export async function clearFloorTable(tableId: string): Promise<TableClearResult> {
  const { data } = await apiRequest<TableClearResult>(
    `${BASE}/floor/tables/${encodeURIComponent(tableId)}/clear`,
    { method: "PATCH", auth: true },
  );
  return data;
}

/** E14 — PATCH /api/v1/menu/items/:menu_item_id/availability (auth) */
export async function toggleItemAvailability(
  itemId: string,
  isAvailable: boolean,
): Promise<AvailabilityResult> {
  const { data } = await apiRequest<AvailabilityResult>(
    `${BASE}/menu/items/${encodeURIComponent(itemId)}/availability`,
    { method: "PATCH", auth: true, body: { is_available: isAvailable } },
  );
  return data;
}

/** E15 — GET /api/v1/orders/:order_id/status (diner polling fallback) */
/** E15 — GET /api/v1/orders/:order_id/status?table_token=…
    The table_token is mandatory: the backend scopes the read to that
    table (an order id alone is not a universal reader). */
export async function getLiveOrderStatus(
  orderId: string,
  tableToken: string,
): Promise<LiveOrderStatus> {
  const { data } = await apiRequest<LiveOrderStatus>(
    `${BASE}/orders/${encodeURIComponent(orderId)}/status`,
    { query: { table_token: tableToken } },
  );
  return data;
}

/** E16 — GET /api/v1/orders?table_token=… (tracker bootstrap + history) */
export async function getOrders(
  tableToken: string,
  query: { page?: number; limit?: number } = {},
): Promise<Paged<OrderHistoryItem>> {
  const { data, meta } = await apiRequest<OrderHistoryItem[]>(`${BASE}/orders`, {
    query: { table_token: tableToken, page: query.page, limit: query.limit },
  });
  return { data, meta: meta! };
}

/** E17 — GET /api/v1/floor/tables (auth) */
export async function getFloorTables(
  query: { page?: number; limit?: number } = {},
): Promise<Paged<FloorTable>> {
  const { data, meta } = await apiRequest<FloorTable[]>(`${BASE}/floor/tables`, {
    auth: true,
    query: { page: query.page, limit: query.limit },
  });
  return { data, meta: meta! };
}

// ---- Module 5: Executive admin console -------------------------------

/** POST /api/v1/auth/admin-login — stores the role:"admin" session token. */
export async function loginAdmin(pin: string): Promise<AdminLogin> {
  const { data } = await apiRequest<AdminLogin>(`${BASE}/auth/admin-login`, {
    method: "POST",
    body: { pin },
  });
  storeAdminToken(data.token);
  return data;
}

/** GET /api/v1/admin/tables */
export async function getAdminTables(): Promise<AdminTable[]> {
  const { data } = await apiRequest<AdminTable[]>(`${BASE}/admin/tables`, { adminAuth: true });
  return data;
}

/** POST /api/v1/admin/tables */
export async function createAdminTable(name: string): Promise<AdminTable> {
  const { data } = await apiRequest<AdminTable>(`${BASE}/admin/tables`, {
    method: "POST",
    adminAuth: true,
    body: { name },
  });
  return data;
}

/** PATCH /api/v1/admin/tables/:table_id */
export async function renameAdminTable(
  tableId: string,
  name: string,
): Promise<{ table_id: string; name: string }> {
  const { data } = await apiRequest<{ table_id: string; name: string }>(
    `${BASE}/admin/tables/${encodeURIComponent(tableId)}`,
    { method: "PATCH", adminAuth: true, body: { name } },
  );
  return data;
}

/** PATCH /api/v1/admin/tables/:table_id/code — set the printed code by hand.
    The server refuses unless the table is empty (409 TABLE_NOT_EMPTY). */
export async function updateAdminTableCode(
  tableId: string,
  code: string,
): Promise<AdminTableToken> {
  const { data } = await apiRequest<AdminTableToken>(
    `${BASE}/admin/tables/${encodeURIComponent(tableId)}/code`,
    { method: "PATCH", adminAuth: true, body: { code } },
  );
  return data;
}

/** POST /api/v1/admin/tables/:table_id/deactivate — close the table now,
    even with an open ticket or money owed. The table code is kept. */
export async function deactivateAdminTable(
  tableId: string,
): Promise<{ table_id: string; deactivated: true; closed_orders: number }> {
  const { data } = await apiRequest<{
    table_id: string;
    deactivated: true;
    closed_orders: number;
  }>(`${BASE}/admin/tables/${encodeURIComponent(tableId)}/deactivate`, {
    method: "POST",
    adminAuth: true,
  });
  return data;
}

/** POST /api/v1/admin/tables/:table_id/regenerate-token */
export async function regenerateAdminTableToken(tableId: string): Promise<AdminTableToken> {
  const { data } = await apiRequest<AdminTableToken>(
    `${BASE}/admin/tables/${encodeURIComponent(tableId)}/regenerate-token`,
    { method: "POST", adminAuth: true },
  );
  return data;
}

/** POST /api/v1/admin/tables/:table_id/clear — the manager override for an
    unpaid table a staff member could not clear. */
export async function clearAdminTable(tableId: string): Promise<TableClearResult> {
  const { data } = await apiRequest<TableClearResult>(
    `${BASE}/admin/tables/${encodeURIComponent(tableId)}/clear`,
    { method: "POST", adminAuth: true },
  );
  return data;
}

/** DELETE /api/v1/admin/tables/:table_id (archives, never drops history) */
export async function deleteAdminTable(tableId: string): Promise<{ table_id: string }> {
  const { data } = await apiRequest<{ table_id: string }>(
    `${BASE}/admin/tables/${encodeURIComponent(tableId)}`,
    { method: "DELETE", adminAuth: true },
  );
  return data;
}

/** GET /api/v1/admin/menu */
export async function getAdminMenu(): Promise<AdminMenuItem[]> {
  const { data } = await apiRequest<AdminMenuItem[]>(`${BASE}/admin/menu`, { adminAuth: true });
  return data;
}

/** POST /api/v1/admin/menu */
export async function createAdminMenuItem(
  input: CreateAdminMenuItemInput,
): Promise<AdminMenuItem> {
  const { data } = await apiRequest<AdminMenuItem>(`${BASE}/admin/menu`, {
    method: "POST",
    adminAuth: true,
    body: input,
  });
  return data;
}

/** PATCH /api/v1/admin/menu/:menu_item_id */
export async function updateAdminMenuItem(
  menuItemId: string,
  input: UpdateAdminMenuItemInput,
): Promise<AdminMenuItem> {
  const { data } = await apiRequest<AdminMenuItem>(
    `${BASE}/admin/menu/${encodeURIComponent(menuItemId)}`,
    { method: "PATCH", adminAuth: true, body: input },
  );
  return data;
}

/** DELETE /api/v1/admin/menu/:menu_item_id */
export async function deleteAdminMenuItem(
  menuItemId: string,
): Promise<{ menu_item_id: string }> {
  const { data } = await apiRequest<{ menu_item_id: string }>(
    `${BASE}/admin/menu/${encodeURIComponent(menuItemId)}`,
    { method: "DELETE", adminAuth: true },
  );
  return data;
}

/** GET /api/v1/menu/categories — the folder tree the diner menu groups by. */
export async function getMenuCategories(): Promise<MenuCategoryNode[]> {
  const { data } = await apiRequest<MenuCategoryNode[]>(`${BASE}/menu/categories`);
  return data;
}

/** GET /api/v1/admin/categories — the folder tree with cover photos. */
export async function getAdminCategories(): Promise<AdminCategory[]> {
  const { data } = await apiRequest<AdminCategory[]>(`${BASE}/admin/categories`, {
    adminAuth: true,
  });
  return data;
}

/** POST /api/v1/admin/categories */
export async function createAdminCategory(
  input: CreateAdminCategoryInput,
): Promise<AdminCategory> {
  const { data } = await apiRequest<AdminCategory>(`${BASE}/admin/categories`, {
    method: "POST",
    adminAuth: true,
    body: input,
  });
  return data;
}

/** PATCH /api/v1/admin/categories/:category_id */
export async function updateAdminCategory(
  categoryId: string,
  input: UpdateAdminCategoryInput,
): Promise<AdminCategory> {
  const { data } = await apiRequest<AdminCategory>(
    `${BASE}/admin/categories/${encodeURIComponent(categoryId)}`,
    { method: "PATCH", adminAuth: true, body: input },
  );
  return data;
}

/** DELETE /api/v1/admin/categories/:category_id — only an empty folder. */
export async function deleteAdminCategory(
  categoryId: string,
): Promise<{ category_id: string }> {
  const { data } = await apiRequest<{ category_id: string }>(
    `${BASE}/admin/categories/${encodeURIComponent(categoryId)}`,
    { method: "DELETE", adminAuth: true },
  );
  return data;
}

/** POST /api/v1/admin/menu/:menu_item_id/image — the file is the body. */
export async function uploadAdminMenuImage(
  menuItemId: string,
  file: Blob,
): Promise<AdminMenuImage> {
  const { data } = await apiRequest<AdminMenuImage>(
    `${BASE}/admin/menu/${encodeURIComponent(menuItemId)}/image`,
    {
      method: "POST",
      adminAuth: true,
      rawBody: file,
      contentType: file.type || "application/octet-stream",
      // Derivative generation is CPU work on the server; 20s is tight for a
      // large phone photo on a slow uplink.
      timeoutMs: 60_000,
    },
  );
  return data;
}

/** DELETE /api/v1/admin/menu/:menu_item_id/image */
export async function deleteAdminMenuImage(
  menuItemId: string,
): Promise<{ removed: boolean }> {
  const { data } = await apiRequest<{ removed: boolean }>(
    `${BASE}/admin/menu/${encodeURIComponent(menuItemId)}/image`,
    { method: "DELETE", adminAuth: true },
  );
  return data;
}

/** GET /api/v1/admin/analytics/top-selling */
export async function getAdminAnalytics(): Promise<AdminAnalytics> {
  const { data } = await apiRequest<AdminAnalytics>(`${BASE}/admin/analytics/top-selling`, {
    adminAuth: true,
  });
  return data;
}
