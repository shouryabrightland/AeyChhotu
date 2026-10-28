/* Bill requests — the diner's "can we have the bill?" signal and a server's
   settlement of it.

   Prototype scope, deliberately: this is a browser-side channel, not an API.
   The request and the settle are written to localStorage and mirrored over
   BroadcastChannel, so two tabs on one machine see each other instantly —
   which is what the demo needs. It is NOT a substitute for a server column:
   a diner's phone and a separate floor tablet only sync once this moves into
   the API (docs/7 has no bill endpoint today). Keep this surface small so
   that swap replaces one file. */

export interface BillEvent {
  table_code: string;
  requested_at: string;
  /** Set once a server has taken payment. */
  settled_at: string | null;
}

export type BillMap = Record<string, BillEvent>;

const STORAGE_KEY = "aeychhotu.bills.v1";
const CHANNEL_NAME = "aeychhotu.bills.v1";
/* A request nobody ever settles must not haunt the board forever. */
const STALE_AFTER_MS = 15 * 60_000;

function prune(map: BillMap): BillMap {
  const now = Date.now();
  const next: BillMap = {};

  for (const [code, event] of Object.entries(map)) {
    const stamp = Date.parse(event.settled_at ?? event.requested_at);
    if (Number.isNaN(stamp) || now - stamp > STALE_AFTER_MS) continue;
    next[code] = event;
  }

  return next;
}

function load(): BillMap {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return prune(JSON.parse(raw) as BillMap);
  } catch {
    return {};
  }
}

let state: BillMap = load();
const listeners = new Set<() => void>();

const channel: BroadcastChannel | null =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

if (channel) {
  channel.onmessage = (event: MessageEvent<{ bills?: BillMap }>) => {
    if (!event.data?.bills) return;
    state = event.data.bills;
    emit();
  };
}

/* The `storage` event is the fallback for browsers without BroadcastChannel;
   it fires in every other tab of this origin. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      state = prune(JSON.parse(event.newValue) as BillMap);
      emit();
    } catch {
      /* Ignore a corrupt or half-written payload; the in-memory copy stands. */
    }
  });
}

function emit() {
  for (const listener of listeners) listener();
}

function commit(next: BillMap) {
  state = next;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* Storage can be blocked or full; other tabs still hear the channel. */
    }
  }

  emit();
  channel?.postMessage({ bills: next });
}

export function getBills(): BillMap {
  return state;
}

export function getBill(tableCode: string): BillEvent | null {
  return state[tableCode] ?? null;
}

export function subscribeBills(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The diner asked for the bill. Idempotent — asking twice is one request. */
export function requestBill(tableCode: string): void {
  if (state[tableCode]) return;

  commit({
    ...state,
    [tableCode]: {
      table_code: tableCode,
      requested_at: new Date().toISOString(),
      settled_at: null,
    },
  });
}

/* A server took payment. Keeps the event so the diner can thank them.

   Works even when the guest never tapped "request the bill": the floor
   tablet can settle a table directly, and the diner's screen must still show
   the thank-you instead of waiting for an event that will never exist. The
   missing request is back-filled with the settlement time. */
export function settleBill(tableCode: string): void {
  const existing = state[tableCode];
  if (existing?.settled_at) return;

  const settledAt = new Date().toISOString();
  commit({
    ...state,
    [tableCode]: {
      table_code: tableCode,
      requested_at: existing?.requested_at ?? settledAt,
      settled_at: settledAt,
    },
  });
}

/** The diner has seen the thanks screen — drop the event entirely. */
export function acknowledgeSettlement(tableCode: string): void {
  if (!state[tableCode]?.settled_at) return;

  const next = { ...state };
  delete next[tableCode];
  commit(next);
}
