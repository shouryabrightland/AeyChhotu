/* Console insights + guest feedback.
 *
 * The insight reads are ADMIN-only (`adminAuth: true` attaches the role:"admin"
 * JWT); the backend refuses a table token or a kitchen shift token before the
 * query runs, so a diner can never pull the restaurant's numbers.
 *
 * Feedback is the one write here, and it goes the other way: it carries the
 * TABLE token, because the person who ate is the person who rates. */

import { apiRequest } from "./apiClient";
import type {
  AdminBestSeller,
  AdminFeedback,
  AdminInventory,
  AdminOccupancy,
  AdminPendingOrder,
  AdminSalesSummary,
  TableFeedbackResult,
} from "./types";

const BASE = "/api/v1";

/** GET /api/v1/admin/insights/sales — today, yesterday, last 7 days. */
export async function getAdminSalesSummary(): Promise<AdminSalesSummary> {
  const { data } = await apiRequest<AdminSalesSummary>(`${BASE}/admin/insights/sales`, {
    adminAuth: true,
  });
  return data;
}

/** GET /api/v1/admin/insights/best-selling?days&limit */
export async function getAdminBestSelling(
  days = 1,
  limit = 5,
): Promise<{ days: number; limit: number; items: AdminBestSeller[] }> {
  const query = new URLSearchParams({ days: String(days), limit: String(limit) });
  const { data } = await apiRequest<{ days: number; limit: number; items: AdminBestSeller[] }>(
    `${BASE}/admin/insights/best-selling?${query.toString()}`,
    { adminAuth: true },
  );
  return data;
}

/** GET /api/v1/admin/insights/pending-orders — every ticket still in the kitchen. */
export async function getAdminPendingOrders(): Promise<{
  count: number;
  orders: AdminPendingOrder[];
}> {
  const { data } = await apiRequest<{ count: number; orders: AdminPendingOrder[] }>(
    `${BASE}/admin/insights/pending-orders`,
    { adminAuth: true },
  );
  return data;
}

/** GET /api/v1/admin/insights/tables — seated vs free, with devices and guests. */
export async function getAdminOccupancy(): Promise<AdminOccupancy> {
  const { data } = await apiRequest<AdminOccupancy>(`${BASE}/admin/insights/tables`, {
    adminAuth: true,
  });
  return data;
}

/** GET /api/v1/admin/insights/inventory — stock state per live dish. */
export async function getAdminInventory(): Promise<AdminInventory> {
  const { data } = await apiRequest<AdminInventory>(`${BASE}/admin/insights/inventory`, {
    adminAuth: true,
  });
  return data;
}

/** GET /api/v1/admin/insights/feedback?limit */
export async function getAdminFeedback(
  limit = 10,
): Promise<{ count: number; feedback: AdminFeedback[] }> {
  const query = new URLSearchParams({ limit: String(limit) });
  const { data } = await apiRequest<{ count: number; feedback: AdminFeedback[] }>(
    `${BASE}/admin/insights/feedback?${query.toString()}`,
    { adminAuth: true },
  );
  return data;
}

/** GET /api/v1/admin/assistant/key — released to an admin session only. */
export async function getAdminAssistantKey(): Promise<{ gemini_api_key: string | null }> {
  const { data } = await apiRequest<{ gemini_api_key: string | null }>(
    `${BASE}/admin/assistant/key`,
    { adminAuth: true },
  );
  return data;
}

/** POST /api/v1/sessions/:table_token/feedback — the table capability writes it. */
export async function submitTableFeedback(
  tableToken: string,
  input: { rating: number; comment?: string },
): Promise<TableFeedbackResult> {
  const { data } = await apiRequest<TableFeedbackResult>(
    `${BASE}/sessions/${encodeURIComponent(tableToken)}/feedback`,
    { method: "POST", body: { rating: input.rating, comment: input.comment ?? "" } },
  );
  return data;
}
