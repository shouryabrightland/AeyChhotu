"use client";

/* useLiveTable — the Diner side data runtime.

   Strategy: LIVE ONLY.
   1. Every read/write goes through the api-client to the Express backend
      (20 s timeout, ApiError envelope parsing).
   2. When the backend is unreachable (status 0) or answers with an error, the
      hook moves to its real `error` phase. The screen shows the API's own
      message and a Retry button. Nothing is ever served from a seeded local
      store: a guest looking at a menu must be looking at the kitchen's menu.
   3. Realtime: `table_carts` streams cart mutations, `order_tracker` streams
      status flips and `restaurant_tables` streams bill/settle/clear. Every one
      of them has a REST fallback underneath:
        * cart     — 5 s poll
        * table    — 5 s poll of `GET /sessions/:token` (bill + status)
        * orders   — 15 s poll
      so a deployment without Supabase is slower, never frozen.

   One instance powers the menu screen, the cart modal and the tracker, so
   every view at a table observes exactly the same snapshot.

   HOUSE RULES THIS FILE KEEPS:
   * `bill_status` comes from the SERVER (docs/14 #5). The old browser-local
     bill store is gone from every live screen; two phones cannot disagree.
   * Refreshing is SOFT (#1): it re-reads and swaps the snapshot in place, so
     the menu, the deck position, skipped cards and scroll survive.
   * Cart writes are optimistic (#4): an add, a ± tap and a remove all paint
     first and reconcile after, with the badge reading "Syncing".
   * A poll can never manufacture "someone else changed the cart" (#6): the
     external diff is skipped whenever a local write overlapped the request. */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  dismissDeniedOrder as apiDismissDeniedOrder,
  fetchAllPages,
  fireTableOrder as apiFire,
  getCartItems as apiGetCartItems,
  getMenu as apiGetMenu,
  getOrders as apiGetOrders,
  getTableState as apiGetTableState,
  checkActiveOrder,
  removeCartItem as apiRemoveCartItem,
  requestTableBill as apiRequestTableBill,
  requeueDeniedOrder as apiRequeueDeniedOrder,
  retryDeniedOrder as apiRetryDeniedOrder,
  subscribeMenuUpdates,
  subscribeTableCart,
  subscribeTableUpdates,
  toCartLine,
  toMenuItem,
  toOrder,
  toTable,
  updateCartItem as apiUpdateCartItem,
  upsertCartItem as apiUpsertCartItem,
  watchOrderStatus,
  type BillStatus,
} from "@/lib/api-client";
import { getStoredDisplayName } from "@/lib/api/session";
import { clearStoredSession, forgetGrantedSession, getGrantedSession } from "@/lib/api/table-session";
import type { CartLine, MenuItem, Order, RestaurantTable } from "@/lib/api/types";

export type LivePhase = "loading" | "error" | "success";

/** Which device caused a cart reload — it decides whether the result is news. */
type CartSyncSource = "local" | "external";

/**
 * A change to the shared cart that this device did NOT make itself.
 *
 * Raised by an incoming realtime event or by the REST safety net below, and
 * only when the reloaded cart actually differs from what is on screen — a
 * poll that finds nothing new stays silent.
 */
export interface CartChangeNotice {
  /** Monotonic id: consumers raise one toast per id, never per payload. */
  id: number;
  /** Lines another device put on the table. */
  added: CartLine[];
  /** Lines another device took off. */
  removed: CartLine[];
  /** Lines another device bumped, with how many they added. */
  increased: { line: CartLine; delta: number }[];
}

/** Empty ⇒ nothing happened, so no notice is raised. */
function diffCart(
  previous: CartLine[],
  next: CartLine[],
): Omit<CartChangeNotice, "id"> | null {
  const before = new Map(previous.map((line) => [line.id, line]));
  const after = new Set(next.map((line) => line.id));

  const added = next.filter((line) => !before.has(line.id));
  const removed = previous.filter((line) => !after.has(line.id));
  const increased: { line: CartLine; delta: number }[] = [];
  for (const line of next) {
    const prior = before.get(line.id);
    if (prior && line.quantity > prior.quantity) {
      increased.push({ line, delta: line.quantity - prior.quantity });
    }
  }

  if (added.length === 0 && removed.length === 0 && increased.length === 0) return null;
  return { added, removed, increased };
}

/** Normalized failure the cart modal renders (contract envelope aware). */
export interface FireFailure {
  code: string;
  message: string;
  soldOut: string[];
  fields: Record<string, string>;
}

/** One line of the "what will be re-fired" preview a denied order shows. */
export interface DeniedRetryLine {
  name: string;
  quantity: number;
}

/** The plan the Retry confirmation modal renders BEFORE anything is written. */
export interface DeniedRetryPlan {
  order_id: string;
  reason: string;
  /** Lines that still exist and can be re-fired. */
  keep: DeniedRetryLine[];
  /** Lines the kitchen no longer has — they will be left out. */
  omitted: DeniedRetryLine[];
}

export interface DeniedActionResult {
  ok: boolean;
  message?: string;
  /** Dish names that could not be moved back (out of stock). */
  omitted?: string[];
}

interface Snapshot {
  table: RestaurantTable;
  menu: MenuItem[];
  cart: CartLine[];
  orders: Order[];
  billStatus: BillStatus;
  activeDevices: number;
}

const LIST_LIMIT = 100;

/** Quiet time before a burst of ± taps is written as one summed delta. */
const QUANTITY_BURST_MS = 300;

/** Safety-net cadence for the cart while realtime is unavailable. */
const CART_POLL_MS = 5_000;
/** Table status + bill lifecycle (settle/clear) without realtime. */
const TABLE_POLL_MS = 5_000;
/** Order history/status without realtime (watchOrderStatus has its own 5 s). */
const ORDERS_POLL_MS = 15_000;

export interface LiveTableValue {
  phase: LivePhase;
  /** Non-null only in the error phase (real backend/contract failure). */
  error: ApiError | null;
  retry: () => void;
  refresh: () => Promise<void>;
  /** A soft re-read is in flight — the refresh icon spins, nothing unmounts. */
  refreshing: boolean;

  table: RestaurantTable | null;
  menu: MenuItem[];
  cart: CartLine[];
  orders: Order[];
  menuIndex: Map<string, MenuItem>;
  quantities: Record<string, number>;
  totals: { lineCount: number; itemCount: number; total: number };
  activeOrder: Order | null;
  soldOutInCart: MenuItem[];

  /** The server's bill lifecycle for this table (source of truth). */
  billStatus: BillStatus;
  /** A ticket is still pending/preparing/ready — food is in the kitchen. */
  hasCookingOrders: boolean;
  /** Devices heartbeating on this table (server registry). */
  activeDevices: number;

  /** The newest refused round, or null. Drives the denied tracker screen. */
  deniedOrder: Order | null;
  /** What Retry would re-fire, and what it would leave out. */
  deniedRetryPlan: DeniedRetryPlan | null;

  /** Per-item add failures keyed by menu item id → inline row messages. */
  itemErrors: Record<string, string>;

  /** A cart change that arrived from ANOTHER device (realtime event or the
      REST safety net). Null until the first one lands. */
  cartNotice: CartChangeNotice | null;

  /** True while this device has a cart write in flight. The cart badge shows
      "Syncing" from it, so a tap reads as instant instead of unanswered. */
  syncing: boolean;

  addToCart: (item: MenuItem, addedBy: string) => Promise<{ ok: boolean; message?: string }>;
  updateLine: (
    cartItemId: string,
    patch: {
      quantity?: number;
      quantity_delta?: number;
      request_note?: string;
      allergy_note?: string;
    },
  ) => Promise<void>;
  removeLine: (cartItemId: string) => Promise<void>;
  fire: () => Promise<{ ok: true } | { ok: false; failure: FireFailure }>;

  /** Asks the server for the bill (idempotent on the server too). */
  requestBill: () => Promise<{ ok: boolean; message?: string }>;

  /** Retry: move the still-available lines and fire again, atomically. */
  retryDenied: () => Promise<DeniedActionResult>;
  /** Move to list: the same, but stop at the editable cart. */
  moveDeniedToCart: () => Promise<DeniedActionResult>;
  /** Cancel: discard the refused round (only denied orders can be). */
  dismissDenied: () => Promise<DeniedActionResult>;
}

export function useLiveTable(tableToken: string): LiveTableValue {
  const router = useRouter();
  const [phase, setPhase] = useState<LivePhase>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [table, setTable] = useState<RestaurantTable | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [billStatus, setBillStatus] = useState<BillStatus>("unrequested");
  const [activeDevices, setActiveDevices] = useState(0);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [cartNotice, setCartNotice] = useState<CartChangeNotice | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  /* Adds this device has sent but not been answered for yet, keyed by dish.
     They are painted on top of the server cart, so a tap lands in the cart
     panel in the same frame — the round trip happens behind it. Each entry is
     dropped the moment the server's own cart (reconciled right after the
     write) contains the dish, so nothing is ever counted twice. */
  const [pendingAdds, setPendingAdds] = useState<
    Record<string, { quantity: number; added_by: string }>
  >({});
  /* The same idea for a line that already exists: a ± tap or a remove paints
     at once and is reconciled when the server's cart is read back (#4). */
  const [lineAdjustments, setLineAdjustments] = useState<Record<string, number>>({});
  const [removedLines, setRemovedLines] = useState<Record<string, true>>({});

  /** A write is in flight: the cart badge says "Syncing" instead of lying
      about being finished. A counter, because taps can overlap. */
  const [syncing, setSyncing] = useState(false);
  const syncsInFlightRef = useRef(0);
  /** Monotonic write counter: a poll that overlapped a local write must not
      diff its result into a "someone else changed the cart" notice (#6). */
  const writeSeqRef = useRef(0);

  /** Mirror of `cart`, so an async reload diffs against what is ON SCREEN
      rather than a stale closure. Server truth only, never the optimistic
      overlay — a notice about "someone else's change" must not be raised by
      this device's own tap. */
  const cartRef = useRef<CartLine[]>([]);
  const noticeSeqRef = useRef(0);

  const tableIdRef = useRef<string | null>(null);
  const tableCodeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const refreshingRef = useRef(false);
  /** Real data has been on screen. A failed poll or realtime refetch must
      keep it there instead of replacing the whole screen with an error. */
  const hasDataRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* A settled / released / rotated session is not a screen a guest can
     usefully retry: drop the dead credentials and let the route show its
     SessionEndedState. Kept in one place so realtime, the poll and a manual
     refresh all end the visit the same way. */
  const endSession = useCallback(() => {
    clearStoredSession(tableToken);
    forgetGrantedSession();
    if (!mountedRef.current) return;
    setError(
      new ApiError(
        403,
        "SESSION_ENDED",
        "This table session has ended. Scan the table's QR code to start a new one.",
      ),
    );
    setPhase("error");
  }, [tableToken]);

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    if (!mountedRef.current) return;
    hasDataRef.current = true;
    tableIdRef.current = snapshot.table.id;
    tableCodeRef.current = snapshot.table.code;
    setTable(snapshot.table);
    setMenu(snapshot.menu);
    cartRef.current = snapshot.cart;
    setCart(snapshot.cart);
    setOrders(snapshot.orders);
    setBillStatus(snapshot.billStatus);
    setActiveDevices(snapshot.activeDevices);
  }, []);

  /* ---- Optimistic cart writes ----------------------------------------
     The cart panel must answer a tap, not a round trip: an add is painted
     immediately (`pendingAdds`), a ± tap or remove paints over the matching
     line (`lineAdjustments` / `removedLines`), and the badge reads
     "Syncing" until the server's own cart has been read back into `cart`. */
  const beginSync = useCallback(() => {
    syncsInFlightRef.current += 1;
    writeSeqRef.current += 1;
    if (mountedRef.current) setSyncing(true);
  }, []);

  const endSync = useCallback(() => {
    syncsInFlightRef.current = Math.max(0, syncsInFlightRef.current - 1);
    writeSeqRef.current += 1;
    if (syncsInFlightRef.current === 0 && mountedRef.current) setSyncing(false);
  }, []);

  const pushPendingAdd = useCallback((menuItemId: string, addedBy: string) => {
    setPendingAdds((current) => ({
      ...current,
      [menuItemId]: {
        quantity: (current[menuItemId]?.quantity ?? 0) + 1,
        added_by: addedBy,
      },
    }));
  }, []);

  const popPendingAdd = useCallback((menuItemId: string) => {
    setPendingAdds((current) => {
      const existing = current[menuItemId];
      if (!existing) return current;

      const next = { ...current };
      if (existing.quantity <= 1) delete next[menuItemId];
      else next[menuItemId] = { ...existing, quantity: existing.quantity - 1 };
      return next;
    });
  }, []);

  const bumpLineAdjustment = useCallback((cartItemId: string, delta: number) => {
    setLineAdjustments((current) => {
      const next = { ...current };
      const value = (next[cartItemId] ?? 0) + delta;
      if (value === 0) delete next[cartItemId];
      else next[cartItemId] = value;
      return next;
    });
  }, []);

  const clearLineAdjustment = useCallback((cartItemId: string) => {
    setLineAdjustments((current) => {
      if (!(cartItemId in current)) return current;
      const next = { ...current };
      delete next[cartItemId];
      return next;
    });
  }, []);

  const clearRemovedLine = useCallback((cartItemId: string) => {
    setRemovedLines((current) => {
      if (!(cartItemId in current)) return current;
      const next = { ...current };
      delete next[cartItemId];
      return next;
    });
  }, []);

  /* This hook does NOT authenticate. The session gate has already claimed or
     joined the table and left the granted credentials in the client store;
     reading them here is what makes "is this guest in?" a single decision in
     a single place, instead of a second initialize() call that would answer
     `locked` on every reload and wipe the screen. */
  const loadLive = useCallback(async (): Promise<Snapshot> => {
    const session = getGrantedSession(tableToken);
    if (!session) {
      throw new ApiError(0, "SESSION_REQUIRED", "Join this table to see its menu.");
    }

    // Menu + cart must be COMPLETE (dish 101 still has to render), so they
    // walk every page. Order history stays newest-first page 1: the active
    // order is always the newest row, so the tracker can never miss it.
    const [menuRows, cartRows, orderPage, state] = await Promise.all([
      fetchAllPages((page) => apiGetMenu(tableToken, { page, limit: LIST_LIMIT })),
      fetchAllPages((page) => apiGetCartItems(tableToken, { page, limit: LIST_LIMIT })),
      apiGetOrders(tableToken, { limit: LIST_LIMIT }),
      apiGetTableState(tableToken),
    ]);

    /* A table can be cleared between the gate's reconnect and this read.
       Answering with the empty shell would show a menu for a session that no
       longer exists, so this is the same SESSION_ENDED the gate understands. */
    if (state.status !== "active") {
      throw new ApiError(
        403,
        "SESSION_ENDED",
        "This table session has ended. Scan the table's QR code to start a new one.",
      );
    }

    return {
      table: toTable({
        table_id: session.table_id,
        code: session.code,
        name: session.name,
        status: "active",
      }),
      menu: menuRows.map(toMenuItem),
      cart: cartRows.map(toCartLine),
      orders: orderPage.data.map((row) => toOrder(row, session.code)),
      billStatus: state.bill_status,
      activeDevices: state.active_devices,
    };
  }, [tableToken]);

  /** Fails the screen honestly: real message, real Retry button. */
  const fail = useCallback((err: unknown) => {
    if (!mountedRef.current) return;
    setError(
      err instanceof ApiError
        ? err
        : new ApiError(0, "INTERNAL_ERROR", "Something went wrong loading this table."),
    );
    setPhase("error");
  }, []);

  /* `external` marks a reload this device did NOT ask for — an incoming
     realtime event or the REST safety net. Only those can be news: the
     mutations below refresh on purpose, and telling a guest about their own
     tap is noise. `silent` keeps the safety net from throwing the screen into
     its error phase over one dropped read.

     Race guard (#6): a poll that was in flight while a local write finished
     must not diff its (older) result against the fresh cart. The write
     counter is captured before the request and compared after; any overlap
     means the result is applied silently. */
  const reloadCart = useCallback(
    async (source: CartSyncSource = "local", silent = false) => {
      const seqAtStart = writeSeqRef.current;

      try {
        const rows = await fetchAllPages((page) =>
          apiGetCartItems(tableToken, { page, limit: LIST_LIMIT }),
        );
        if (!mountedRef.current) return;

        const next = rows.map(toCartLine);

        /* Nothing new ⇒ do not touch state. The 5 s poll then costs zero
           renders on a quiet table instead of re-painting the whole menu. */
        if (JSON.stringify(cartRef.current) === JSON.stringify(next)) return;

        /* The DISH the other device changed is only news if no write of ours
           overlapped this read and nothing is still in flight. */
        const cleanRead = seqAtStart === writeSeqRef.current && syncsInFlightRef.current === 0;
        if (source === "external" && cleanRead) {
          const change = diffCart(cartRef.current, next);
          if (change) {
            noticeSeqRef.current += 1;
            setCartNotice({ id: noticeSeqRef.current, ...change });
          }
        }

        cartRef.current = next;
        setCart(next);
      } catch (err) {
        if (silent) return;
        // A refetch failure keeps the cart that is already on screen.
        if (hasDataRef.current) {
          console.warn("cart reload failed:", err);
          return;
        }
        fail(err);
      }
    },
    [tableToken, fail],
  );

  const reloadOrders = useCallback(
    async (silent = false) => {
      try {
        // Newest-first: page 1 always holds the active order. History beyond
        // 100 rows is archival, so it is deliberately not walked (see loadLive).
        const page = await apiGetOrders(tableToken, { limit: LIST_LIMIT });
        if (mountedRef.current) {
          const next = page.data.map((row) => toOrder(row, tableCodeRef.current ?? tableToken));
          setOrders((current) =>
            JSON.stringify(current) === JSON.stringify(next) ? current : next,
          );
        }
      } catch (err) {
        if (silent) return;
        if (hasDataRef.current) {
          console.warn("order reload failed:", err);
          return;
        }
        fail(err);
      }
    },
    [tableToken, fail],
  );

  /* The server's bill lifecycle + table status. This is what replaces the
     browser-local bill store (#5) and the missing table poll (#3): a settle
     or a clear reaches every phone in ~5 s even with no Supabase. */
  const reloadTableState = useCallback(
    async (silent = true) => {
      try {
        const state = await apiGetTableState(tableToken);
        if (!mountedRef.current) return;

        if (state.status !== "active") {
          endSession();
          return;
        }

        tableIdRef.current = state.table_id;
        setBillStatus(state.bill_status);
        setActiveDevices(state.active_devices);
      } catch (err) {
        if (err instanceof ApiError && (err.error === "SESSION_ENDED" || err.error === "SESSION_REQUIRED")) {
          endSession();
          return;
        }
        if (!silent) fail(err);
      }
    },
    [tableToken, endSession, fail],
  );

  /* An 86 or a replaced photo must reach this screen without a refresh: the
     kitchen flips availability on the menu channel and every open diner menu
     follows. Walking all pages keeps the whole catalog in sync, not just the
     page that happens to be visible. */
  const reloadMenu = useCallback(async () => {
    try {
      const rows = await fetchAllPages((page) =>
        apiGetMenu(tableToken, { page, limit: LIST_LIMIT }),
      );
      if (!mountedRef.current) return;
      const next = rows.map(toMenuItem);
      setMenu((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    } catch (err) {
      // Keep the menu already on screen; the initial load owns the error state.
      if (hasDataRef.current) {
        console.warn("menu reload failed:", err);
        return;
      }
      fail(err);
    }
  }, [tableToken, fail]);

  // ---- Initial load + every hard retry ---------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setPhase("loading");
      setError(null);
      setItemErrors({});

      try {
        const snapshot = await loadLive();
        if (cancelled) return;
        applySnapshot(snapshot);
        setPhase("success");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err);
        } else {
          setError(new ApiError(0, "INTERNAL_ERROR", "Something went wrong loading this table."));
          console.error(err);
        }
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tableToken, reloadKey, loadLive, applySnapshot]);

  /* ---- Soft refresh (docs/14 #1) --------------------------------------
     The refresh icon used to bump `reloadKey`, which put the page back into
     `loading` and unmounted the menu — losing deck position, skipped cards,
     scroll and any open sheet. A refresh now re-reads and swaps the snapshot
     in place; only a hard Retry (from the error screen) resets `loading`. */
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    if (mountedRef.current) setRefreshing(true);

    try {
      const snapshot = await loadLive();
      if (!mountedRef.current) return;
      applySnapshot(snapshot);
      setPhase("success");
      setError(null);
      setItemErrors({});
      // A full re-read supersedes any optimistic overlay (#9).
      setPendingAdds({});
      setLineAdjustments({});
      setRemovedLines({});
    } catch (err) {
      if (err instanceof ApiError && (err.error === "SESSION_ENDED" || err.error === "SESSION_REQUIRED")) {
        endSession();
      } else if (err instanceof ApiError && err.error === "TABLE_NOT_FOUND") {
        fail(err);
      } else {
        // A dropped refresh keeps the screen: the polls retry.
        console.warn("refresh failed:", err);
      }
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, [loadLive, applySnapshot, endSession, fail]);

  // ---- Realtime A: table_carts -----------------------------------------
  useEffect(() => {
    if (phase !== "success" || !table) return;

    return subscribeTableCart(table.id, tableToken, () => {
      void reloadCart("external");
    });
  }, [phase, table, tableToken, reloadCart]);

  /* REST safety net for the cart. With Supabase unconfigured every
     subscription above is a NO-OP (getSupabase() → null), so without this
     poll a guest who never touched their own screen watched a frozen cart
     forever. A failed read is swallowed because one dropped request must not
     flip the whole screen into its error phase. */
  useEffect(() => {
    if (phase !== "success") return;

    const timer = window.setInterval(() => {
      void reloadCart("external", true);
    }, CART_POLL_MS);

    return () => window.clearInterval(timer);
  }, [phase, reloadCart]);

  /* REST safety net for the TABLE ROW itself (docs/14 #3): a settle by the
     floor or a clear by staff must land on a phone with no realtime. */
  useEffect(() => {
    if (phase !== "success") return;

    const timer = window.setInterval(() => {
      void reloadTableState(true);
    }, TABLE_POLL_MS);

    return () => window.clearInterval(timer);
  }, [phase, reloadTableState]);

  /* REST safety net for the order list (the tracker's active order and the
     denied-round panel). watchOrderStatus already polls the newest ticket
     while its channel is down; this keeps the LIST fresh too. */
  useEffect(() => {
    if (phase !== "success") return;

    const timer = window.setInterval(() => {
      void reloadOrders(true);
    }, ORDERS_POLL_MS);

    return () => window.clearInterval(timer);
  }, [phase, reloadOrders]);

  // ---- Realtime D2: restaurant_tables (bill requests, settles, release) --
  /* Three different things arrive on this one channel:
       * status → 'empty'  the table was cleared: end the visit (credentials
         are dead; the route shows its SessionEndedState).
       * bill_status → 'paid'  the floor took payment. Nothing is wiped here
         (docs/14 #22): if food is still cooking the guest keeps the tracker
         and history and sees a "paid" banner; the thank-you screen appears
         once no ticket is active.
       * anything else  a bill request or a new session: re-read.
     The handler also ignores rows for another table (#28), so a misconfigured
     policy or a staff token can never end this table by accident. */
  useEffect(() => {
    if (phase !== "success" || !table) return;

    return subscribeTableUpdates((change) => {
      if (change.table_id && switchToForeignTable(change.table_id, table.id)) return;
      if (change.code && switchToForeignTable(change.code, table.code)) return;

      if (change.event === "DELETE" || change.status === "empty") {
        endSession();
        return;
      }

      void reloadTableState();
      void reloadCart("external");
      void reloadOrders();
    });
  }, [phase, table, tableToken, endSession, reloadTableState, reloadCart, reloadOrders]);

  // ---- Realtime E: menu_items + menu_item_images ------------------------
  useEffect(() => {
    if (phase !== "success") return;

    return subscribeMenuUpdates(() => {
      void reloadMenu();
    });
  }, [phase, reloadMenu]);

  // ---- Realtime C: order_tracker for the active order ------------------
  /* `activeOrder` is the newest ticket that is actually IN the kitchen.
     Served and DENIED are excluded (#8): a refused round no longer exists, so
     it must not keep the nav's live dot pulsing. */
  const activeOrder = useMemo(() => {
    return (
      [...orders]
        .filter(
          (order) =>
            order.status === "pending" ||
            order.status === "preparing" ||
            order.status === "ready",
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .at(0) ?? null
    );
  }, [orders]);

  const activeOrderId = activeOrder?.id ?? null;
  const activeOrderStatus = activeOrder?.status ?? null;

  useEffect(() => {
    if (phase !== "success" || !activeOrderId) return;

    return watchOrderStatus(activeOrderId, tableToken, (statusUpdate) => {
      if (!mountedRef.current) return;
      setOrders((current) =>
        current.map((order) =>
          order.id === statusUpdate.order_id ? { ...order, status: statusUpdate.status } : order,
        ),
      );
    });
  }, [phase, activeOrderId, activeOrderStatus, tableToken]);

  /* What the cart surfaces render: the server's cart, minus lines this device
     has just removed, plus its unconfirmed adds and ± adjustments. */
  const visibleCart = useMemo<CartLine[]>(() => {
    const pendingIds = Object.keys(pendingAdds);
    const hasOverlay =
      pendingIds.length > 0 ||
      Object.keys(lineAdjustments).length > 0 ||
      Object.keys(removedLines).length > 0;

    if (!hasOverlay) return cart;

    const lines = cart
      .filter((line) => !removedLines[line.id])
      .map((line) => ({ ...line }));

    for (const line of lines) {
      const delta = lineAdjustments[line.id];
      if (delta) line.quantity += delta;
    }

    for (const menuItemId of pendingIds) {
      const pending = pendingAdds[menuItemId];
      if (!pending) continue;

      const existing = lines.find((line) => line.menu_item_id === menuItemId);

      if (existing) {
        existing.quantity += pending.quantity;
        continue;
      }

      lines.push({
        // Not a server id: this tail is replaced by the real row as soon as
        // the write is reconciled. Nothing keyed off it is sent back upstream.
        id: `pending:${menuItemId}`,
        table_id: table?.id ?? "",
        menu_item_id: menuItemId,
        quantity: pending.quantity,
        request_note: "",
        allergy_note: "",
        added_by: pending.added_by,
      });
    }

    return lines;
  }, [cart, pendingAdds, lineAdjustments, removedLines, table]);

  // ---- Derived matrix (identical math to the old useTableData) ----------
  const menuIndex = useMemo(() => new Map(menu.map((item) => [item.id, item])), [menu]);

  const quantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of visibleCart) {
      map[line.menu_item_id] = (map[line.menu_item_id] ?? 0) + line.quantity;
    }
    return map;
  }, [visibleCart]);

  const totals = useMemo(() => {
    return visibleCart.reduce(
      (accumulator, line) => ({
        lineCount: accumulator.lineCount + 1,
        itemCount: accumulator.itemCount + line.quantity,
        total: accumulator.total + (menuIndex.get(line.menu_item_id)?.price ?? 0) * line.quantity,
      }),
      { lineCount: 0, itemCount: 0, total: 0 },
    );
  }, [visibleCart, menuIndex]);

  const soldOutInCart = useMemo(
    () =>
      visibleCart
        .map((line) => menuIndex.get(line.menu_item_id))
        .filter((item): item is MenuItem => item !== undefined && !item.is_available),
    [visibleCart, menuIndex],
  );

  const retry = useCallback(() => {
    setPhase("loading");
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  // ---- Mutations --------------------------------------------------------

  const addToCart = useCallback(
    async (item: MenuItem, addedBy: string): Promise<{ ok: boolean; message?: string }> => {
      /* Attribution is never anonymous: a caller that has not yet hydrated its
         name still has the confirmed one in storage. With neither, the write
         is refused here rather than landing as a "Guest" line. */
      const name = addedBy.trim() || getStoredDisplayName();
      if (!name) {
        return { ok: false, message: "Tell us your name at the table screen first." };
      }

      setItemErrors((current) => {
        if (!(item.id in current)) return current;
        const next = { ...current };
        delete next[item.id];
        return next;
      });

      /* Optimistic first, then the write: the add shows up in every cart
         surface in this frame, the badge says "Syncing", and the overlay is
         dropped once the server's cart contains the dish. A failure rolls the
         overlay back, so a refused add never looks like it landed. */
      pushPendingAdd(item.id, name);
      beginSync();

      try {
        await apiUpsertCartItem({
          table_token: tableToken,
          menu_item_id: item.id,
          quantity: 1,
          added_by: name,
        });
        await reloadCart();
        popPendingAdd(item.id);
        return { ok: true };
      } catch (err) {
        popPendingAdd(item.id);
        if (err instanceof ApiError) {
          setItemErrors((current) => ({ ...current, [item.id]: err.message }));
          if (err.error === "ITEM_UNAVAILABLE" || err.error === "MENU_ITEM_NOT_FOUND") {
            // Server-side truth changed — refresh the menu so the row greys out.
            try {
              const rows = await fetchAllPages((page) =>
                apiGetMenu(tableToken, { page, limit: LIST_LIMIT }),
              );
              if (mountedRef.current) setMenu(rows.map(toMenuItem));
            } catch {
              /* keep the inline message even if the refresh fails */
            }
          }
          return { ok: false, message: err.message };
        }
        fail(err);
        return { ok: false, message: "The dish could not be added." };
      } finally {
        endSync();
      }
    },
    [tableToken, reloadCart, fail, pushPendingAdd, popPendingAdd, beginSync, endSync],
  );

  /* A burst of ± taps is ONE write. Taps paint instantly (the overlay is
     applied on the first tap) and their deltas are summed, so five quick +
     taps become a single `quantity_delta: 5` PATCH and a single cart re-read
     instead of five of each. Note edits never take this path: they arrive
     already debounced by the row's local draft. */
  const deltaTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingDeltasRef = useRef(new Map<string, number>());

  /* A screen that goes away mid-burst must not schedule work afterwards. */
  useEffect(() => {
    const timers = deltaTimersRef.current;
    const pending = pendingDeltasRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
    };
  }, []);

  const flushQuantityDelta = useCallback(
    async (cartItemId: string) => {
      deltaTimersRef.current.delete(cartItemId);
      const delta = pendingDeltasRef.current.get(cartItemId) ?? 0;
      pendingDeltasRef.current.delete(cartItemId);
      if (delta === 0) return;

      beginSync();
      try {
        await apiUpdateCartItem(cartItemId, { table_token: tableToken, quantity_delta: delta });
        await reloadCart();
        /* The overlay this burst added is now inside the server's cart. */
        bumpLineAdjustment(cartItemId, -delta);
      } catch (err) {
        bumpLineAdjustment(cartItemId, -delta);
        if (err instanceof ApiError && err.status !== 0) {
          // Inline validation vector: the line keeps its old value and the
          // operator sees why in the console-level warning.
          console.warn("updateLine failed:", err.error, err.message);
          return;
        }
        fail(err);
      } finally {
        endSync();
      }
    },
    [tableToken, reloadCart, fail, beginSync, endSync, bumpLineAdjustment],
  );

  const updateLine = useCallback(
    async (
      cartItemId: string,
      patch: {
        quantity?: number;
        quantity_delta?: number;
        request_note?: string;
        allergy_note?: string;
      },
    ) => {
      const isPureDelta =
        patch.quantity_delta !== undefined &&
        patch.quantity === undefined &&
        patch.request_note === undefined &&
        patch.allergy_note === undefined;

      if (isPureDelta) {
        /* Paint the tap in this frame (#4)… */
        bumpLineAdjustment(cartItemId, patch.quantity_delta as number);

        /* …then wait out the burst before touching the network. */
        const accumulated =
          (pendingDeltasRef.current.get(cartItemId) ?? 0) + (patch.quantity_delta as number);
        pendingDeltasRef.current.set(cartItemId, accumulated);

        const existing = deltaTimersRef.current.get(cartItemId);
        if (existing) clearTimeout(existing);
        deltaTimersRef.current.set(
          cartItemId,
          setTimeout(() => void flushQuantityDelta(cartItemId), QUANTITY_BURST_MS),
        );
        return;
      }

      /* A note edit or an absolute quantity: exactly one write, right away. */
      beginSync();
      try {
        await apiUpdateCartItem(cartItemId, { table_token: tableToken, ...patch });
        await reloadCart();
      } catch (err) {
        if (err instanceof ApiError && err.status !== 0) {
          console.warn("updateLine failed:", err.error, err.message);
          return;
        }
        fail(err);
      } finally {
        endSync();
      }
    },
    [
      tableToken,
      reloadCart,
      fail,
      beginSync,
      endSync,
      bumpLineAdjustment,
      flushQuantityDelta,
    ],
  );

  const removeLine = useCallback(
    async (cartItemId: string) => {
      /* A queued ± burst for a line that is being removed is dropped: sending
         it afterwards would race the delete against a stale delta. */
      const queued = deltaTimersRef.current.get(cartItemId);
      if (queued) {
        clearTimeout(queued);
        deltaTimersRef.current.delete(cartItemId);
        pendingDeltasRef.current.delete(cartItemId);
      }

      /* The line disappears in this frame; a failed remove puts it back. */
      setRemovedLines((current) => ({ ...current, [cartItemId]: true }));

      beginSync();
      try {
        await apiRemoveCartItem({ table_token: tableToken, cart_item_id: cartItemId });
        await reloadCart();
        clearRemovedLine(cartItemId);
        clearLineAdjustment(cartItemId);
      } catch (err) {
        clearRemovedLine(cartItemId);
        if (err instanceof ApiError && err.status !== 0) return;
        fail(err);
      } finally {
        endSync();
      }
    },
    [tableToken, reloadCart, fail, beginSync, endSync, clearRemovedLine, clearLineAdjustment],
  );

  const fire = useCallback(async (): Promise<{ ok: true } | { ok: false; failure: FireFailure }> => {
    try {
      /* A ± burst still inside its quiet window must land BEFORE the fire:
         the RPC reads the server's cart, so an unsent delta would fire the
         old quantity and leave the tap looking lost. */
      const queued = [...deltaTimersRef.current.keys()];
      if (queued.length > 0) {
        await Promise.all(queued.map((cartItemId) => flushQuantityDelta(cartItemId)));
      }

      /* E9 — the documented anti-duplicate guardrail (Feature 7 / screen S2's
         double-tap guard). Asking first means a second tap inside the same
         second is answered from the server's own state, with the contract's
         usual "Order already sent" copy, instead of racing fire_order().
         The 409 branch below still backstops a race that slips through. */
      const active = await checkActiveOrder(tableToken);
      if (active.has_active_order) {
        await reloadOrders();
        return {
          ok: false,
          failure: {
            code: "DUPLICATE_ORDER",
            message: active.message,
            soldOut: [],
            fields: {},
          },
        };
      }

      await apiFire(tableToken);
      // Success path: the cart was drained server-side, so any optimistic
      // overlay that was still on screen is stale (#9).
      setPendingAdds({});
      setLineAdjustments({});
      setRemovedLines({});
      await Promise.all([reloadCart(), reloadOrders()]);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        // Server truth: sold-out lines were purged inside the fire RPC —
        // refresh cart + menu so the UI matches what the diner is told.
        if (err.error === "INVENTORY_FAILURE" || err.error === "EMPTY_CART") {
          await Promise.all([
            reloadCart(),
            fetchAllPages((page) => apiGetMenu(tableToken, { page, limit: LIST_LIMIT }))
              .then((rows) => {
                if (mountedRef.current) setMenu(rows.map(toMenuItem));
              })
              .catch(() => undefined),
          ]);
        }
        if (err.error === "DUPLICATE_ORDER") {
          await reloadOrders();
        }
        return {
          ok: false,
          failure: {
            code: err.error,
            message: err.message,
            soldOut: err.soldOut,
            fields: err.fields,
          },
        };
      }
      fail(err);
      return {
        ok: false,
        failure: {
          code: "INTERNAL_ERROR",
          message: "The order could not be fired.",
          soldOut: [],
          fields: {},
        },
      };
    }
  }, [tableToken, reloadCart, reloadOrders, fail, flushQuantityDelta]);

  const requestBill = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    if (billStatus !== "unrequested") return { ok: true };

    try {
      const result = await apiRequestTableBill(tableToken);
      if (mountedRef.current) setBillStatus(result.bill_status);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.error === "SESSION_ENDED") {
          endSession();
          return { ok: false, message: err.message };
        }
        return { ok: false, message: err.message };
      }
      fail(err);
      return { ok: false, message: "Could not request the bill." };
    }
  }, [billStatus, tableToken, endSession, fail]);

  /* ---- Refused rounds (denied) ----------------------------------------
     The 86 path and the chef's deny both leave a closed ticket with a
     reason. The diner gets three ways out of it, and all three go through
     the backend so two phones cannot disagree about what happened:

       Retry          → ONE atomic server call (#23): move, replace, fire.
                        A failed re-fire leaves the refused ticket intact.
       Move to list   → requeue into the editable cart
       Cancel         → discard the refused ticket */
  const deniedOrder = useMemo(() => {
    const latest = [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)).at(0);
    return latest && latest.status === "denied" ? latest : null;
  }, [orders]);

  const deniedRetryPlan = useMemo<DeniedRetryPlan | null>(() => {
    if (!deniedOrder) return null;

    const keep: DeniedRetryLine[] = [];
    const omitted: DeniedRetryLine[] = [];

    for (const item of deniedOrder.items) {
      const menuItem = menuIndex.get(item.menu_item_id);
      const line = { name: item.name, quantity: item.quantity };
      // A dish that is 86'd (or archived, hence missing from the menu) cannot
      // go back on a ticket — the fire RPC would purge it and fail again.
      if (menuItem?.is_available) keep.push(line);
      else omitted.push(line);
    }

    return {
      order_id: deniedOrder.id,
      reason: deniedOrder.denial_reason?.trim() || "The kitchen could not prepare this order.",
      keep,
      omitted,
    };
  }, [deniedOrder, menuIndex]);

  const requeueDenied = useCallback(async (): Promise<DeniedActionResult> => {
    if (!deniedOrder) {
      return { ok: false, message: "That order is no longer on screen." };
    }

    try {
      const result = await apiRequeueDeniedOrder(deniedOrder.id, tableToken);
      await Promise.all([reloadCart(), reloadOrders()]);

      if (result.moved === 0) {
        return {
          ok: false,
          omitted: result.omitted,
          message: result.omitted.length
            ? `${result.omitted.join(", ")} ${result.omitted.length === 1 ? "is" : "are"} out of stock — nothing could be moved back.`
            : "There was nothing left to move back from that order.",
        };
      }

      return { ok: true, omitted: result.omitted };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, message: err.message };
      fail(err);
      return { ok: false, message: "That order could not be moved back to the cart." };
    }
  }, [deniedOrder, tableToken, reloadCart, reloadOrders, fail]);

  const retryDenied = useCallback(async (): Promise<DeniedActionResult> => {
    if (!deniedOrder) {
      return { ok: false, message: "That order is no longer on screen." };
    }

    try {
      /* The server owns the whole operation: move → replace → fire, in one
         transaction. If it fails, the refused ticket is still there. */
      const result = await apiRetryDeniedOrder(deniedOrder.id, tableToken);
      await Promise.all([reloadCart(), reloadOrders()]);
      return { ok: true, omitted: result.omitted };
    } catch (err) {
      if (err instanceof ApiError) {
        const omitted = Array.isArray(err.details?.omitted)
          ? (err.details.omitted as string[])
          : undefined;
        await reloadOrders();
        return { ok: false, message: err.message, omitted };
      }
      fail(err);
      return { ok: false, message: "That order could not be re-fired." };
    }
  }, [deniedOrder, tableToken, reloadCart, reloadOrders, fail]);

  const dismissDenied = useCallback(async (): Promise<DeniedActionResult> => {
    if (!deniedOrder) {
      return { ok: false, message: "That order is no longer on screen." };
    }

    try {
      await apiDismissDeniedOrder(deniedOrder.id, tableToken);
      await reloadOrders();
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, message: err.message };
      fail(err);
      return { ok: false, message: "That order could not be dismissed." };
    }
  }, [deniedOrder, tableToken, reloadOrders, fail]);

  return {
    phase,
    error,
    retry,
    refresh,
    refreshing,
    table,
    menu,
    cart: visibleCart,
    orders,
    menuIndex,
    quantities,
    totals,
    activeOrder,
    soldOutInCart,
    billStatus,
    hasCookingOrders: activeOrder !== null,
    activeDevices,
    deniedOrder,
    deniedRetryPlan,
    itemErrors,
    cartNotice,
    syncing,
    addToCart,
    updateLine,
    removeLine,
    fire,
    requestBill,
    retryDenied,
    moveDeniedToCart: requeueDenied,
    dismissDenied,
  };
}

/** True when a realtime row is about a DIFFERENT table (#28). The RLS policy
    already scopes the channel, but a staff token or a misconfigured policy
    must not be able to end this guest's session. */
function switchToForeignTable(changed: string | null, current: string): boolean {
  return changed !== null && changed !== "" && changed !== current;
}
