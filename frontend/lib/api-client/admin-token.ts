/* Executive console token storage.
 *
 * Kept in its OWN key, never in the KDS key, for two reasons:
 *   1. A kitchen shift token is a lower privilege than an admin session. If
 *      they shared storage, opening /kitchen after an admin login would
 *      overwrite the admin token, and a stale admin token could be injected
 *      into a staff call.
 *   2. Signing out of one must not sign out of the other.
 *
 * The server also sets an httpOnly `admin_token` cookie; this copy exists so
 * the client can send `Authorization: Bearer` regardless of whether the API
 * is same-site (cookie path) or cross-site (cookie blocked). */

const TOKEN_KEY = "aeychhotu.admin_token";

let memoryToken: string | null = null;

function hasWebStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getAdminToken(): string | null {
  if (hasWebStorage()) {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return memoryToken;
    }
  }
  return memoryToken;
}

export function storeAdminToken(token: string): void {
  memoryToken = token;
  if (hasWebStorage()) {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* Private mode / quota: the in-memory copy still serves this tab. */
    }
  }
}

/** Used by the admin 401 guard and by an explicit console logout. */
export function clearAdminToken(): void {
  memoryToken = null;
  if (hasWebStorage()) {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* Nothing else to wipe. */
    }
  }
}
