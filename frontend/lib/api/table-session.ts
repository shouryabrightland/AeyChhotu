/* The device's table session.
 *
 * Two different things live here, and they are deliberately kept apart:
 *
 *   STORED session — `{ table_token, session_pin, session_secret }` in
 *   localStorage. That is exactly the pair the QR pass carries, and it is
 *   what a refresh presents to `POST /sessions/reconnect` so the guest never
 *   sees the keypad twice while they are still sitting at the table. It is a
 *   bearer credential, scoped to one device and one table; clearing storage
 *   is the documented way to leave the table.
 *
 *   GRANTED session — the same credentials plus the table's identity, held
 *   in memory for the lifetime of the page. `useLiveTable` reads it to know
 *   which table it is rendering; it is never persisted separately because it
 *   carries nothing that is not already in storage.
 *
 * Nothing here talks to the network: the gate owns that, so there is exactly
 * one place where session state can change.
 */

const STORAGE_KEY = "aeychhotu.table_session.v1";

export interface StoredTableSession {
  table_token: string;
  session_pin: string;
  session_secret: string;
}

export interface GrantedTableSession {
  table_id: string;
  /** restaurant_tables.code — the token from the URL. */
  code: string;
  name: string;
  session_pin: string;
  session_secret: string;
  /** The Chhotu assistant's key, handed over by the join/reconnect reply.
      MEMORY ONLY: it is never written to localStorage, so the stored shape
      stays exactly `{ table_token, session_pin, session_secret }` and a
      returning device gets a fresh copy when it reconnects. */
  gemini_api_key: string | null;
}

function read(): StoredTableSession | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredTableSession>;
    if (
      typeof parsed.table_token !== "string" ||
      typeof parsed.session_pin !== "string" ||
      typeof parsed.session_secret !== "string"
    ) {
      return null;
    }
    return {
      table_token: parsed.table_token,
      session_pin: parsed.session_pin,
      session_secret: parsed.session_secret,
    };
  } catch {
    // Blocked or corrupt storage simply means "no session here".
    return null;
  }
}

function write(value: StoredTableSession | null) {
  if (typeof window === "undefined") return;

  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* Storage can be full or blocked; the in-memory session still works. */
  }
}

/** The device's credentials for THIS table, or null (different table / none). */
export function readStoredSession(tableToken: string): StoredTableSession | null {
  const stored = read();
  return stored && stored.table_token === tableToken ? stored : null;
}

/** Remember a granted session on the device, so a refresh reconnects. */
export function storeSession(session: GrantedTableSession) {
  write({
    table_token: session.code,
    session_pin: session.session_pin,
    session_secret: session.session_secret,
  });
}

/** Forget the table entirely (session ended, or the secret was rejected). */
export function clearStoredSession(tableToken?: string) {
  const stored = read();
  if (tableToken && stored && stored.table_token !== tableToken) return;
  write(null);
}

// ---- In-memory granted session ----------------------------------------

let granted: GrantedTableSession | null = null;

export function rememberGrantedSession(session: GrantedTableSession) {
  granted = session;
}

export function forgetGrantedSession() {
  granted = null;
}

export function getGrantedSession(tableToken: string): GrantedTableSession | null {
  return granted && granted.code === tableToken ? granted : null;
}
