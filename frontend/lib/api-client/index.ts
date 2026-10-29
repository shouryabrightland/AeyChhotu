/* Public surface of the API client module.

   Usage:
     import { loginKDS, getKdsTickets, ApiError } from "@/lib/api-client";

   Runtime values are re-exported explicitly (no `export *` on value
   modules) so every consumer — webpack, tsx, jest — sees identical named
   exports regardless of module format. */

export * from "./types";
export { ApiError, isApiError } from "./errors";
export { getKdsToken, storeKdsToken, clearKdsToken } from "./token";
export { getAdminToken, storeAdminToken, clearAdminToken } from "./admin-token";
export {
  getBaseUrl,
  resolveApiAssetUrl,
  apiRequest,
  REQUEST_TIMEOUT_MS,
  KDS_LOGIN_PATH,
  type RequestOptions,
  type ApiResult,
} from "./apiClient";
export {
  initializeSession,
  startTableSession,
  joinTableWithPin,
  joinTableWithPass,
  reconnectTableSession,
  loginKDS,
  getMe,
  getTableState,
  getTableMembers,
  checkActiveOrder,
  requestTableBill,
  sendHeartbeat,
  removeHeartbeat,
  getMenu,
  getMenuCategories,
  getCartItems,
  upsertCartItem,
  updateCartItem,
  removeCartItem,
  fireTableOrder,
  getKdsTickets,
  updateKdsStatus,
  denyKdsTicket,
  pruneKdsTicket,
  requeueDeniedOrder,
  retryDeniedOrder,
  dismissDeniedOrder,
  activateShift,
  getKdsAssistantKey,
  toggleItemAvailability,
  getLiveOrderStatus,
  getOrders,
  getFloorTables,
  settleTableBill,
  notifyFloorTable,
  clearFloorTable,
  requestFloorServe,
  cancelFloorServe,
  loginAdmin,
  getAdminTables,
  createAdminTable,
  renameAdminTable,
  updateAdminTableCode,
  deactivateAdminTable,
  regenerateAdminTableToken,
  clearAdminTable,
  deleteAdminTable,
  getAdminMenu,
  getAdminCategories,
  createAdminCategory,
  updateAdminCategory,
  deleteAdminCategory,
  uploadAdminMenuImage,
  deleteAdminMenuImage,
  createAdminMenuItem,
  updateAdminMenuItem,
  deleteAdminMenuItem,
  getAdminAnalytics,
} from "./endpoints";
export {
  getSupabase,
  subscribeTableCart,
  subscribeMenuUpdates,
  subscribeTableUpdates,
  subscribeKdsOrders,
  subscribeOrdersFeed,
  subscribeOrderTracker,
  trackTablePresence,
  watchOrderStatus,
  type CartChangeEvent,
  type KdsIntakeEvent,
  type OrderFeedEvent,
  type OrderTrackerEvent,
  type TableUpdateEvent,
  type WatchOptions,
} from "./realtime";
export {
  isOfflineError,
  toTable,
  toMenuItem,
  toCartLine,
  toOrder,
  toKdsOrder,
  toFloorSummary,
} from "./normalize";
export { fetchAllPages, MAX_PAGE_FETCHES, type PagedResult } from "./paginate";
export { setRealtimeAuth, getRealtimeAuth } from "./realtime-auth";

export * from "./insights";
