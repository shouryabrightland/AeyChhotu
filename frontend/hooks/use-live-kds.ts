"use client";

/* useLiveKds — the Kitchen Display data runtime.

   LIVE ONLY:
   - reads:  GET /api/v1/kds/tickets (bearer injected by the api-client)
   - writes: PATCH status / prune, with a per-ticket busy map that is the
     frontend double-tap guardrail for one-tap state modifications.
   - realtime: `kds_orders` INSERT channel → instant refetch so new tickets
     pop into Pending without a page refresh.

   If the API is unreachable the board shows the error state and a Retry
   button. It never prints a seeded ticket: a cook acting on a demo order
   would be serving food nobody ordered. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchAllPages,
  denyKdsTicket as apiDenyKdsTicket,
  getKdsTickets as apiGetKdsTickets,
  pruneKdsTicket as apiPruneKdsTicket,
  subscribeKdsOrders,
  subscribeOrdersFeed,
  toKdsOrder,
  updateKdsStatus as apiUpdateKdsStatus,
} from "@/lib/api-client";
import type { Order, OrderStatus } from "@/lib/api/types";

export type KdsPhase = "loading" | "error" | "success";

export interface KdsAdvanceResult {
  ok: boolean;
  message?: string;
}

export interface LiveKdsValue {
  phase: KdsPhase;
  error: ApiError | null;
  tickets: Order[];
  /** order_id → mutation in flight (one-tap guardrail). */
  busy: Record<string, boolean>;
  retry: () => void;
  refresh: () => Promise<void>;
  advance: (order: Order, next: OrderStatus) => Promise<KdsAdvanceResult>;
  /** Refuse an active ticket with a reason the diner will read. */
  deny: (order: Order, reason: string) => Promise<KdsAdvanceResult>;
}

const LIST_LIMIT = 100;

export function useLiveKds(): LiveKdsValue {
  const [phase, setPhase] = useState<KdsPhase>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [tickets, setTickets] = useState<Order[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [reloadKey, setReloadKey] = useState(0);

  const mountedRef = useRef(true);
  const busyRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadTickets = useCallback(async (): Promise<Order[]> => {
    // The board must show EVERY active ticket: walk all pages so ticket 101
    // can never be invisible to the kitchen (the server caps a page at 100).
    const rows = await fetchAllPages((page) => apiGetKdsTickets({ page, limit: LIST_LIMIT }));
    return rows.map(toKdsOrder);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await loadTickets();
      if (!mountedRef.current) return;
      setTickets(list);
      if (phase === "error") setPhase("success");
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof ApiError ? err : new ApiError(0, "INTERNAL_ERROR", "Could not load the board."),
      );
      setPhase("error");
    }
  }, [loadTickets, phase]);

  // ---- Initial load + retry -------------------------------------------
  // Resets (loading / clear error) happen inside `retry` — an event
  // handler — so the effect body never sets state synchronously.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await loadTickets();
        if (cancelled) return;
        setTickets(list);
        setPhase("success");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err : new ApiError(0, "INTERNAL_ERROR", "Could not load the board."),
        );
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadTickets, reloadKey]);

  const retry = useCallback(() => {
    setPhase("loading");
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  // ---- Self-healing error state ----------------------------------------
  // A board that lost the API (server restart, laptop sleep, Wi-Fi blip)
  // must recover on its own: there is no Check-again button by design.
  // Each attempt reuses `refresh`, which flips the phase back to success
  // the moment the server answers.
  useEffect(() => {
    if (phase !== "error") return;

    const timer = setInterval(() => {
      void refresh();
    }, 5_000);

    return () => clearInterval(timer);
  }, [phase, refresh]);

  // ---- Realtime B: kds_orders intake + the staff-wide order feed --------
  // kds_orders is the fast INSERT path (new ticket). orders_feed carries the
  // UPDATE/DELETE side too, so a ticket moved or pruned on another terminal
  // leaves this board without anyone pressing anything.
  useEffect(() => {
    if (phase !== "success") return;

    const detachIntake = subscribeKdsOrders(() => {
      void refresh();
    });
    const detachFeed = subscribeOrdersFeed(() => {
      void refresh();
    });

    return () => {
      detachIntake();
      detachFeed();
    };
  }, [phase, refresh]);

  // ---- One-tap state machine with per-ticket busy guardrail -------------
  const advance = useCallback(
    async (order: Order, next: OrderStatus): Promise<KdsAdvanceResult> => {
      if (busyRef.current[order.id]) {
        // Hard frontend block: the second tap cannot double-submit.
        return { ok: false, message: "That ticket is already updating." };
      }
      busyRef.current = { ...busyRef.current, [order.id]: true };
      setBusy(busyRef.current);

      try {
        if (next === "served") {
          await apiPruneKdsTicket(order.id);
        } else {
          await apiUpdateKdsStatus(order.id, next as "preparing" | "ready");
        }
        await refresh();
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError) {
          // A lost connection is a board-level problem, not a ticket-level
          // one: fail the screen so the operator sees the Retry button.
          if (err.status === 0) {
            setError(err);
            setPhase("error");
          }
          return { ok: false, message: err.message };
        }
        return { ok: false, message: "Could not update that ticket." };
      } finally {
        busyRef.current = { ...busyRef.current, [order.id]: false };
        if (mountedRef.current) setBusy(busyRef.current);
      }
    },
    [refresh],
  );

  /* ---- Manual denial (kitchen refusal) ----------------------------------
     Same per-ticket busy guard as advance, so a double-tap cannot submit two
     denial reasons for one ticket. A ticket can be denied from pending,
     preparing OR ready — a dish can run out at any point before it reaches
     the table — and the reason is required by the server. */
  const deny = useCallback(
    async (order: Order, reason: string): Promise<KdsAdvanceResult> => {
      if (busyRef.current[order.id]) {
        return { ok: false, message: "That ticket is already updating." };
      }
      busyRef.current = { ...busyRef.current, [order.id]: true };
      setBusy(busyRef.current);

      try {
        await apiDenyKdsTicket(order.id, reason);
        await refresh();
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 0) {
            setError(err);
            setPhase("error");
          }
          return { ok: false, message: err.message };
        }
        return { ok: false, message: "Could not deny that ticket." };
      } finally {
        busyRef.current = { ...busyRef.current, [order.id]: false };
        if (mountedRef.current) setBusy(busyRef.current);
      }
    },
    [refresh],
  );

  return { phase, error, tickets, busy, retry, refresh, advance, deny };
}
