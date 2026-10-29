"use client";

/* useLiveTable — the Diner side data runtime.

   Strategy: LIVE ONLY.
   1. Every read/write goes through the api-client to the Express backend
      (20 s timeout, ApiError envelope parsing).
   2. When the backend is unreachable (status 0) or answers with an error, the
      hook moves to its real `error` phase. The screen shows the API's own
      message and a Retry button. Nothing is ever served from a seeded local
      store: a guest looking at a menu must be looking at the kitchen's menu.
   3. Realtime: `table_carts` streams cart mutations and `order_tracker` (via
      watchOrderStatus) streams status flips, with REST polling underneath as
      the WebSocket safety net.

   One instance powers the menu screen, the cart modal and the tracker, so
   every view at a table observes exactly the same snapshot. */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBills } from "@/hooks/use-bills";
import {
  ApiError,
  dismissDeniedOrder as apiDismissDeniedOrder,
  fetchAllPages,
  fireTableOrder as apiFire,
  getCartItems as apiGetCartItems,
  getMenu as apiGetMenu,
  getOrders as apiGetOrders,
  checkActiveOrder,
  removeCartItem as apiRemoveCartItem,
  requeueDeniedOrder as apiRequeueDeniedOrder,
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
} from "@/lib/api-client";
import { settleBill } from "@/lib/api/bill";
import {
  clearStoredSession,
  forgetGrantedSession,
  getGrantedSession,
} from "@/lib/api/table-session";
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
}

const LIST_LIMIT = 100;

/** Safety-net cadence for the cart while realtime is unavailable. */
const CART_POLL_MS = 5_000;

export interface LiveTableValue {
  phase: LivePhase;
  /** Non-null only in the error phase (real backend/contract failure). */
  error: ApiError | null;
  retry: () => void;
  refresh: () => Promise<void>;

  table: RestaurantTable | null;
  menu: MenuItem[];
  cart: CartLine[];
  orders: Order[];
  menuIndex: Map<string, MenuItem>;
  quantities: Record<string, number>;
  totals: { lineCount: number; itemCount: number; total: number };
  activeOrder: Order | null;
  soldOutInCart: MenuItem[];

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

  /** Retry: move the still-available lines back to the cart and fire again. */
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
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [cartNotice, setCartNotice] = useState<CartChangeNotice | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* Adds this device has sent but not been answered for yet, keyed by dish.
     They are painted on top of the server cart, so a tap lands in the cart
     panel in the same frame — the round trip happens behind it. Each entry is
     dropped the moment the server's own cart (reconciled right after the
     write) contains the dish, so nothing is ever counted twice. */
  const [pendingAdds, setPendingAdds] = useState<
    Record<string, { quantity: number; added_by: string }>
  >({});
  /** A write is in flight: the cart badge says "Syncing" instead of lying
      about being finished. A counter, because taps can overlap. */
  const [syncing, setSyncing] = useState(false);
  const syncsInFlightRef = useRef(0);

  /** Mirror of `cart`, so an async reload diffs against what is ON SCREEN
      rather than a stale closure. Server truth only, never the optimistic
      overlay — a notice about "someone else's change" must not be raised by
      this device's own tap. */
  const cartRef = useRef<CartLine[]>([]);
  const noticeSeqRef = useRef(0);

  const tableCodeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  /* A server settling this table's bill erases the session. The settle signal
     is shared across the table's tabs; the live API has no settle endpoint of
     its own, so this local frame is what makes the diner's screen come back
     empty instead of showing a table that was just settled. Depend on the
     timestamp alone so a request on ANOTHER table never wipes this cart. */
  const settledAt = useBills()[tableToken]?.settled_at ?? null;

  useEffect(() => {
    if (!settledAt) return;
    // Deferred so the effect body itself never writes state synchronously.
    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return;
      cartRef.current = [];
      setCart([]);
      setPendingAdds({});
      setOrders([]);
      setItemErrors({});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [settledAt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    if (!mountedRef.current) return;
    setTable(snapshot.table);
    setMenu(snapshot.menu);
    cartRef.current = snapshot.cart;
    setCart(snapshot.cart);
    setOrders(snapshot.orders);
  }, []);

  /* ---- Optimistic cart writes ----------------------------------------
     The cart panel must answer a tap, not a round trip: an add is painted
     immediately (`pendingAdds`) while its write is still in flight, and the
     badge reads "Syncing" from `syncing` until the server's own cart has been
     read back into `cart`. */
  const beginSync = useCallback(() => {
    syncsInFlightRef.current += 1;
    if (mountedRef.current) setSyncing(true);
  }, []);

  const endSync = useCallback(() => {
    syncsInFlightRef.current = Math.max(0, syncsInFlightRef.current - 1);
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

  /* This hook does NOT authenticate. The session gate has already claimed or
     joined the table and left the granted credentials in the client store;
     reading them here is what makes "is this guest in?" a single decision in
     a single place, instead of a second initialize() call that would answer
     `locked` on every reload and wipe the screen. */
  async function loadLive(): Promise<Snapshot> {
    const session = getGrantedSession(tableToken);
    if (!session) {
      throw new ApiError(0, "SESSION_REQUIRED", "Join this table to see its menu.");
    }

    // Menu + cart must be COMPLETE (dish 101 still has to render), so they
    // walk every page. Order history stays newest-first page 1: the active
    // order is always the newest row, so the tracker can never miss it.
    const [menu, cart, orderPage] = await Promise.all([
      fetchAllPages((page) => apiGetMenu(tableToken, { page, limit: LIST_LIMIT })),
      fetchAllPages((page) => apiGetCartItems(tableToken, { page, limit: LIST_LIMIT })),
      apiGetOrders(tableToken, { limit: LIST_LIMIT }),
    ]);
    return {
      table: toTable({
        table_id: session.table_id,
        code: session.code,
        name: session.name,
        status: "active",
      }),
      menu: menu.map(toMenuItem),
      cart: cart.map(toCartLine),
      orders: orderPage.data.map((row) => toOrder(row, session.code)),
    };
  }

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
     its error phase over one dropped read. */
  const reloadCart = useCallback(
    async (source: CartSyncSource = "local", silent = false) => {
      try {
        const rows = await fetchAllPages((page) =>
          apiGetCartItems(tableToken, { page, limit: LIST_LIMIT }),
        );
        if (!mountedRef.current) return;

        const next = rows.map(toCartLine);

        if (source === "external") {
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
        fail(err);
      }
    },
    [tableToken, fail],
  );

  const reloadOrders = useCallback(async () => {
    try {
      // Newest-first: page 1 always holds the active order. History beyond
      // 100 rows is archival, so it is deliberately not walked (see loadLive).
      const page = await apiGetOrders(tableToken, { limit: LIST_LIMIT });
      if (mountedRef.current) {
        setOrders(page.data.map((row) => toOrder(row, tableCodeRef.current ?? tableToken)));
      }
    } catch (err) {
      fail(err);
    }
  }, [tableToken, fail]);

  /* An 86 or a replaced photo must reach this screen without a refresh: the
     kitchen flips availability on the menu channel and every open diner menu
     follows. Walking all pages keeps the whole catalog in sync, not just the
     page that happens to be visible. */
  const reloadMenu = useCallback(async () => {
    try {
      const rows = await fetchAllPages((page) =>
        apiGetMenu(tableToken, { page, limit: LIST_LIMIT }),
      );
      if (mountedRef.current) setMenu(rows.map(toMenuItem));
    } catch (err) {
      fail(err);
    }
  }, [tableToken, fail]);

  // ---- Initial load + every retry --------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setPhase("loading");
      setError(null);
      setItemErrors({});

      try {
        const snapshot = await loadLive();
        if (cancelled) return;
        tableCodeRef.current = snapshot.table.code;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableToken, reloadKey]);

  // ---- Realtime A: table_carts ----------------------------------------
  useEffect(() => {
    if (phase !== "success" || !table) return;

    return subscribeTableCart(table.id, tableToken, () => {
      void reloadCart("external");
    });
  }, [phase, table, tableToken, reloadCart]);

  /* REST safety net for the cart — the fallback this file's header promises.

     With Supabase unconfigured every subscription above is a NO-OP
     (getSupabase() → null), and unlike useLiveFloor there was no poll behind
     them, so a guest who never touched their own screen watched a frozen cart
     forever. 5 s is the cadence the floor board already uses; a failed read is
     swallowed because one dropped safety-net request must not flip the whole
     screen into its error phase. */
  useEffect(() => {
    if (phase !== "success") return;

    const timer = window.setInterval(() => {
      void reloadCart("external", true);
    }, CART_POLL_MS);

    return () => window.clearInterval(timer);
  }, [phase, reloadCart]);

  // ---- Realtime D2: restaurant_tables (bill requests, settles, release) --
  /* Three different things arrive on this one channel, and each has its own
     correct reaction:

       * status → 'empty'  the table was cleared / archived: this device no
         longer belongs to a session, so its credentials are wiped and it is
         forced back to the home page instead of showing a dead menu.
       * bill_status → 'paid'  someone else (the floor tablet) took payment.
         The shared bill store is marked settled, which is what makes the
         diner's "Thank you!" screen appear immediately — the cross-device
         half of settlement.
       * anything else     a bill request or a new session: re-read the cart
         and ticket so the screen stays truthful. */
  useEffect(() => {
    if (phase !== "success" || !table) return;

    return subscribeTableUpdates((change) => {
      if (change.event === "DELETE" || change.status === "empty") {
        clearStoredSession(tableToken);
        forgetGrantedSession();
        router.replace("/");
        return;
      }

      if (change.bill_status === "paid") {
        settleBill(table.code);
      }

      void reloadCart("external");
      void reloadOrders();
    });
  }, [phase, table, tableToken, reloadCart, reloadOrders, router]);

  // ---- Realtime E: menu_items + menu_item_images ------------------------
  useEffect(() => {
    if (phase !== "success") return;

    return subscribeMenuUpdates(() => {
      void reloadMenu();
    });
  }, [phase, reloadMenu]);

  // ---- Realtime C: order_tracker for the active order ------------------
  const activeOrder = useMemo(() => {
    return (
      [...orders]
        .filter((order) => order.status !== "served")
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

  /* What the cart surfaces render: the server's cart plus this device's
     unconfirmed adds, merged onto the line each dish already has. */
  const visibleCart = useMemo<CartLine[]>(() => {
    const pendingIds = Object.keys(pendingAdds);
    if (pendingIds.length === 0) return cart;

    const lines = cart.map((line) => ({ ...line }));
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
  }, [cart, pendingAdds, table]);

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
  const refresh = useCallback(async () => {
    setReloadKey((key) => key + 1);
  }, []);

  // ---- Mutations --------------------------------------------------------

  const addToCart = useCallback(
    async (item: MenuItem, addedBy: string): Promise<{ ok: boolean; message?: string }> => {
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
      pushPendingAdd(item.id, addedBy);
      beginSync();

      try {
        await apiUpsertCartItem({
          table_token: tableToken,
          menu_item_id: item.id,
          quantity: 1,
          added_by: addedBy,
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
      beginSync();
      try {
        await apiUpdateCartItem(cartItemId, { table_token: tableToken, ...patch });
        await reloadCart();
      } catch (err) {
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
    [tableToken, reloadCart, fail, beginSync, endSync],
  );

  const removeLine = useCallback(
    async (cartItemId: string) => {
      beginSync();
      try {
        await apiRemoveCartItem({ table_token: tableToken, cart_item_id: cartItemId });
        await reloadCart();
      } catch (err) {
        if (err instanceof ApiError && err.status !== 0) return;
        fail(err);
      } finally {
        endSync();
      }
    },
    [tableToken, reloadCart, fail, beginSync, endSync],
  );

  const fire = useCallback(async (): Promise<{ ok: true } | { ok: false; failure: FireFailure }> => {
    try {
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
      // Success path: reset the table room cart state + pull a clean snapshot.
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
  }, [tableToken, reloadCart, reloadOrders, fail]);

  /* ---- Refused rounds (denied) ----------------------------------------
     The 86 path and the chef's deny both leave a closed ticket with a
     reason. The diner gets three ways out of it, and all three go through
     the backend so two phones cannot disagree about what happened:

       Retry          → requeue the lines that still exist, then fire again
       Move to list   → the same requeue, but stop at the editable cart
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
    const moved = await requeueDenied();
    if (!moved.ok) return moved;

    const result = await fire();
    if (!result.ok) {
      return { ok: false, omitted: moved.omitted, message: result.failure.message };
    }

    return { ok: true, omitted: moved.omitted };
  }, [requeueDenied, fire]);

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
    table,
    menu,
    cart: visibleCart,
    orders,
    menuIndex,
    quantities,
    totals,
    activeOrder,
    soldOutInCart,
    deniedOrder,
    deniedRetryPlan,
    itemErrors,
    cartNotice,
    syncing,
    addToCart,
    updateLine,
    removeLine,
    fire,
    retryDenied,
    moveDeniedToCart: requeueDenied,
    dismissDenied,
  };
}
