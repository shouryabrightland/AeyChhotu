/* Endpoint wrappers — exactly one typed async function per REST contract
   endpoint (docs/7-api-contract.md E1–E17 + E2b). All 12 required core
   functions are present with their specified names.

   Diner routes pass the validation token string (table_token) per request;
   back-of-house routes set `auth: true` and receive the injected
   `Authorization: Bearer <shift token>` header automatically. */

import { apiRequest } from "./apiClient";
import { setRealtimeAuth } from "./realtime-auth";
import { storeKdsToken } from "./token";
import type {
  ActiveCheck,
  AvailabilityResult,
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
  MenuItem,
  MenuQuery,
  OrderHistoryItem,
  Paged,
  RemoveCartItemPayload,
  SessionIdentity,
  ShiftActivation,
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
export async function initializeSession(tableToken: string): Promise<TableSession> {
  const { data } = await apiRequest<TableSession>(`${BASE}/sessions/initialize`, {
    method: "POST",
    body: { table_token: tableToken },
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
export async function startTableSession(tableToken: string): Promise<TableScan> {
  const { data } = await apiRequest<TableScan>(`${BASE}/sessions/initialize`, {
    method: "POST",
    body: { table_token: tableToken },
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
): Promise<TableSessionGrant> {
  const { data } = await apiRequest<TableSessionGrant>(`${BASE}/sessions/join-pin`, {
    method: "POST",
    body: { table_token: tableToken, pin },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E1c — POST /api/v1/sessions/join-pass (the 20-character QR pass). */
export async function joinTableWithPass(
  tableToken: string,
  secret: string,
): Promise<TableSessionGrant> {
  const { data } = await apiRequest<TableSessionGrant>(`${BASE}/sessions/join-pass`, {
    method: "POST",
    body: { table_token: tableToken, secret },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E1d — POST /api/v1/sessions/reconnect (a returning device, no keypad). */
export async function reconnectTableSession(
  tableToken: string,
  secret: string,
): Promise<TableSessionGrant> {
  const { data } = await apiRequest<TableSessionGrant>(`${BASE}/sessions/reconnect`, {
    method: "POST",
    body: { table_token: tableToken, secret },
  });
  setRealtimeAuth(data.realtime_token ?? null);
  return data;
}

/** E2 — POST /api/v1/auth/kds-login (stores the issued shift JWT) */
export async function loginKDS(pin: string): Promise<ShiftLogin> {
  const { data } = await apiRequest<ShiftLogin>(`${BASE}/auth/kds-login`, {
    method: "POST",
    body: { pin },
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

/** E9 — GET /api/v1/sessions/:table_token/active-check */
export async function checkActiveOrder(tableToken: string): Promise<ActiveCheck> {
  const { data } = await apiRequest<ActiveCheck>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}/active-check`,
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
