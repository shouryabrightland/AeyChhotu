/* Anonymous diner session. The randomised table token is cached in
   localStorage so a refresh or an accidental tab close restores the live
   cart instead of orphaning the session (docs/ui-ux-blueprint.txt → strategy 3). */

const TOKEN_KEY = "aeychhotu.table_token";
const NAME_KEY = "aeychhotu.diner_name";
const DEVICE_KEY = "aeychhotu.device_id";

/* There is deliberately no "Guest" fallback: the session gate asks every
   diner for a name before it calls an endpoint, so a stored name is the only
   valid identity. An empty string means "not confirmed yet" and the gate
   keeps the menu closed until it is. */

function read(key: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Ignore blocked storage; the session simply will not be restored. */
  }
}

export function createId(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);

  return `${prefix}_${random}`;
}

export function getStoredTableToken() {
  return read(TOKEN_KEY);
}

export function storeTableToken(token: string) {
  write(TOKEN_KEY, token);
}

export function getStoredDisplayName(): string {
  return read(NAME_KEY)?.trim() ?? "";
}

/** Saves the name the gate confirmed. An empty value clears it rather than
    writing a made-up label, so no screen can inherit an anonymous identity. */
export function storeDisplayName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(NAME_KEY);
      } catch {
        /* ignore blocked storage */
      }
    }
    return;
  }
  write(NAME_KEY, trimmed);
}

export function getDeviceId() {
  const existing = read(DEVICE_KEY);
  if (existing) return existing;

  const created = createId("dev");
  write(DEVICE_KEY, created);
  return created;
}
