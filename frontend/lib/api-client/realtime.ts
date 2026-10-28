/* Realtime layer — how REST and Supabase/Realtime coordinate.

   Channel map (docs/7 §3):
     A  table_carts:{table_token}     cart_items INSERT/UPDATE/DELETE  (S1/S2)
     B  kds_orders                    orders INSERT → chime + refetch  (S5)
     C  order_tracker:{order_id}      orders UPDATE  → colour shifts   (S3)
     D  table_presence:{table_token}  presence → ActiveDinersBadge     (S1)

   Fallback policy: every subscription has a REST path underneath.
   - Realtime env missing (getSupabase() → null) ⇒ REST-only mode: the
     unsubscribe handle is a no-op and callers keep their REST cadence.
   - watchOrderStatus() starts with an immediate REST read, arms the
     channel, and only keeps polling while the channel is not live —
     so a dead socket degrades to polite 5s polling instead of silence.

   SECURITY: the browser holds only the public anon key PLUS the
   read-scoped `realtime_token` minted by E1/E2 (see realtime-auth.ts).
   Its claims are what the RLS policies in backend/sql/001_init.sql match
   on, so events are filtered to this diner's table (or the whole floor
   for a staff token). Without that token the policies match no rows:
   the client degrades to REST instead of leaking other tables' data.
   The service_role key must never appear here. */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getLiveOrderStatus } from "./endpoints";
import { getRealtimeAuth, onRealtimeAuthChange } from "./realtime-auth";
import type { CartLine, LiveOrderStatus, OrderStatus } from "./types";

let supabaseInstance: SupabaseClient | null = null;
let supabaseInitialized = false;

/** Lazy, env-driven engine client. Returns null when unconfigured so the
    app can run REST-only without throwing at import time. */
export function getSupabase(): SupabaseClient | null {
  if (supabaseInitialized) return supabaseInstance;
  supabaseInitialized = true;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  supabaseInstance = createClient(url, anonKey, {
    // Read the RLS-scoped token live so REST calls always use the current one.
    accessToken: async () => getRealtimeAuth(),
  });

  const instance = supabaseInstance;

  /* CRITICAL — `accessToken` does NOT authenticate the Realtime socket.
     supabase-js applies it to REST requests only; the websocket still
     connects as `anon`, the claim-scoped RLS policies match no rows, and
     every postgres_changes event is dropped with no error anywhere. The
     channel even reports SUBSCRIBED, so the UI looks healthy while nothing
     streams.

     In the normal flow E1 (diner) / E2 (staff) resolve BEFORE this client is
     created, so the change listener below never fires — this explicit push
     is what actually authorizes the socket. Verified against a live project:
     a subscription with `accessToken` alone receives nothing, while one that
     also calls setAuth receives events. */
  const existingToken = getRealtimeAuth();
  if (existingToken) instance.realtime.setAuth(existingToken);

  // A token arriving (or being cleared) after the socket is open is pushed
  // straight in, so a re-login or sign-out takes effect without a reload.
  onRealtimeAuthChange((token) => {
    void instance.realtime.setAuth(token ?? undefined);
  });

  return supabaseInstance;
}

type Detach = () => void;
const NOOP_DETACH: Detach = () => undefined;

// ---- A. Shared table cart room ----------------------------------------

export interface CartChangeEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  table_token: string;
  /** Full row for INSERT/UPDATE; null for DELETE. */
  line: CartLine | null;
  /** Old row fragment (id at minimum) for DELETE. */
  previous: Partial<CartLine> | null;
}

export function subscribeTableCart(
  tableId: string,
  tableToken: string,
  onChange: (change: CartChangeEvent) => void,
): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel(`table_carts:${tableToken}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "cart_items", filter: `table_id=eq.${tableId}` },
      (payload) => {
        const event = payload.eventType as "INSERT" | "UPDATE" | "DELETE";
        onChange({
          event,
          table_token: tableToken,
          line: event === "DELETE" ? null : (payload.new as unknown as CartLine),
          previous: (payload.old as unknown as Partial<CartLine> | null) ?? null,
        });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- Catalog & floor updates (admin console / floor board) ------------

/** menu_items AND menu_item_images INSERT/UPDATE/DELETE.

    Both tables are watched on ONE channel because an 86 writes menu_items
    while a replaced dish photo writes menu_item_images: a diner's open menu
    has to react to either without a refresh. sql/011 publishes
    menu_item_images and grants read on its non-secret columns for exactly
    this. */
export function subscribeMenuUpdates(onUpdate: () => void): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel("menu_updates")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "menu_items" },
      () => {
        onUpdate();
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "menu_item_images" },
      () => {
        onUpdate();
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

/** What changed on a table row. `status` and `bill_status` are the two facts
    diner screens act on: 'empty' means the session was terminated, 'paid'
    means the bill was settled from another device. */
export interface TableUpdateEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  table_id: string | null;
  code: string | null;
  status: string | null;
  bill_status: string | null;
}

export function subscribeTableUpdates(
  onChange: (event: TableUpdateEvent) => void,
): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel("table_updates")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "restaurant_tables" },
      (payload) => {
        /* REPLICA IDENTITY FULL (sql/008, sql/011) means a DELETE also carries
           the old row, so an archived/removed table is detectable. */
        const row =
          (payload.new as unknown as Record<string, unknown> | null) ??
          (payload.old as unknown as Record<string, unknown> | null) ??
          {};

        const str = (value: unknown) => (typeof value === "string" ? value : null);

        onChange({
          event: payload.eventType as TableUpdateEvent["event"],
          table_id: str(row.id),
          code: str(row.code),
          status: str(row.status),
          bill_status: str(row.bill_status),
        });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- B. KDS order intake ----------------------------------------------

export interface KdsIntakeEvent {
  order_id: string;
  table_id: string;
  status: OrderStatus;
}

/** INSERT on orders → new Pending ticket + audio chime (device armed via E13). */
export function subscribeKdsOrders(onInsert: (event: KdsIntakeEvent) => void): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel("kds_orders")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "orders" },
      (payload) => {
        const row = payload.new as unknown as {
          id?: string;
          table_id?: string;
          status?: OrderStatus;
        };
        if (!row.id || !row.table_id || !row.status) return;
        onInsert({ order_id: row.id, table_id: row.table_id, status: row.status });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

/* ---- B2. Staff-wide order feed ---------------------------------------
   The KDS board only needs INSERT (docs/7 §3 B: a new ticket animates in).
   The Floor view needs UPDATE too — a ticket moving preparing→ready is
   precisely the event that tells a runner "go pick this up" — so this is a
   separate subscription rather than a widening of the board's channel.
   DELETE matters as well: pruning a ticket is what clears a table. */
export interface OrderFeedEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  order_id: string | null;
  status: OrderStatus | null;
}

export function subscribeOrdersFeed(onChange: (event: OrderFeedEvent) => void): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel("orders_feed")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "orders" },
      (payload) => {
        const row = payload.new as unknown as { id?: string; status?: OrderStatus } | null;
        const previous = payload.old as unknown as { id?: string } | null;
        onChange({
          event: payload.eventType as OrderFeedEvent["event"],
          // With REPLICA IDENTITY FULL the old record is complete, so a
          // DELETE still tells us which ticket disappeared.
          order_id: row?.id ?? previous?.id ?? null,
          status: row?.status ?? null,
        });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- C. Live progress tracker -----------------------------------------

export interface OrderTrackerEvent {
  order_id: string;
  status: OrderStatus;
}

export function subscribeOrderTracker(
  orderId: string,
  onUpdate: (event: OrderTrackerEvent) => void,
): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel(`order_tracker:${orderId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
      (payload) => {
        const row = payload.new as unknown as { id?: string; status?: OrderStatus };
        if (!row.id || !row.status) return;
        onUpdate({ order_id: row.id, status: row.status });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- D. Table presence (ActiveDinersBadge) -----------------------------

export function trackTablePresence(
  tableToken: string,
  deviceId: string,
  onCount: (activeDiners: number) => void,
): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client.channel(`table_presence:${tableToken}`);

  /* Order matters: a presence channel must be JOINED before it can carry a
     track() payload. Tracking first rejects with "tried to push 'presence'
     … before joining", the socket never registers this device, and — since
     the sync handler only fires on a subscribed channel — ActiveDinersBadge
     sat on "Syncing" forever. Subscribe, then track once per join (the
     callback re-fires on every reconnect, so the device stays registered). */
  channel
    .on("presence", { event: "sync" }, () => {
      onCount(Object.keys(channel.presenceState()).length);
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void channel.track({ device_id: deviceId, table_token: tableToken });
      }
    });

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- REST ⇄ WebSocket fallback (the coordination block) -----------------

export interface WatchOptions {
  /** Poll cadence while realtime is unavailable. Default 5000 ms. */
  pollIntervalMs?: number;
  /** Grace period before the fallback polling engages. Default 3000 ms. */
  realtimeGraceMs?: number;
}

/**
 * Tracks an order's status with realtime first and REST as the safety net:
 *   1. immediate GET /api/v1/orders/:id/status so the UI is never blank;
 *   2. channel C armed — once SUBSCRIBED, polling stands down;
 *   3. socket not live after the grace period, erroring, or closing later
 *      ⇒ polite 5 s REST polling until the next SUBSCRIBED.
 * Returns a cleanup that detaches the channel and stops all timers.
 */
export function watchOrderStatus(
  orderId: string,
  tableToken: string,
  onStatus: (status: LiveOrderStatus) => void,
  options: WatchOptions = {},
): Detach {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const realtimeGraceMs = options.realtimeGraceMs ?? 3_000;

  if (typeof window === "undefined") return NOOP_DETACH;

  let stopped = false;
  let realtimeLive = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = () => {
    if (stopped || realtimeLive || pollTimer !== null) return;
    void tick();
    pollTimer = setInterval(() => void tick(), pollIntervalMs);
  };

  async function tick(): Promise<void> {
    try {
      const status = await getLiveOrderStatus(orderId, tableToken);
      if (!stopped) onStatus(status);
    } catch {
      // Transient failure — the next tick retries; callers keep last state.
    }
  }

  void tick(); // 1. REST first paint

  let detach: Detach = NOOP_DETACH;
  const client = getSupabase();
  if (client) {
    const channel = client
      .channel(`order_tracker:${orderId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
        (payload) => {
          const row = payload.new as unknown as {
            id?: string;
            table_id?: string;
            status?: OrderStatus;
            created_at?: string;
          };
          if (!row.id || !row.status) return;
          realtimeLive = true;
          stopPolling(); // 2. live socket is authoritative now
          onStatus({
            order_id: row.id,
            table_id: row.table_id ?? "",
            status: row.status,
            created_at: row.created_at ?? "",
          });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          realtimeLive = true;
          stopPolling();
          if (graceTimer !== null) {
            clearTimeout(graceTimer);
            graceTimer = null;
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          realtimeLive = false;
          startPolling(); // 3. socket failed → REST safety net
        }
      });

    detach = () => {
      void client.removeChannel(channel);
    };

    // 2b. Not live within the grace window ⇒ engage the safety net.
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (!realtimeLive) startPolling();
    }, realtimeGraceMs);
  } else {
    startPolling(); // REST-only deployment
  }

  return () => {
    stopped = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    stopPolling();
    detach();
  };
}
