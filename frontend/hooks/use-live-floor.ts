"use client";

/* useLiveFloor — the Floor view's data runtime (screen S6).

   LIVE ONLY:
   1. GET /api/v1/floor/tables (E17, staff bearer) is the single source of
      pacing for every table — active order, status, staged cart lines. The
      response also carries `active_order.items`, so each floor card can show
      the table's allergy alerts without a second request.
   2. Realtime: the staff-wide `orders` feed (INSERT / UPDATE / DELETE)
      refreshes the board the instant a ticket is fired, moved or pruned.
      Where Realtime is unavailable (no Supabase env, or RLS matching no rows)
      a slow REST poll keeps the board honest instead of leaving it frozen.
   3. When the API is unreachable the board shows the real error state with a
      Retry button — never a seeded room. A server acting on a demo table
      would walk food to a table that is not sitting there.

   The 86 drawer's catalog is NOT here — see useStaffMenuCatalog, which both
   staff surfaces share so the catalog is fetched once per screen.

   E17 requires a staff token, so this hook is only ever mounted inside the
   floor's StaffGate. A 401 there is handled by the api-client's global guard,
   which wipes the token and returns the operator to the PIN wall. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchAllPages,
  getFloorTables as apiGetFloorTables,
  subscribeOrdersFeed,
  subscribeTableUpdates,
  toFloorSummary,
} from "@/lib/api-client";
import type { FloorTableSummary } from "@/lib/api/types";

export type FloorPhase = "loading" | "error" | "success";

/** Safety-net cadence when Realtime cannot stream. Slow on purpose: the feed
    above is the fast path, this only stops the board going stale. */
const POLL_INTERVAL_MS = 15_000;
const LIST_LIMIT = 100;

export interface LiveFloorValue {
  phase: FloorPhase;
  error: ApiError | null;
  tables: FloorTableSummary[];
  retry: () => void;
  refresh: () => Promise<void>;
}

export function useLiveFloor(): LiveFloorValue {
  const [phase, setPhase] = useState<FloorPhase>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [tables, setTables] = useState<FloorTableSummary[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadLive = useCallback(async (): Promise<FloorTableSummary[]> => {
    const rows = await fetchAllPages((page) => apiGetFloorTables({ page, limit: LIST_LIMIT }));
    return rows.map(toFloorSummary);
  }, []);

  const apply = useCallback((next: FloorTableSummary[]) => {
    if (!mountedRef.current) return;
    setTables(next);
  }, []);

  // ---- Initial load + every retry --------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setPhase("loading");
      setError(null);

      try {
        const data = await loadLive();
        if (cancelled) return;
        apply(data);
        setPhase("success");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err
            : new ApiError(0, "INTERNAL_ERROR", "Could not load the floor."),
        );
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadLive, apply, reloadKey]);

  // ---- REST refresh (used by the feed, the poll and manual retry) -------
  const refresh = useCallback(async () => {
    try {
      apply(await loadLive());
      if (mountedRef.current && phase === "error") setPhase("success");
    } catch (err) {
      if (err instanceof ApiError && mountedRef.current) {
        setError(err);
        setPhase("error");
      }
    }
  }, [loadLive, apply, phase]);

  // ---- Realtime: staff-wide order feed + polling safety net -------------
  useEffect(() => {
    if (phase !== "success") return;

    /* The feed can arrive in bursts (a fire inserts one order row, then a
       status tap updates it). Collapse them so a busy service does not turn
       into a request storm. */
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce !== null) return;
      debounce = setTimeout(() => {
        debounce = null;
        void refresh();
      }, 400);
    };

    const detachOrders = subscribeOrdersFeed(schedule);
    // Bill requests and settles are restaurant_tables UPDATEs, not order
    // events: without this channel the Bill tab would only fill on the poll.
    const detachTables = subscribeTableUpdates(schedule);

    const poll = setInterval(() => void refresh(), POLL_INTERVAL_MS);

    return () => {
      if (debounce !== null) clearTimeout(debounce);
      clearInterval(poll);
      detachOrders();
      detachTables();
    };
  }, [phase, refresh]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return useMemo(
    () => ({ phase, error, tables, retry, refresh }),
    [phase, error, tables, retry, refresh],
  );
}
