/* apiClient — the single network core every endpoint wrapper goes through.
   Implements the integration spec:
     §1  dynamic base URL from NEXT_PUBLIC_API_URL (Vite variant: VITE_API_URL)
         — NO hardcoded host anywhere below.
     §4  error-envelope parsing → ApiError { status, error, message, details }
     §5  global 401 guard: wipe token, terminate shift, redirect to /kitchen
     §6  strict 20-second timeout on every outbound operation. */

import { clearAdminToken, getAdminToken } from "./admin-token";
import { ApiError } from "./errors";
import type { ApiEnvelope, PageMeta } from "./types";
import { clearKdsToken, getKdsToken } from "./token";

/** §6 — hard connection ceiling for every outbound operation. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Staff PIN checkpoint page (§5 redirect target). */
export const KDS_LOGIN_PATH = "/kitchen";

/**
 * §1 — Dynamic base URL. Read from the framework's public env surface at
 * call time so builds stay portable. Never hardcode a host here.
 * (Vite equivalent: const raw = import.meta.env.VITE_API_URL ?? "";)
 */
export function getBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "";
  if (!raw) {
    throw new ApiError(
      0,
      "CONFIG_ERROR",
      "API base URL is not configured (NEXT_PUBLIC_API_URL missing).",
    );
  }
  return pointLocalApiAtPageHost(raw.replace(/\/+$/, ""));
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Turn an API-relative asset path (a dish photo) into a browser URL.
    Absolute URLs and data URLs pass through unchanged. */
export function resolveApiAssetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  try {
    return `${getBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  } catch {
    return path;
  }
}

/* One dev-server convenience, no effect on a deployed build.

   A phone opens the dev app at http://192.168.x.x:3000, where "localhost" in
   NEXT_PUBLIC_API_URL means the PHONE, not the laptop running the API. Every
   request then times out and the page looks broken. When the configured API
   host is loopback and the page itself is not, swap the page's hostname in
   and keep the port: the device talks to whichever machine served the page.
   A real API URL is left exactly as configured. */
function pointLocalApiAtPageHost(base: string): string {
  if (typeof window === "undefined") return base;

  const pageHost = window.location.hostname;
  if (!pageHost || LOOPBACK_HOSTS.includes(pageHost)) return base;

  try {
    const url = new URL(base);
    if (!LOOPBACK_HOSTS.includes(url.hostname)) return base;
    url.hostname = pageHost;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return base;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Send bytes as-is (a dish photo) instead of JSON. */
  rawBody?: BodyInit;
  /** MIME type that accompanies rawBody; ignored for JSON requests. */
  contentType?: string;
  query?: Record<string, string | number | undefined>;
  /** Inject `Authorization: Bearer <shift token>` (back-of-house routes). */
  auth?: boolean;
  /** Inject `Authorization: Bearer <admin token>` (executive console routes).
      Separate from `auth` so a shift token can never be sent to /admin and an
      admin token can never be sent to /kds. */
  adminAuth?: boolean;
  timeoutMs?: number;
  /** Keep the request alive across a page unload (presence disconnect). */
  keepalive?: boolean;
}

/** Which credential a request carries — decides where a 401 sends the user. */
type AuthMode = "staff" | "admin";

export interface ApiResult<T> {
  data: T;
  meta?: PageMeta;
  status: number;
}

function buildQueryString(query: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/* §5 — global guard.
   Staff: wipe the shift token and terminate the workspace by sending the
   window back to the PIN checkpoint.
   Admin: wipe the console token and STAY on /admin. Its page owns the PIN
   wall, so redirecting a manager to the kitchen (the staff target) would be
   both wrong and confusing. */
function handleUnauthorized(mode: AuthMode): void {
  if (mode === "admin") {
    clearAdminToken();
    return;
  }

  clearKdsToken();
  if (typeof window !== "undefined" && !window.location.pathname.startsWith(KDS_LOGIN_PATH)) {
    // Hard navigation on purpose: spec §5 requires terminating the whole
    // shift workspace (a client-side route push would keep its state alive).
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional full workspace teardown
    window.location.assign(KDS_LOGIN_PATH);
  }
}

/** Fallback error.code when the server body is not our envelope. */
function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    case 500:
      return "INTERNAL_ERROR";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "HTTP_ERROR";
  }
}

function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 401:
      return "Missing or invalid kitchen shift token.";
    case 403:
      return "This session role is not permitted to perform this action.";
    case 404:
      return "Resource not found.";
    case 409:
      return "Request conflicts with the current state.";
    default:
      return status >= 500
        ? "Unexpected server error."
        : `Request failed with status ${status}.`;
  }
}

/** §4 — structural error-envelope extraction. Throws ApiError. */
function throwFromResponse(status: number, body: unknown, mode: AuthMode): never {
  const envelope =
    body && typeof body === "object"
      ? (body as { error?: Record<string, unknown> }).error
      : undefined;

  const code =
    typeof envelope?.["code"] === "string"
      ? (envelope["code"] as string)
      : defaultCodeForStatus(status);
  const message =
    typeof envelope?.["message"] === "string"
      ? (envelope["message"] as string)
      : defaultMessageForStatus(status);

  // §5 — only a token problem (not a wrong-PIN 401) triggers the guard.
  if (status === 401 && code === "UNAUTHORIZED") {
    handleUnauthorized(mode);
  }

  throw new ApiError(status, code, message, envelope);
}

/**
 * The one request function every wrapper uses.
 * - wraps fetch with a strict timeout (AbortController)
 * - parses the success envelope { success, data, meta }
 * - parses the error envelope into ApiError (§4)
 * - runs the global 401 guard (§5)
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const method = options.method ?? "GET";
  const url = `${getBaseUrl()}${path}${buildQueryString(options.query)}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.rawBody !== undefined) {
    headers["Content-Type"] = options.contentType ?? "application/octet-stream";
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const authMode: AuthMode = options.adminAuth ? "admin" : "staff";

  if (options.auth || options.adminAuth) {
    const token = options.adminAuth ? getAdminToken() : getKdsToken();
    if (!token) {
      // Fail fast without a round-trip — same outcome as a server 401.
      handleUnauthorized(authMode);
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        options.adminAuth
          ? "Missing or invalid manager session. Enter the manager PIN."
          : "Missing or invalid kitchen shift token.",
      );
    }
    headers["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body:
        options.rawBody !== undefined
          ? options.rawBody
          : options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
      signal: controller.signal,
      cache: "no-store",
      ...(options.keepalive ? { keepalive: true } : {}),
      // Send/accept the httpOnly kds_token cookie. The default ("same-origin")
      // would silently stop working the moment the API moves to its own
      // host, so the cookie path is exercised in both hosting shapes. The
      // Bearer header above stays the primary mechanism: cookies are scoped
      // SameSite=Strict and are useless cross-site.
      credentials: "include",
    });
  } catch (err) {
    if (controller.signal.aborted) {
      // §6 — friendly, user-facing timeout copy.
      throw new ApiError(
        0,
        "TIMEOUT",
        "Serving line taking a moment to spin up, please try again!",
      );
    }
    throw new ApiError(0, "NETWORK_ERROR", "Unable to reach the kitchen line. Check your connection and try again.", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  if (response.status !== 204) {
    body = await response.json().catch(() => null);
  }

  if (!response.ok) {
    throwFromResponse(response.status, body, authMode);
  }

  const envelope = (body ?? {}) as ApiEnvelope<T>;
  return { data: envelope.data as T, meta: envelope.meta, status: response.status };
}
