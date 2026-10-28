"use client";

/* useLiveTable — the Diner side data runtime.

   Strategy: LIVE WITH MOCK FALLBACK.
   1. Every read/write goes through the api-client to the Express backend
      first (20 s timeout, ApiError envelope parsing).
   2. When a request never reaches the backend (status 0: down / timeout /
      unconfigured), the hook falls back to the seeded offline demo store
      (lib/api) so the prototype still runs without a server. That fallback
      is GATED: development only, or an explicit
      NEXT_PUBLIC_ENABLE_DEMO_FALLBACK=true — production never silently
      renders seeded data. See shouldUseDemoFallback().
   3. Realtime: `table_carts` channel streams cart mutations, and
      `order_tracker` (via watchOrderStatus) streams status flips — with
      REST polling underneath as the WebSocket safety net.

   One instance powers the menu screen, the cart modal and the tracker, so
   every view at a table observes exactly the same snapshot. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBills } from "@/hooks/use-bills";
import {
  ApiError,
  fetchAllPages,
  fireTableOrder as apiFire,
  getCartItems as apiGetCartItems,
  getMenu as apiGetMenu,
  getOrders as apiGetOrders,
  checkActiveOrder,
  removeCartItem as apiRemoveCartItem,
  shouldUseDemoFallback,
  subscribeTableCart,
  toCartLine,
  toMenuItem,
  toOrder,
  toTable,
  updateCartItem as apiUpdateCartItem,
  upsertCartItem as apiUpsertCartItem,
  watchOrderStatus,
} from "@/lib/api-client";
import { getGrantedSession } from "@/lib/api/table-session";
import type { CartLine, MenuItem, Order, RestaurantTable } from "@/lib/api/types";
import * as mock from "@/lib/api";
import { getSnapshot, subscribe as subscribeMockStore } from "@/lib/api/store";

export type LivePhase = "loading" | "error" | "success";
export type LiveSource = "live" | "demo";

/** Normalized failure the cart modal renders (contract envelope aware). */
export interface FireFailure {
  code: string;
  message: string;
  soldOut: string[];
  fields: Record<string, string>;
}

interface Snapshot {
  table: RestaurantTable;
  menu: MenuItem[];
  cart: CartLine[];
  orders: Order[];
}

const LIST_LIMIT = 100;

export interface LiveTableValue {
  phase: LivePhase;
  /** Non-null only in the error phase (real backend/contract failure). */
  error: ApiError | null;
  source: LiveSource;
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

  /** Per-item add failures keyed by menu item id → inline row messages. */
  itemErrors: Record<string, string>;

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
}

export function useLiveTable(tableToken: string): LiveTableValue {
  const [phase, setPhase] = useState<LivePhase>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [source, setSource] = useState<LiveSource>("live");
  const [table, setTable] = useState<RestaurantTable | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [reloadKey, setReloadKey] = useState(0);

  const sourceRef = useRef<LiveSource>("live");
  const tableIdRef = useRef<string | null>(null);
  const tableCodeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  /* A server settling this table's bill erases the session. The shared demo
     store is cleared by settleTable(); on the live API — which has no such
     endpoint — this local frame is what makes the diner's screen come back
     empty instead of showing a table that was just settled. Depend on the
     timestamp alone so a request on ANOTHER table never wipes this cart. */
  const settledAt = useBills()[tableToken]?.settled_at ?? null;

  useEffect(() => {
    if (!settledAt) return;
    // Deferred so the effect body itself never writes state synchronously.
    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setCart([]);
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
    setCart(snapshot.cart);
    setOrders(snapshot.orders);
    tableIdRef.current = snapshot.table.id;
  }, []);

  /* This hook does NOT authenticate. The session gate has already claimed or
     joined the table and left the granted credentials in the client store;
     reading them here is what makes "is this guest in?" a single decision in
     a single place, instead of a second initialize() call that would answer
     `locked` on every reload and wipe the screen.

     `status: 0` is the honest classification for "no session in this frame":
     the request never reached the backend, which is also the one case where
     the demo store is allowed to stand in (development / explicit opt-in). */
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

  async function loadDemo(): Promise<Snapshot> {
    const session = await mock.initializeSession(tableToken);
    if (!session.ok) {
      throw new ApiError(404, "TABLE_NOT_FOUND", session.message);
    }
    const menu = await mock.fetchMenu(tableToken);
    if (!menu.ok) {
      throw new ApiError(404, "TABLE_NOT_FOUND", menu.message);
    }
    return {
      table: session.data,
      menu: menu.data,
      cart: mock.getCart(tableToken),
      orders: mock.getOrdersForTable(tableToken),
    };
  }

  const reloadCart = useCallback(async () => {
    if (sourceRef.current === "demo") {
      if (mountedRef.current) setCart(mock.getCart(tableToken));
      return;
    }
    try {
      const rows = await fetchAllPages((page) =>
        apiGetCartItems(tableToken, { page, limit: LIST_LIMIT }),
      );
      if (mountedRef.current) setCart(rows.map(toCartLine));
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        sourceRef.current = "demo";
        setSource("demo");
        if (mountedRef.current) setCart(mock.getCart(tableToken));
      }
    }
  }, [tableToken]);

  const reloadOrders = useCallback(async () => {
    if (sourceRef.current === "demo") {
      if (mountedRef.current) setOrders(mock.getOrdersForTable(tableToken));
      return;
    }
    try {
      // Newest-first: page 1 always holds the active order. History beyond
      // 100 rows is archival, so it is deliberately not walked (see loadLive).
      const page = await apiGetOrders(tableToken, { limit: LIST_LIMIT });
      if (mountedRef.current) {
        setOrders(page.data.map((row) => toOrder(row, tableCodeRef.current ?? tableToken)));
      }
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        sourceRef.current = "demo";
        setSource("demo");
        if (mountedRef.current) setOrders(mock.getOrdersForTable(tableToken));
      }
    }
  }, [tableToken]);

  // ---- Initial load + every retry --------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setPhase("loading");
      setError(null);
      setItemErrors({});

      try {
        let snapshot: Snapshot;
        try {
          snapshot = await loadLive();
          sourceRef.current = "live";
          setSource("live");
        } catch (err) {
          if (shouldUseDemoFallback(err)) {
            snapshot = await loadDemo();
            sourceRef.current = "demo";
            setSource("demo");
          } else {
            throw err;
          }
        }
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

  // ---- Realtime A: table_carts (live) / mock store (demo) --------------
  useEffect(() => {
    if (phase !== "success" || !table) return;

    if (sourceRef.current === "live") {
      return subscribeTableCart(table.id, tableToken, () => {
        void reloadCart();
      });
    }

    return subscribeMockStore(() => {
      if (!mountedRef.current) return;
      setCart(mock.getCart(tableToken));
      setOrders(mock.getOrdersForTable(tableToken));
      setMenu(getSnapshot().menu);
    });
  }, [phase, table, tableToken, reloadCart]);

  // ---- Realtime C: order_tracker for the active order (live only) ------
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
    if (phase !== "success" || sourceRef.current !== "live" || !activeOrderId) return;

    return watchOrderStatus(activeOrderId, tableToken, (statusUpdate) => {
      if (!mountedRef.current) return;
      setOrders((current) =>
        current.map((order) =>
          order.id === statusUpdate.order_id ? { ...order, status: statusUpdate.status } : order,
        ),
      );
    });
  }, [phase, activeOrderId, activeOrderStatus, tableToken]);

  // ---- Derived matrix (identical math to the old useTableData) ----------
  const menuIndex = useMemo(() => new Map(menu.map((item) => [item.id, item])), [menu]);

  const quantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of cart) {
      map[line.menu_item_id] = (map[line.menu_item_id] ?? 0) + line.quantity;
    }
    return map;
  }, [cart]);

  const totals = useMemo(() => {
    return cart.reduce(
      (accumulator, line) => ({
        lineCount: accumulator.lineCount + 1,
        itemCount: accumulator.itemCount + line.quantity,
        total: accumulator.total + (menuIndex.get(line.menu_item_id)?.price ?? 0) * line.quantity,
      }),
      { lineCount: 0, itemCount: 0, total: 0 },
    );
  }, [cart, menuIndex]);

  const soldOutInCart = useMemo(
    () =>
      cart
        .map((line) => menuIndex.get(line.menu_item_id))
        .filter((item): item is MenuItem => item !== undefined && !item.is_available),
    [cart, menuIndex],
  );

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);
  const refresh = useCallback(async () => {
    setReloadKey((key) => key + 1);
  }, []);

  const syncFromMock = useCallback(() => {
    if (!mountedRef.current) return;
    setCart(mock.getCart(tableToken));
    setOrders(mock.getOrdersForTable(tableToken));
    setMenu(getSnapshot().menu);
  }, [tableToken]);

  // ---- Mutations --------------------------------------------------------

  const addToCart = useCallback(
    async (item: MenuItem, addedBy: string): Promise<{ ok: boolean; message?: string }> => {
      setItemErrors((current) => {
        if (!(item.id in current)) return current;
        const next = { ...current };
        delete next[item.id];
        return next;
      });

      try {
        await apiUpsertCartItem({
          table_token: tableToken,
          menu_item_id: item.id,
          quantity: 1,
          added_by: addedBy,
        });
        await reloadCart();
        return { ok: true };
      } catch (err) {
        if (shouldUseDemoFallback(err)) {
          const result = await mock.addCartLine({
            table_token: tableToken,
            menu_item_id: item.id,
            added_by: addedBy,
          });
          sourceRef.current = "demo";
          setSource("demo");
          syncFromMock();
          if (!result.ok) {
            setItemErrors((current) => ({ ...current, [item.id]: result.message }));
            return { ok: false, message: result.message };
          }
          return { ok: true };
        }

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
        throw err;
      }
    },
    [tableToken, reloadCart, syncFromMock],
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
      try {
        await apiUpdateCartItem(cartItemId, { table_token: tableToken, ...patch });
        await reloadCart();
      } catch (err) {
        if (shouldUseDemoFallback(err)) {
          sourceRef.current = "demo";
          setSource("demo");
          // The demo store has no server-side atomics: resolve the delta
          // against the local line, then store an absolute value.
          const { quantity_delta: delta, ...rest } = patch;
          const localLine = mock.getCart(tableToken).find((line) => line.id === cartItemId);
          await mock.updateCartLine({
            cart_item_id: cartItemId,
            ...rest,
            ...(delta !== undefined && localLine
              ? { quantity: Math.min(99, Math.max(1, localLine.quantity + delta)) }
              : {}),
          });
          syncFromMock();
          return;
        }
        if (err instanceof ApiError) {
          // Inline validation vector: surface under the cart line via toast layer.
          console.warn("updateLine failed:", err.error, err.message);
          return;
        }
        throw err;
      }
    },
    [tableToken, reloadCart, syncFromMock],
  );

  const removeLine = useCallback(
    async (cartItemId: string) => {
      try {
        await apiRemoveCartItem({ table_token: tableToken, cart_item_id: cartItemId });
        await reloadCart();
      } catch (err) {
        if (shouldUseDemoFallback(err)) {
          sourceRef.current = "demo";
          setSource("demo");
          await mock.removeCartLine({ cart_item_id: cartItemId });
          syncFromMock();
          return;
        }
        if (err instanceof ApiError) return;
        throw err;
      }
    },
    [tableToken, reloadCart, syncFromMock],
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
      if (shouldUseDemoFallback(err)) {
        sourceRef.current = "demo";
        setSource("demo");
        const result = await mock.fireOrder(tableToken);
        syncFromMock();
        if (result.ok) return { ok: true };
        return {
          ok: false,
          failure: {
            code: result.code,
            message: result.message,
            soldOut: result.sold_out ?? [],
            fields: {},
          },
        };
      }

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
      throw err;
    }
  }, [tableToken, reloadCart, reloadOrders, syncFromMock]);

  return {
    phase,
    error,
    source,
    retry,
    refresh,
    table,
    menu,
    cart,
    orders,
    menuIndex,
    quantities,
    totals,
    activeOrder,
    soldOutInCart,
    itemErrors,
    addToCart,
    updateLine,
    removeLine,
    fire,
  };
}
