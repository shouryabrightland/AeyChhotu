"use client";

import {
  BarChart3,
  Check,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  ImagePlus,
  KeyRound,
  LayoutGrid,
  LogOut,
  PowerOff,
  Pencil,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Utensils,
} from "lucide-react";
import Image from "next/image";
import QRCode from "qrcode";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AdminAssistant } from "@/components/admin/admin-assistant";
import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { FieldShell, controlStyles, useFieldControl } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/loading-state";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  ApiError,
  clearAdminToken,
  deactivateAdminTable,
  clearAdminTable,
  createAdminMenuItem,
  createAdminTable,
  deleteAdminCategory,
  deleteAdminMenuItem,
  deleteAdminTable,
  getAdminAnalytics,
  getAdminCategories,
  createAdminCategory,
  getAdminMenu,
  getAdminTables,
  getAdminToken,
  loginAdmin,
  regenerateAdminTableToken,
  renameAdminTable,
  resolveApiAssetUrl,
  subscribeMenuUpdates,
  subscribeTableUpdates,
  deleteAdminMenuImage,
  uploadAdminMenuImage,
  updateAdminCategory,
  updateAdminMenuItem,
  updateAdminTableCode,
  type AdminAnalytics,
  type AdminCategory,
  type AdminMenuImage,
  type AdminMenuItem,
  type AdminTable,
} from "@/lib/api-client";
import { resolveDishPhoto } from "@/lib/diner/food-photos";
import { formatIstDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/* The owner/manager console.
 *
 * This is a protected operator surface, not a diner one:
 *   - the PIN wall posts to the live API and gets a role:"admin" JWT;
 *   - every read and write below goes through /api/v1/admin/* with that token;
 *   - "delete" is an ARCHIVE (soft delete). History stays intact, because an
 *     old ticket still points at its table and its dishes.
 *
 * The page is one screen with three tabs rather than three routes: a manager
 * checking the night's takings should not lose the tab they were on when they
 * glance at the floor. */

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function money(amount: number) {
  return inr.format(Number.isFinite(amount) ? amount : 0);
}

type GateStatus = "checking" | "locked" | "ready";
type AdminTab = "analytics" | "tables" | "menu";

export default function AdminPage() {
  const [status, setStatus] = useState<GateStatus>("checking");

  /* Reading a token happens after mount only: the server has no localStorage,
     so touching it during render would be a hydration mismatch. The write is
     deferred a frame, which also keeps it out of the effect's render cascade. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setStatus(getAdminToken() ? "ready" : "locked");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (status === "checking") {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center bg-canvas">
        <Skeleton className="h-10 w-52 rounded-md" />
      </main>
    );
  }

  if (status === "locked") {
    return <AdminGate onUnlocked={() => setStatus("ready")} />;
  }

  return (
    <AdminConsole
      onLock={() => {
        clearAdminToken();
        setStatus("locked");
      }}
    />
  );
}

/* =====================================================================
   Gate
   ===================================================================== */

function AdminGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { fieldId, describedBy, invalid } = useFieldControl({ error: error ?? undefined });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    if (!/^\d{4,6}$/.test(pin)) {
      setError("The manager PIN is 4 to 6 digits.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await loginAdmin(pin);
      onUnlocked();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not reach the admin service. Try again.",
      );
      setPin("");
      setBusy(false);
    }
  }

  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-5 py-16"
    >
      <Container size="narrow" className="flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-md bg-ink text-ink-inverse">
            <ShieldCheck className="size-6" aria-hidden />
          </span>
          <h1 className="font-display text-title font-semibold text-ink">Manager console</h1>
          <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
            Owner and manager access.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="flex w-full max-w-sm flex-col gap-5 rounded-xl border border-line-strong bg-surface p-6 shadow-lg sm:p-8"
          noValidate
        >
          <FieldShell id={fieldId} label="Manager PIN" error={error ?? undefined}>
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-subtle"
              >
                <KeyRound className="size-4" />
              </span>
              <input
                id={fieldId}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                aria-label="Manager PIN"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={pin}
                maxLength={6}
                onChange={(event) => {
                  setError(null);
                  setPin(event.target.value.replace(/\D/g, "").slice(0, 6));
                }}
                placeholder="••••••"
                className={cn(
                  controlStyles({ invalid }),
                  "h-14 pl-11 text-center font-display text-2xl tracking-[0.3em] text-ink",
                )}
              />
            </div>
          </FieldShell>

          <Button type="submit" variant="ember" size="lg" fullWidth loading={busy}>
            Unlock console
          </Button>
        </form>
      </Container>
    </main>
  );
}

/* =====================================================================
   Console
   ===================================================================== */

const ALL_SLICES = ["analytics", "tables", "menu"] as const;
type ConsoleSlice = (typeof ALL_SLICES)[number];

function AdminConsole({ onLock }: { onLock: () => void }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<AdminTab>("analytics");

  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [menu, setMenu] = useState<AdminMenuItem[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [phase, setPhase] = useState<"loading" | "error" | "success">("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const refreshDoneTimer = useRef<number | null>(null);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  /* ---- Per-slice loading ---------------------------------------------
     The console used to reload all four datasets after every save and put
     the whole page back into `loading`, so an edit to one dish replaced the
     console with skeletons. Data is now loaded (and patched) ONE SLICE AT A
     TIME:

       analytics  the reports
       tables     the physical-table grid
       menu       dishes + folders (they are edited together)

     A soft read only writes state when the server actually returned
     something different, so a 15 s poll that found nothing new causes no
     re-render at all, and saving a dish cannot touch the tables tab. */
  const loadingRef = useRef<Record<ConsoleSlice, boolean>>({
    analytics: false,
    tables: false,
    menu: false,
  });
  const hadDataRef = useRef(false);
  /* The tab whose data the initial load already covers. Used so the "load on
     tab switch" effect does not re-fetch immediately after first paint. */
  const loadedTabRef = useRef<AdminTab | null>("analytics");

  /** Payloads here are small arrays; a structural compare is cheaper than a
      wasted render of the whole active tab. */
  const unchanged = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const onUnauthorized = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        // The token expired or was rejected: the gate owns the next step.
        onLock();
        return true;
      }
      return false;
    },
    [onLock],
  );

  const loadAnalytics = useCallback(async () => {
    const next = await getAdminAnalytics();
    setAnalytics((current) => (unchanged(current, next) ? current : next));
  }, []);

  const loadTables = useCallback(async () => {
    const next = await getAdminTables();
    setTables((current) => (unchanged(current, next) ? current : next));
  }, []);

  const loadMenu = useCallback(async () => {
    const [nextMenu, nextCategories] = await Promise.all([getAdminMenu(), getAdminCategories()]);
    setMenu((current) => (unchanged(current, nextMenu) ? current : nextMenu));
    setCategories((current) => (unchanged(current, nextCategories) ? current : nextCategories));
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadAnalytics(), loadTables(), loadMenu()]);
  }, [loadAnalytics, loadTables, loadMenu]);

  /* The initial load. ONLY this may show skeletons; every later read patches
     the content it already has. */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await loadAll();
        if (cancelled) return;
        hadDataRef.current = true;
        setPhase("success");
      } catch (err) {
        if (cancelled || onUnauthorized(err)) return;
        setError(err instanceof ApiError ? err : new ApiError(0, "INTERNAL", "Could not load the console."));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadAll, onUnauthorized]);

  /** Soft, in-place read of just the requested slices.

      `showSpinner` is for user-initiated reads (the button, a save). The 15 s
      poll and realtime revalidation pass false: a background read that finds
      nothing new must not even toggle a spinner, or the whole active tab
      would re-render every 15 s for no content change. */
  const reload = useCallback(
    async (slices: readonly ConsoleSlice[], showSpinner = false): Promise<boolean> => {
      const work = slices.filter((slice) => !loadingRef.current[slice]);
      if (work.length === 0) return false;

      for (const slice of work) loadingRef.current[slice] = true;
      if (showSpinner) setRefreshing(true);

      try {
        await Promise.all(
          work.map((slice) =>
            slice === "analytics"
              ? loadAnalytics()
              : slice === "tables"
                ? loadTables()
                : loadMenu(),
          ),
        );
        hadDataRef.current = true;
        setPhase("success");
        setError(null);
        return true;
      } catch (err) {
        if (onUnauthorized(err)) return false;
        /* A soft failure keeps the console exactly as it was; only a console
           that never loaded may fall through to the error screen. */
        if (!hadDataRef.current) {
          setError(
            err instanceof ApiError ? err : new ApiError(0, "INTERNAL", "Could not load the console."),
          );
          setPhase("error");
        }
        return false;
      } finally {
        for (const slice of work) loadingRef.current[slice] = false;
        if (showSpinner) setRefreshing(false);
      }
    },
    [loadAnalytics, loadTables, loadMenu, onUnauthorized],
  );

  const slicesForTab = useCallback(
    (target: AdminTab): readonly ConsoleSlice[] =>
      target === "analytics" ? ["analytics", "tables"] : target === "tables" ? ["tables"] : ["menu"],
    [],
  );

  /* Refresh (button, post-save, post-settle): visible tab only. The button
     spins softly while the read is in flight and shows a tick for a second
     afterwards, so an operator knows the content is current without the
     console ever blinking. */
  const refresh = useCallback(async () => {
    /* A second tap clears the previous tick immediately (and its timer, which
       would otherwise cut the new one short), so the arrow never shows a
       stale success while a new read is in flight. */
    if (refreshDoneTimer.current !== null) {
      window.clearTimeout(refreshDoneTimer.current);
      refreshDoneTimer.current = null;
    }
    setJustRefreshed(false);
    const ok = await reload(slicesForTab(tab), true);
    if (!ok) return;

    setJustRefreshed(true);
    if (refreshDoneTimer.current !== null) window.clearTimeout(refreshDoneTimer.current);
    refreshDoneTimer.current = window.setTimeout(() => {
      refreshDoneTimer.current = null;
      setJustRefreshed(false);
    }, 1_100);
  }, [reload, slicesForTab, tab]);

  useEffect(
    () => () => {
      if (refreshDoneTimer.current !== null) window.clearTimeout(refreshDoneTimer.current);
    },
    [],
  );

  /* Background revalidation: same slices, no spinner, so an unchanged poll
     produces no render at all. */
  const softRefresh = useCallback(() => {
    void reload(slicesForTab(tab));
  }, [reload, slicesForTab, tab]);

  /* Switching tabs reads that tab's slice, and nothing else. */
  useEffect(() => {
    if (phase !== "success") return;
    if (loadedTabRef.current === tab) return;
    loadedTabRef.current = tab;
    void reload(slicesForTab(tab));
  }, [phase, tab, reload, slicesForTab]);

  /* Retry from the error screen is the one hard reload. */
  const retry = useCallback(() => {
    setPhase("loading");
    setError(null);
    void reload(ALL_SLICES);
  }, [reload]);

  /* The unconditional "stop this table" override. Works on any table, at
     any point — including one that owes money or has a live ticket. */
  async function deactivateTable(table: AdminTable) {
    if (deactivatingId) return;
    setDeactivatingId(table.table_id);
    try {
      const result = await deactivateAdminTable(table.table_id);
      toast({
        title: `${table.name} deactivated`,
        description:
          result.closed_orders > 0
            ? `${result.closed_orders} open ${result.closed_orders === 1 ? "ticket was" : "tickets were"} stopped and removed with the seating.`
            : "Session ended. The table is ready for its next guests.",
        tone: "success",
      });
      refresh();
    } catch (err) {
      toast({
        title: err instanceof ApiError ? err.message : "Could not deactivate that table.",
        tone: "error",
      });
    } finally {
      setDeactivatingId(null);
    }
  }

  /* A staff clear was refused for an unpaid bill and stamped a request.
     The manager is the only role allowed to complete it. */
  async function clearTable(table: AdminTable) {
    if (clearingId) return;
    setClearingId(table.table_id);
    try {
      await clearAdminTable(table.table_id);
      toast({
        title: `${table.name} cleared`,
        description: "The pending staff request is resolved.",
        tone: "success",
      });
      refresh();
    } catch (err) {
      toast({
        title: err instanceof ApiError ? err.message : "Could not clear that table.",
        tone: "error",
      });
    } finally {
      setClearingId(null);
    }
  }

  /* Realtime + poll. Events are routed to the tab they can affect, so a
     settle on the floor cannot re-render an open menu editor, and an 86
     cannot re-render the tables grid. The read is still soft (no skeletons)
     and still guarded by the per-slice equality check. */
  useEffect(() => {
    if (phase !== "success") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        softRefresh();
      }, 400);
    };

    const detachMenu = subscribeMenuUpdates(() => {
      if (tab === "menu") schedule();
    });
    const detachTables = subscribeTableUpdates(() => {
      if (tab !== "menu") schedule();
    });

    // Safety net for deployments where RLS denies the table channel (an
    // admin JWT is not a floor claim): the open tab still refreshes itself.
    const poll = setInterval(softRefresh, 15_000);

    return () => {
      if (timer !== null) clearTimeout(timer);
      clearInterval(poll);
      detachMenu();
      detachTables();
    };
  }, [phase, tab, softRefresh]);

  if (phase === "error") {
    return (
      <main id="main" className="min-h-dvh bg-canvas">
        <Container size="narrow" className="py-16">
          <ErrorState
            titleAs="h1"
            title="The console lost its connection"
            description={error?.message ?? "The admin service could not be reached."}
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <Button
                  size="md"
                  onClick={retry}
                  leftIcon={<RefreshCw className="size-4" aria-hidden />}
                >
                  Refresh
                </Button>
                <Button variant="outline" size="md" onClick={onLock}>
                  Sign out
                </Button>
              </div>
            }
          />
        </Container>
      </main>
    );
  }

  return (
    <main id="main" className="min-h-dvh bg-canvas pb-20">
      {/* Rendered only after the PIN gate: a diner cannot reach this screen,
          and the insight endpoints re-check the admin role server-side. */}
      <AdminAssistant />
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur-md">
        <Container className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3">
          {/* The same lockup as the home header: the app's own mark and the
              AeyChhotu wordmark. The console's name sits beside it after a
              hairline, so the brand is not restated as a faint eyebrow. */}
          <div className="flex min-w-0 items-center gap-3">
            <Logo className="shrink-0" />
            <span aria-hidden className="h-7 w-px shrink-0 bg-line" />
            <h1 className="truncate font-display text-subheading font-semibold text-ink">
              Manager console
            </h1>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Backup refresh: Realtime revalidates the console on its own,
                but an operator gets a manual re-read when a socket dies.

                The label never changes width, and the tint outlives the
                pointer resting on the button (ghost's hover:text-ink would
                otherwise swallow it). */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              aria-busy={refreshing || undefined}
              className={cn(
                "transition-colors duration-500 ease-gentle",
                justRefreshed && "text-ready hover:text-ready",
              )}
              leftIcon={
                /* Two stacked glyphs that cross-fade: the refresh arrow turns
                   slowly and softly while the read is running, then a tick
                   eases into its place for a second. No layout shift. */
                <span aria-hidden className="relative inline-flex size-4 items-center justify-center">
                  <RefreshCw
                    className={cn(
                      "absolute size-4 transition-all duration-500 ease-gentle",
                      justRefreshed
                        ? "rotate-45 scale-75 opacity-0"
                        : "rotate-0 scale-100 opacity-100",
                      refreshing && "animate-spin [animation-duration:1.8s]",
                    )}
                  />
                  <Check
                    className={cn(
                      "absolute size-4 text-ready transition-all duration-500 ease-gentle",
                      justRefreshed ? "scale-100 opacity-100" : "scale-75 opacity-0",
                    )}
                  />
                </span>
              }
            >
              {/* Constant label: the tick and tint carry the confirmation, so
                  the header row never reflows. */}
              Refresh
            </Button>
            {/* Status for assistive tech: outside the button, so it never
                becomes part of its name. */}
            <span role="status" className="sr-only">
              {justRefreshed ? "Console refreshed" : refreshing ? "Refreshing console" : ""}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={onLock}
              leftIcon={<LogOut className="size-4" aria-hidden />}
            >
              Lock
            </Button>
          </div>
        </Container>

        <Container className="pb-2">
          <div
            role="tablist"
            aria-label="Console sections"
            className="hide-scrollbar flex gap-1 overflow-x-auto"
          >
            {(
              [
                { id: "analytics", label: "Live analytics", icon: BarChart3 },
                { id: "tables", label: "Floor & tables", icon: LayoutGrid },
                { id: "menu", label: "Menu catalog", icon: Utensils },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={tab === option.id}
                onClick={() => setTab(option.id)}
                className={cn(
                  "inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3.5 text-sm font-semibold transition-colors duration-[var(--duration-fast)]",
                  tab === option.id
                    ? "bg-ink text-ink-inverse"
                    : "text-ink-muted hover:bg-sand hover:text-ink",
                )}
              >
                <option.icon className="size-4" aria-hidden />
                {option.label}
              </button>
            ))}
          </div>
        </Container>
      </header>

      <Container className="py-8">
        {/* Staff tried to clear an abandoned table but its bill is unpaid.
            This is the alert the floor raised; only this console can clear. */}
        {tables.some((table) => table.clear_requested_at) ? (
          <section className="mb-6 rounded-xl border border-alert/40 bg-alert-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-subheading text-alert">Clear requests</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Staff could not clear these tables because the bill is unpaid.
                </p>
              </div>
              <Badge tone="alert">
                {tables.filter((table) => table.clear_requested_at).length} waiting
              </Badge>
            </div>

            <ul className="mt-4 flex flex-col divide-y divide-alert/20">
              {tables
                .filter((table) => table.clear_requested_at)
                .map((table) => (
                  <li
                    key={table.table_id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-display text-base text-ink">{table.name}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        Table {table.code} · bill unpaid
                      </p>
                    </div>
                    <Button
                      variant="ember"
                      size="sm"
                      loading={clearingId === table.table_id}
                      disabled={clearingId !== null && clearingId !== table.table_id}
                      onClick={() => void clearTable(table)}
                    >
                      Clear table
                    </Button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}

        {phase === "loading" ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-32 rounded-lg" />
            ))}
          </div>
        ) : tab === "analytics" ? (
          <AnalyticsTab
            analytics={analytics}
            tables={tables}
            deactivatingId={deactivatingId}
            onDeactivate={(table) => void deactivateTable(table)}
          />
        ) : tab === "tables" ? (
          <TablesTab
            tables={tables}
            deactivatingId={deactivatingId}
            onDeactivate={(table) => void deactivateTable(table)}
            onChanged={refresh}
            onError={(message) => toast({ title: message, tone: "error" })}
          />
        ) : (
          <MenuTab
            menu={menu}
            categories={categories}
            onChanged={refresh}
            onError={(message) => toast({ title: message, tone: "error" })}
          />
        )}
      </Container>
    </main>
  );
}

/* =====================================================================
   Tab 1 — Analytics
   ===================================================================== */

function AnalyticsTab({
  analytics,
  tables,
  deactivatingId,
  onDeactivate,
}: {
  analytics: AdminAnalytics | null;
  tables: AdminTable[];
  deactivatingId: string | null;
  onDeactivate: (table: AdminTable) => void;
}) {
  if (!analytics) {
    return <EmptyState title="No analytics yet" description="Fire and serve an order to see it here." />;
  }

  const activeTables = tables.filter((table) => table.status === "active").length;

  /* The peak gives each sparkline a y-scale: a shape alone cannot tell an
     operator whether an hour of ₹0 is "quiet" or "closed". */
  const revenuePeak = Math.max(0, ...analytics.trend.map((point) => point.revenue));
  const ordersPeak = Math.max(0, ...analytics.trend.map((point) => point.orders_served));
  const tablesPeak = Math.max(0, ...analytics.trend.map((point) => point.active_tables));

  /* The same signal the floor uses, expressed from the console's row: a live
     session with no phone heartbeating and no open ticket is a table nobody
     is sitting at properly. A clear request is escalated above those. */
  const flagged = tables
    .filter(
      (table) =>
        table.has_session && table.active_order_count === 0 && table.active_devices === 0,
    )
    .sort((a, b) => Number(Boolean(b.clear_requested_at)) - Number(Boolean(a.clear_requested_at)));

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Revenue collected"
          value={money(analytics.total_revenue)}
          hint="Served tickets only"
          values={analytics.trend.map((point) => point.revenue)}
          peakLabel={`peak ${money(revenuePeak)}/hr`}
        />
        <Stat
          label="Orders completed"
          value={String(analytics.total_orders_served)}
          hint="Tickets marked served"
          values={analytics.trend.map((point) => point.orders_served)}
          peakLabel={`peak ${ordersPeak}/hr`}
        />
        <Stat
          label="Active tables"
          value={String(activeTables)}
          hint="Sessions open right now"
          values={analytics.trend.map((point) => point.active_tables)}
          peakLabel={`peak ${tablesPeak}`}
        />
      </div>

      {/* Live floor: the tables that need a person, not a graph. Deactivate
          is here as well as on the floor tab because this is where a manager
          looks when they open the console. */}
      <section className="rounded-xl border border-line bg-surface">
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-subheading text-ink">Tables that need a look</h2>
            <p className="mt-1 text-sm text-ink-muted">
              A live session with no phone on it and no open ticket. Clear requests come first.
            </p>
          </div>
          <Badge tone={flagged.length > 0 ? "alert" : "neutral"}>
            {flagged.length} flagged
          </Badge>
        </header>

        {flagged.length === 0 ? (
          <p className="px-5 py-8 text-sm text-ink-muted">
            Every live table has a phone on it. Nothing to chase right now.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {flagged.map((table) => (
              <li
                key={table.table_id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-display text-base text-ink">{table.name}</p>
                    {table.clear_requested_at ? (
                      <Badge tone="alert">Manager requested</Badge>
                    ) : (
                      <Badge tone="pending">No device</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Table {table.code} · {table.bill_status === "paid" ? "paid" : "unpaid"}
                    {table.cart_line_count > 0
                      ? ` · ${table.cart_line_count} staged`
                      : ""}
                    {table.session_started_at
                      ? ` · open since ${formatIstDateTime(table.session_started_at)}`
                      : ""}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  loading={deactivatingId === table.table_id}
                  disabled={deactivatingId !== null && deactivatingId !== table.table_id}
                  onClick={() => onDeactivate(table)}
                  leftIcon={<PowerOff className="size-3.5" aria-hidden />}
                >
                  Deactivate
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-subheading text-ink">Top 10 best sellers today</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Today&apos;s units, from fully served tickets only. The business day runs 5am to 5am.
            </p>
          </div>
          <Badge tone="outline">{analytics.items.length} dishes</Badge>
        </header>

        {analytics.items.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState
              title="Nothing sold yet"
              description="When the kitchen serves its first ticket, the leaderboard fills itself."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <thead>
                <tr className="text-label text-ink-subtle uppercase">
                  <th className="px-5 py-3 font-semibold">Rank</th>
                  <th className="px-5 py-3 font-semibold">Dish</th>
                  <th className="px-5 py-3 font-semibold">Category</th>
                  <th className="px-5 py-3 text-right font-semibold">Units</th>
                  <th className="px-5 py-3 text-right font-semibold">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {analytics.items.map((item, index) => (
                  <tr key={item.menu_item_id} className="text-ink">
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-pill text-xs font-bold",
                          index === 0
                            ? "bg-ember text-on-ember"
                            : index < 3
                              ? "bg-ember-soft text-ember"
                              : "bg-sand text-ink-muted",
                        )}
                      >
                        {index + 1}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-medium">{item.name}</td>
                    <td className="px-5 py-3 text-ink-muted">{item.category}</td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums">
                      {item.total_sold}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums">
                      {money(item.total_revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  values,
  peakLabel,
}: {
  label: string;
  value: string;
  hint: string;
  /** The series drawn where the old icon tile sat. */
  values: number[];
  /** y-scale reference: the busiest hour in the window. */
  peakLabel: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] text-ink-subtle uppercase">
          <span
            aria-hidden
            className="size-1.5 rounded-pill bg-ember motion-safe:animate-pulse"
          />
          Today · since 5am
        </span>
        <span className="text-[10px] font-medium text-ink-subtle tabular-nums">{peakLabel}</span>
      </div>
      <Sparkline
        values={values}
        label={`${label} trend, last 24 hours`}
        className="mt-2 h-10 w-full"
      />
      {/* The time scale, written out: without it a sparkline is just a shape. */}
      <div className="mt-1 flex items-center justify-between text-[10px] text-ink-subtle">
        <span>24h ago</span>
        <span>now</span>
      </div>
      <p className="mt-3 text-label text-ink-subtle uppercase">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold text-ink tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-ink-subtle">{hint}</p>
    </div>
  );
}

/* A sparkline small enough to sit where the card icon used to be. Drawn with
   plain SVG (no chart dependency): zero-based area, a soft currentColor
   gradient and a 1.6 px line that stays crisp when the box is stretched. */
function Sparkline({
  values,
  label,
  className,
}: {
  values: number[];
  label: string;
  className?: string;
}) {
  const gradientId = useId().replace(/:/g, "");

  const WIDTH = 100;
  const HEIGHT = 32;
  const PAD = 3;

  // One point still reads as a flat line rather than an empty box.
  const series = values.length >= 2 ? values : [values[0] ?? 0, values[0] ?? 0];
  const max = Math.max(...series, 0);
  const step = WIDTH / (series.length - 1);
  const yOf = (value: number) =>
    max > 0 ? HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2) : HEIGHT - PAD;

  /* Catmull-Rom → cubic Bézier. The old straight segments gave a 24-point
     series a saw-tooth edge; this rounds every joint while still passing
     through each real reading. Tangents are clamped to the box so the curve
     cannot bulge outside the card. */
  const points = series.map((value, index) => ({ x: index * step, y: yOf(value) }));
  const clampY = (value: number) => Math.min(HEIGHT, Math.max(0, value));
  const line = points
    .map((point, index) => {
      if (index === 0) return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;

      const p1 = points[index - 1];
      if (!p1) return "";
      const p0 = points[index - 2] ?? p1;
      const p3 = points[index + 1] ?? point;

      const cp1x = p1.x + (point.x - p0.x) / 6;
      const cp1y = clampY(p1.y + (point.y - p0.y) / 6);
      const cp2x = point.x - (p3.x - p1.x) / 6;
      const cp2y = clampY(point.y - (p3.y - p1.y) / 6);

      return `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    })
    .join(" ");
  const area = `${line} L ${WIDTH} ${HEIGHT} L 0 ${HEIGHT} Z`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn("text-ember", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      {/* A wide, faint copy under the line is the soft halo — cheaper than an
          SVG blur filter and it never clips against the card edge. */}
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeOpacity="0.12"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity="0.95"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* =====================================================================
   Tab 2 — Tables
   ===================================================================== */

function TablesTab({
  tables,
  deactivatingId,
  onDeactivate,
  onChanged,
  onError,
}: {
  tables: AdminTable[];
  deactivatingId: string | null;
  onDeactivate: (table: AdminTable) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AdminTable | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AdminTable | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<AdminTable | null>(null);
  const [qrTarget, setQrTarget] = useState<{ code: string; name: string } | null>(null);
  const [codeTarget, setCodeTarget] = useState<AdminTable | null>(null);
  const [busy, setBusy] = useState(false);

  async function regenerate(table: AdminTable) {
    if (busy) return;
    setBusy(true);
    try {
      const rotated = await regenerateAdminTableToken(table.table_id);
      setQrTarget({ code: rotated.code, name: rotated.name });
      toast({
        title: "QR token regenerated",
        description: "The old code no longer opens this table.",
        tone: "success",
      });
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not regenerate the token.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(table: AdminTable) {
    if (busy) return;
    setBusy(true);
    try {
      await deleteAdminTable(table.table_id);
      setArchiveTarget(null);
      toast({ title: `${table.name} archived`, tone: "success" });
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not archive the table.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-title font-semibold text-ink">Floor &amp; tables</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Every live table, its QR code, and whether a session is open on it.
          </p>
        </div>
        <Button
          variant="ember"
          size="md"
          onClick={() => setAddOpen(true)}
          leftIcon={<Plus className="size-4" aria-hidden />}
        >
          Add new table
        </Button>
      </div>

      {tables.length === 0 ? (
        <EmptyState
          title="No tables configured"
          description="Add the first table and its QR code is generated automatically."
          action={
            <Button variant="ember" size="md" onClick={() => setAddOpen(true)}>
              Add new table
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tables.map((table) => (
            <li key={table.table_id}>
              <article className="flex h-full flex-col gap-4 rounded-xl border border-line bg-surface p-5">
                <header className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-label text-ink-subtle uppercase">Table</p>
                    <h3 className="truncate font-display text-subheading text-ink">{table.name}</h3>
                  </div>
                  <Badge tone={table.status === "active" ? "ready" : "neutral"}>
                    {table.status}
                  </Badge>
                </header>

                {/* The code strip is the QR entry point: a manager looking for
                    the code is the manager who wants the sheet it is printed
                    on, so one tap opens the printable card. */}
                <button
                  type="button"
                  onClick={() => setQrTarget({ code: table.code, name: table.name })}
                  aria-label={`Show the printable QR code for ${table.name}`}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2 text-left transition-colors duration-[var(--duration-fast)] hover:bg-sand"
                >
                  <span className="font-mono text-sm font-semibold tracking-[0.12em] text-ink">
                    {table.code}
                  </span>
                  <span className="flex items-center gap-1.5 text-label text-ink-subtle uppercase">
                    QR
                    <QrCode className="size-4" aria-hidden />
                  </span>
                </button>

                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-label text-ink-subtle uppercase">Open orders</dt>
                    <dd className="mt-0.5 font-semibold text-ink tabular-nums">
                      {table.active_order_count}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-label text-ink-subtle uppercase">Staged lines</dt>
                    <dd className="mt-0.5 font-semibold text-ink tabular-nums">
                      {table.cart_line_count}
                    </dd>
                  </div>
                </dl>

                {/* Who is sitting here. The roster is written when each
                    phone joins, so a manager can answer "who is at the corner
                    booth?" without walking the floor. */}
                <div>
                  <p className="text-label text-ink-subtle uppercase">
                    Sitting{table.members.length > 0 ? ` · ${table.members.length}` : ""}
                  </p>
                  {table.members.length > 0 ? (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {table.members.map((member) => (
                        <li
                          key={member.user_id}
                          className="rounded-pill bg-sand px-2.5 py-1 text-xs font-semibold text-ink"
                          title={`Joined ${formatIstDateTime(member.joined_at)}`}
                        >
                          {member.name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-ink-subtle">
                      {table.status === "active"
                        ? "No one has joined on a phone yet."
                        : "No one seated."}
                    </p>
                  )}
                </div>

                {table.has_session && table.session_started_at ? (
                  <p className="text-xs text-ink-subtle">
                    Session since {formatIstDateTime(table.session_started_at)}
                  </p>
                ) : null}

                <div className="mt-auto flex flex-wrap gap-2">
                  <Button
                    variant="soft"
                    size="sm"
                    onClick={() => setRenameTarget(table)}
                    leftIcon={<Pencil className="size-3.5" aria-hidden />}
                  >
                    Edit name
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCodeTarget(table)}
                    leftIcon={<KeyRound className="size-3.5" aria-hidden />}
                  >
                    Edit ID
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void regenerate(table)}
                    leftIcon={<RefreshCw className="size-3.5" aria-hidden />}
                  >
                    Regenerate QR
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deactivatingId === table.table_id}
                    onClick={() => setDeactivateTarget(table)}
                    leftIcon={<PowerOff className="size-3.5" aria-hidden />}
                  >
                    Deactivate
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setArchiveTarget(table)}
                    leftIcon={<Trash2 className="size-3.5" aria-hidden />}
                  >
                    Archive
                  </Button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <AddTableModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          onChanged();
        }}
      />

      <RenameTableModal
        table={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRenamed={() => {
          setRenameTarget(null);
          onChanged();
        }}
      />

      <QrCodeModal target={qrTarget} onClose={() => setQrTarget(null)} />

      <EditTableCodeModal
        table={codeTarget}
        onClose={() => setCodeTarget(null)}
        onSaved={(saved) => {
          setCodeTarget(null);
          setQrTarget({ code: saved.code, name: saved.name });
          onChanged();
        }}
        onError={onError}
      />

      <ConfirmModal
        open={deactivateTarget !== null}
        title={`Deactivate ${deactivateTarget?.name ?? "this table"}?`}
        description="Ends the session immediately, even if the bill is unpaid or a ticket is open. Open tickets are closed as served, and the table code (and its printed QR) is kept."
        confirmLabel="Deactivate table"
        busy={deactivateTarget !== null && deactivatingId === deactivateTarget.table_id}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={() => {
          if (deactivateTarget) {
            onDeactivate(deactivateTarget);
            setDeactivateTarget(null);
          }
        }}
      />

      <ConfirmModal
        open={archiveTarget !== null}
        title={`Archive ${archiveTarget?.name ?? "this table"}?`}
        description="Archived tables retain sales history."
        confirmLabel="Archive table"
        busy={busy}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => {
          if (archiveTarget) void archive(archiveTarget);
        }}
      />
    </div>
  );
}

function AddTableModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the table a name.");
      return;
    }
    setBusy(true);
    try {
      await createAdminTable(name.trim());
      setName("");
      setError(undefined);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the table.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a new table"
      description="Auto-generated table QR."
      size="sm"
      footer={
        <>
          <Button variant="soft" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="ember" size="lg" type="submit" form="add-table-form" loading={busy}>
            Create table
          </Button>
        </>
      }
    >
      <form id="add-table-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Table name"
          hint="What the floor calls it, e.g. “Garden six-top”."
          value={name}
          error={error}
          maxLength={60}
          onChange={(event) => {
            setError(undefined);
            setName(event.target.value);
          }}
          placeholder="Window four-top"
        />
      </form>
    </Modal>
  );
}

function RenameTableModal({
  table,
  onClose,
  onRenamed,
}: {
  table: AdminTable | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Seeded when the dialog opens, never during render of a closed dialog.
  // Deferred so the effect body does not write state synchronously.
  useEffect(() => {
    if (!table) return;
    const timer = window.setTimeout(() => {
      setName(table.name);
      setError(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [table]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!table) return;
    if (!name.trim()) {
      setError("The table name cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      await renameAdminTable(table.table_id, name.trim());
      onRenamed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename the table.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={table !== null}
      onClose={onClose}
      title="Edit table name"
      size="sm"
      footer={
        <>
          <Button variant="soft" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="ember" size="lg" type="submit" form="rename-table-form" loading={busy}>
            Save name
          </Button>
        </>
      }
    >
      <form id="rename-table-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Table name"
          value={name}
          error={error}
          maxLength={60}
          onChange={(event) => {
            setError(undefined);
            setName(event.target.value);
          }}
        />
        <p className="text-xs text-ink-subtle">
          The QR code is not affected — guests already holding the link keep their session.
        </p>
      </form>
    </Modal>
  );
}

/* A table is editable only while nobody is using it. Mirrors the server's
   guard in `updateTableCode` so the dialog can explain itself before a save
   comes back as 409. */
function tableIsEmpty(table: AdminTable) {
  return (
    table.status === "empty" &&
    !table.has_session &&
    table.active_order_count === 0 &&
    table.cart_line_count === 0
  );
}

function EditTableCodeModal({
  table,
  onClose,
  onSaved,
  onError,
}: {
  table: AdminTable | null;
  onClose: () => void;
  onSaved: (saved: { code: string; name: string }) => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!table) return;
    const timer = window.setTimeout(() => {
      setCode(table.code);
      setError(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [table]);

  const empty = table !== null && tableIsEmpty(table);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!table || !empty) return;

    const next = code.trim().toLowerCase();
    if (!/^[a-z0-9]{5,8}$/.test(next)) {
      setError("Use 5–8 letters or digits, e.g. k7x2p or table12.");
      return;
    }

    setBusy(true);
    try {
      const saved = await updateAdminTableCode(table.table_id, next);
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else onError("Could not update the table code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={table !== null}
      onClose={onClose}
      title="Edit table ID"
      size="sm"
      footer={
        <>
          <Button variant="soft" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="ember"
            size="lg"
            type="submit"
            form="edit-table-code-form"
            loading={busy}
            disabled={!empty}
          >
            Save ID
          </Button>
        </>
      }
    >
      <form id="edit-table-code-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {empty ? null : (
          <p
            role="status"
            className="rounded-md border border-alert/40 bg-alert-surface px-3.5 py-3 text-sm leading-relaxed text-ink-muted"
          >
            This table is not empty — a party is seated, a cart is staged, or a ticket is open.
            Clear the table first; its ID cannot change under the guests already holding it.
          </p>
        )}

        <Input
          label="Table ID"
          hint="5–8 lowercase letters or digits. The QR code encodes /table/&lt;id&gt;."
          value={code}
          error={error}
          maxLength={8}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={!empty}
          onChange={(event) => {
            setError(undefined);
            setCode(event.target.value.toLowerCase());
          }}
        />

        <p className="text-xs text-ink-subtle">
          Use this after regenerating a code: set it back to the one printed on the stand, or
          print a fresh QR from the next screen.
        </p>
      </form>
    </Modal>
  );
}

/* The printable sheet: brand at the top, the code at the bottom, and nothing
   that does not belong on a table stand. The dialog is the preview; the
   download draws the same card at print resolution (see buildQrCardImage). */
function QrCodeModal({
  target,
  onClose,
}: {
  target: { code: string; name: string } | null;
  onClose: () => void;
}) {
  const [svg, setSvg] = useState<{ code: string; markup: string | null } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;

    const payload =
      typeof window === "undefined"
        ? `/table/${target.code}`
        : `${window.location.origin}/table/${target.code}`;

    void QRCode.toString(payload, {
      type: "svg",
      margin: 2,
      width: 320,
      errorCorrectionLevel: "M",
      color: { dark: "#1c1512", light: "#ffffff" },
    })
      .then((markup) => {
        if (!cancelled) setSvg({ code: target.code, markup });
      })
      .catch(() => {
        if (!cancelled) setSvg({ code: target.code, markup: null });
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  const markup = target && svg?.code === target.code ? svg.markup : null;

  async function download() {
    if (!target) return;
    setDownloading(true);
    setError(null);
    try {
      const dataUrl = await buildQrCardImage(target.code, target.name);
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `aeychhotu-table-${target.code}.png`;
      anchor.click();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the QR sheet.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title="Table QR sheet"
      description="Print it, stick it on the stand, and the table is live."
      size="sm"
      footer={
        <>
          <Button
            variant="soft"
            size="lg"
            onClick={() => window.print()}
            leftIcon={<Printer className="size-4" aria-hidden />}
          >
            Print
          </Button>
          <Button
            variant="ember"
            size="lg"
            onClick={() => void download()}
            loading={downloading}
            disabled={!markup}
            leftIcon={<Download className="size-4" aria-hidden />}
          >
            Download PNG
          </Button>
        </>
      }
    >
      {/* Only this block survives the print stylesheet — see globals.css. */}
      <div className="admin-print-area w-full">
        <article className="mx-auto flex w-full max-w-sm flex-col items-center rounded-xl border border-line bg-surface px-6 py-7 text-center">
          <Logo />

          <span aria-hidden className="mt-4 h-px w-16 bg-line-strong" />

          <div className="mt-5 flex size-64 items-center justify-center rounded-lg border border-line bg-white p-3">
            {markup ? (
              <div
                role="img"
                aria-label={`QR code for table ${target?.code ?? ""}`}
                className="[&>svg]:size-full"
                dangerouslySetInnerHTML={{ __html: markup }}
              />
            ) : (
              <span className="text-sm text-ink-subtle">Drawing the code…</span>
            )}
          </div>

          <p className="mt-5 font-display text-lg font-semibold text-ink">{target?.name}</p>
          <p className="mt-1.5 text-sm text-ink-muted">Scan to activate this table</p>
          <p className="mt-3 text-label text-ink-subtle uppercase">Table ID</p>
          <p className="font-mono text-base font-semibold tracking-[0.16em] text-ink">
            {target?.code}
          </p>
        </article>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-center text-sm text-alert">
          {error}
        </p>
      ) : null}

      <p className="mt-4 text-center text-xs text-ink-subtle">
        Scanning opens this table&apos;s shared cart. Regenerating the code invalidates this stand.
      </p>
    </Modal>
  );
}

/* Draws the printable card at 1000×1400 so the QR is ~660px wide — a printer
   resolves that crisply, where an upscaled 256px thumbnail would not. Kept in
   step with the dialog preview by hand: same order, same words. */
async function buildQrCardImage(code: string, name: string): Promise<string> {
  const width = 1000;
  const height = 1400;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the QR sheet.");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // The brand rule along the top edge: the same ember the UI uses.
  ctx.fillStyle = "#b4552d";
  ctx.fillRect(0, 0, width, 14);

  const logo = await loadImage("/logo.png").catch(() => null);
  if (logo) {
    ctx.drawImage(logo, width / 2 - 60, 110, 120, 120);
  }

  const markY = logo ? 320 : 220;
  const brand = "AeyChhotu";
  const bang = "!";
  ctx.font = "600 60px Georgia, 'Times New Roman', serif";
  ctx.textAlign = "left";

  const total = ctx.measureText(brand + bang).width;
  let x = (width - total) / 2;
  ctx.fillStyle = "#1c1512";
  ctx.fillText(brand, x, markY);
  x += ctx.measureText(brand).width;
  ctx.fillStyle = "#b4552d";
  ctx.fillText(bang, x, markY);

  ctx.textAlign = "center";
  ctx.fillStyle = "#7a6a5f";
  ctx.font = "400 26px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText("one table, one order, live from the kitchen", width / 2, markY + 48);

  ctx.fillStyle = "#e7ded4";
  ctx.fillRect(width / 2 - 140, 400, 280, 2);

  const payload = `${window.location.origin}/table/${code}`;
  const qrDataUrl = await QRCode.toDataURL(payload, {
    margin: 2,
    width: 660,
    errorCorrectionLevel: "M",
    color: { dark: "#1c1512", light: "#ffffff" },
  });
  const qr = await loadImage(qrDataUrl);
  ctx.drawImage(qr, (width - 660) / 2, 440, 660, 660);

  ctx.fillStyle = "#1c1512";
  ctx.font = "500 44px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText(name, width / 2, 1180);

  ctx.font = "600 38px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText("Scan to activate this table", width / 2, 1244);

  ctx.fillStyle = "#7a6a5f";
  ctx.font = "600 22px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillText("TABLE ID", width / 2, 1296);

  ctx.fillStyle = "#b4552d";
  ctx.font = "600 40px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(code, width / 2, 1344);

  return canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
}

/* =====================================================================
   Tab 3 — Menu catalog
   ===================================================================== */

function MenuTab({
  menu,
  categories,
  onChanged,
  onError,
}: {
  menu: AdminMenuItem[];
  categories: AdminCategory[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { toast } = useToast();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminMenuItem | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AdminMenuItem | null>(null);
  const [folderDraft, setFolderDraft] = useState<{
    parentId: string | null;
    folder: AdminCategory | null;
  } | null>(null);
  const [folderDelete, setFolderDelete] = useState<AdminCategory | null>(null);
  const [coverTarget, setCoverTarget] = useState<AdminCategory | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const folders = categories.filter((folder) => folder.parent_id === currentId);
  const dishes = menu.filter((item) => (item.category_id ?? null) === currentId);

  /* Breadcrumb: walk to the root once. Cheap (the tree is tiny) and it always
     shows the way back out of a deep folder. */
  const trail: AdminCategory[] = [];
  let cursor: AdminCategory | null =
    categories.find((folder) => folder.category_id === currentId) ?? null;
  while (cursor) {
    trail.unshift(cursor);
    const parentId: string | null = cursor.parent_id;
    cursor = parentId
      ? (categories.find((folder) => folder.category_id === parentId) ?? null)
      : null;
  }

  const pathLabel = trail.length > 0 ? trail[trail.length - 1]?.name : "Catalog";

  async function toggleAvailability(item: AdminMenuItem) {
    if (busyId) return;
    setBusyId(item.menu_item_id);
    try {
      await updateAdminMenuItem(item.menu_item_id, { is_available: !item.is_available });
      toast({
        title: !item.is_available ? `${item.name} is back` : `${item.name} 86'd`,
        tone: "success",
      });
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not update availability.");
    } finally {
      setBusyId(null);
    }
  }

  async function archive(item: AdminMenuItem) {
    setBusyId(item.menu_item_id);
    try {
      await deleteAdminMenuItem(item.menu_item_id);
      setArchiveTarget(null);
      toast({ title: `${item.name} archived`, tone: "success" });
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not archive the dish.");
    } finally {
      setBusyId(null);
    }
  }

  async function removeFolder(folder: AdminCategory) {
    setBusyId(folder.category_id);
    try {
      await deleteAdminCategory(folder.category_id);
      if (currentId === folder.category_id) setCurrentId(folder.parent_id);
      setFolderDelete(null);
      toast({ title: `${folder.name} removed`, tone: "success" });
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not remove the folder.");
    } finally {
      setBusyId(null);
    }
  }

  const isEmpty = folders.length === 0 && dishes.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-title font-semibold text-ink">Menu catalog</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Categories are folders. Open one to see its dishes; a cover is any dish photo inside it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="md"
            onClick={() => setFolderDraft({ parentId: currentId, folder: null })}
            leftIcon={<FolderPlus className="size-4" aria-hidden />}
          >
            New folder
          </Button>
          <Button
            variant="ember"
            size="md"
            onClick={() => setAddOpen(true)}
            leftIcon={<Plus className="size-4" aria-hidden />}
          >
            Add dish
          </Button>
        </div>
      </div>

      <nav aria-label="Catalogue path" className="flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          onClick={() => setCurrentId(null)}
          className={cn(
            "cursor-pointer rounded-md px-2 py-1 transition-colors duration-[var(--duration-fast)]",
            currentId === null
              ? "bg-ink text-ink-inverse"
              : "text-ink-muted hover:bg-sand hover:text-ink",
          )}
        >
          Catalog
        </button>
        {trail.map((folder) => (
          <span key={folder.category_id} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 text-ink-subtle" aria-hidden />
            <button
              type="button"
              onClick={() => setCurrentId(folder.category_id)}
              className={cn(
                "cursor-pointer rounded-md px-2 py-1 transition-colors duration-[var(--duration-fast)]",
                folder.category_id === currentId
                  ? "bg-ink text-ink-inverse"
                  : "text-ink-muted hover:bg-sand hover:text-ink",
              )}
            >
              {folder.name}
            </button>
          </span>
        ))}
      </nav>

      {folders.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {folders.map((folder) => {
            const cover = resolveApiAssetUrl(folder.thumbnail?.image_small_url ?? null);
            const subfolders = categories.filter(
              (entry) => entry.parent_id === folder.category_id,
            ).length;

            return (
              <li key={folder.category_id}>
                <article className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface">
                  <button
                    type="button"
                    onClick={() => setCurrentId(folder.category_id)}
                    aria-label={`Open folder ${folder.name}`}
                    className="flex flex-1 cursor-pointer items-center gap-3 p-4 text-left transition-colors duration-[var(--duration-fast)] hover:bg-sand/60"
                  >
                    <span className="relative block size-16 shrink-0 overflow-hidden rounded-lg bg-surface-sunken">
                      {cover ? (
                        <Image
                          src={cover}
                          alt=""
                          fill
                          unoptimized
                          sizes="64px"
                          className="object-cover"
                        />
                      ) : (
                        <span className="flex size-full items-center justify-center text-ember">
                          <Folder className="size-7" aria-hidden />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-label text-ink-subtle uppercase">Folder</span>
                      <span className="mt-0.5 block truncate font-display text-subheading text-ink">
                        {folder.name}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-subtle">
                        {folder.item_count} {folder.item_count === 1 ? "dish" : "dishes"}
                        {subfolders > 0
                          ? ` · ${subfolders} ${subfolders === 1 ? "folder" : "folders"}`
                          : ""}
                      </span>
                    </span>
                  </button>

                  <div className="flex flex-wrap gap-1 border-t border-line px-2 py-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setCoverTarget(folder)}>
                      Cover
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setFolderDraft({ parentId: folder.parent_id, folder })
                      }
                    >
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === folder.category_id}
                      onClick={() => setFolderDelete(folder)}
                      leftIcon={<Trash2 className="size-3.5" aria-hidden />}
                    >
                      Delete
                    </Button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}

      {dishes.length === 0 ? (
        isEmpty ? (
          <EmptyState
            title={currentId === null ? "The catalog is empty" : `${pathLabel} is empty`}
            description={
              currentId === null
                ? "Add the first dish, or create a folder to organise them."
                : "Add a dish here, or open another folder."
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="ember"
                  size="md"
                  onClick={() => setAddOpen(true)}
                  leftIcon={<Plus className="size-4" aria-hidden />}
                >
                  Add dish
                </Button>
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => setFolderDraft({ parentId: currentId, folder: null })}
                >
                  New folder
                </Button>
              </div>
            }
          />
        ) : (
          <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
            No dishes directly in this folder. Open one of the folders above.
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {dishes.map((item) => {
            const uploaded = resolveApiAssetUrl(item.image_small_url);
            const photo = uploaded ?? resolveDishPhoto(item);

            return (
              <li key={item.menu_item_id}>
                <article className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface p-3">
                  <span className="relative block size-20 shrink-0 overflow-hidden rounded-lg bg-surface-sunken">
                    {photo ? (
                      <Image
                        src={photo}
                        alt=""
                        fill
                        unoptimized={Boolean(uploaded)}
                        sizes="80px"
                        className="object-cover"
                      />
                    ) : (
                      <span className="flex size-full items-center justify-center text-ember">
                        <Utensils className="size-6" aria-hidden />
                      </span>
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-subheading text-ink">{item.name}</h3>
                      <span
                        aria-label={item.vegetarian ? "Vegetarian" : "Non-vegetarian"}
                        className={cn(
                          "flex size-4 items-center justify-center rounded-[3px] border",
                          item.vegetarian ? "border-ready text-ready" : "border-alert text-alert",
                        )}
                      >
                        <span className="size-2 rounded-pill bg-current" />
                      </span>
                      {item.is_available ? null : <Badge tone="alert">86&apos;d</Badge>}
                      {item.image_small_url ? (
                        <Badge tone="neutral">Photo</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
                      {item.description || "No description yet."}
                    </p>
                    <p className="mt-1.5 text-xs text-ink-subtle">
                      {money(item.price)}
                      {currentId === null ? ` · ${item.category}` : ""}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={item.is_available ? "soft" : "ember"}
                      size="sm"
                      disabled={busyId === item.menu_item_id}
                      onClick={() => void toggleAvailability(item)}
                    >
                      {item.is_available ? "86 this dish" : "Bring back"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditTarget(item)}
                      leftIcon={<Pencil className="size-3.5" aria-hidden />}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setArchiveTarget(item)}
                      leftIcon={<Trash2 className="size-3.5" aria-hidden />}
                    >
                      Archive
                    </Button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <DishModal
        open={addOpen}
        item={null}
        categories={categories}
        defaultCategoryId={currentId}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          setAddOpen(false);
          onChanged();
        }}
        onImageChanged={onChanged}
      />

      <DishModal
        open={editTarget !== null}
        item={editTarget}
        categories={categories}
        defaultCategoryId={editTarget?.category_id ?? currentId}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          onChanged();
        }}
        onImageChanged={onChanged}
      />

      <FolderModal
        open={folderDraft !== null}
        folder={folderDraft?.folder ?? null}
        parentId={folderDraft?.parentId ?? null}
        parentName={
          categories.find(
            (folder) => folder.category_id === (folderDraft?.parentId ?? null),
          )?.name ?? null
        }
        onClose={() => setFolderDraft(null)}
        onSaved={(message) => {
          setFolderDraft(null);
          toast({ title: message, tone: "success" });
          onChanged();
        }}
        onError={onError}
      />

      <CoverPickerModal
        folder={coverTarget}
        menu={menu}
        onClose={() => setCoverTarget(null)}
        onChanged={onChanged}
        onError={onError}
      />

      <ConfirmModal
        open={folderDelete !== null}
        title={`Delete ${folderDelete?.name ?? "this folder"}?`}
        description="Only an empty folder can be deleted. Its dishes and subfolders must be moved or archived first."
        confirmLabel="Delete folder"
        busy={busyId === folderDelete?.category_id}
        onClose={() => setFolderDelete(null)}
        onConfirm={() => {
          if (folderDelete) void removeFolder(folderDelete);
        }}
      />

      <ConfirmModal
        open={archiveTarget !== null}
        title={`Archive ${archiveTarget?.name ?? "this dish"}?`}
        description="It disappears from every diner menu. Tickets that already contain it keep their frozen price and name, so past bills do not change."
        confirmLabel="Archive dish"
        busy={busyId === archiveTarget?.menu_item_id}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => {
          if (archiveTarget) void archive(archiveTarget);
        }}
      />
    </div>
  );
}

/* =====================================================================
   Folders
   ===================================================================== */

function folderOptions(categories: AdminCategory[]): { id: string; label: string }[] {
  const byParent = new Map<string | null, AdminCategory[]>();
  for (const folder of categories) {
    const siblings = byParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    byParent.set(folder.parent_id, siblings);
  }

  const options: { id: string; label: string }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of byParent.get(parentId) ?? []) {
      options.push({
        id: folder.category_id,
        label: `${"— ".repeat(depth)}${folder.name}`,
      });
      walk(folder.category_id, depth + 1);
    }
  };
  walk(null, 0);
  return options;
}

function FolderModal({
  open,
  folder,
  parentId,
  parentName,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  folder: AdminCategory | null;
  parentId: string | null;
  parentName: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setName(folder?.name ?? "");
      setError(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, folder]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the folder a name.");
      return;
    }

    setBusy(true);
    try {
      if (folder) {
        await updateAdminCategory(folder.category_id, { name: name.trim() });
        onSaved(`Renamed to ${name.trim()}`);
      } else {
        await createAdminCategory({ name: name.trim(), parent_id: parentId });
        onSaved(`Folder ${name.trim()} created`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the folder.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={folder ? "Rename folder" : "New folder"}
      description={
        folder
          ? "Dishes inside keep their photos and prices."
          : parentName
            ? `Inside ${parentName}.`
            : "At the top level of the catalog."
      }
      size="sm"
      footer={
        <>
          <Button variant="soft" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="ember" size="lg" type="submit" form="folder-form" loading={busy}>
            {folder ? "Save name" : "Create folder"}
          </Button>
        </>
      }
    >
      <form id="folder-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Folder name"
          value={name}
          error={error}
          maxLength={60}
          placeholder="Starters"
          onChange={(event) => {
            setError(undefined);
            setName(event.target.value);
          }}
        />
        <p className="text-xs text-ink-subtle">
          Folders are categories. You can nest them as deep as the menu needs.
        </p>
      </form>
    </Modal>
  );
}

function CoverPickerModal({
  folder,
  menu,
  onClose,
  onChanged,
  onError,
}: {
  folder: AdminCategory | null;
  menu: AdminMenuItem[];
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function pick(item: AdminMenuItem | null) {
    if (!folder) return;
    setBusyId(item?.menu_item_id ?? "clear");
    try {
      await updateAdminCategory(folder.category_id, {
        thumbnail_menu_item_id: item?.menu_item_id ?? null,
      });
      onChanged();
      onClose();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not set the folder cover.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal
      open={folder !== null}
      onClose={onClose}
      title={folder ? `Cover for ${folder.name}` : "Folder cover"}
      description="Pick one of your dish photos — the folder shows it in the explorer."
      size="lg"
      footer={
        <>
          <Button
            variant="soft"
            size="lg"
            onClick={() => void pick(null)}
            loading={busyId === "clear"}
          >
            Use folder icon
          </Button>
          <Button variant="outline" size="lg" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {menu.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-muted">
          Add a dish with a photo first.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {menu.map((item) => {
            const uploaded = resolveApiAssetUrl(item.image_small_url);
            const photo = uploaded ?? resolveDishPhoto(item);

            return (
              <li key={item.menu_item_id}>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void pick(item)}
                  className={cn(
                    "flex w-full cursor-pointer flex-col overflow-hidden rounded-lg border bg-surface text-left transition-[border-color,transform] duration-[var(--duration-fast)] hover:-translate-y-0.5",
                    folder?.thumbnail_menu_item_id === item.menu_item_id
                      ? "border-ember ring-1 ring-ember/30"
                      : "border-line hover:border-line-strong",
                    busyId === item.menu_item_id && "opacity-60",
                  )}
                >
                  <span className="relative block aspect-[4/3] w-full bg-surface-sunken">
                    {photo ? (
                      <Image
                        src={photo}
                        alt=""
                        fill
                        unoptimized={Boolean(uploaded)}
                        sizes="(min-width: 640px) 160px, 45vw"
                        className="object-cover"
                      />
                    ) : (
                      <span className="flex size-full items-center justify-center text-ember">
                        <Utensils className="size-6" aria-hidden />
                      </span>
                    )}
                  </span>
                  <span className="block truncate px-2.5 py-2 text-xs font-semibold text-ink">
                    {item.name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/* =====================================================================
   Dish editor (fields + photo)
   ===================================================================== */

const DISH_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const DISH_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function DishModal({
  open,
  item,
  categories,
  defaultCategoryId,
  onClose,
  onSaved,
  onImageChanged,
}: {
  open: boolean;
  item: AdminMenuItem | null;
  categories: AdminCategory[];
  defaultCategoryId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onImageChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [vegetarian, setVegetarian] = useState(true);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  /* Fill the form when it opens (edit) or open it empty (create). Deferred a
     frame so the effect body never writes state synchronously. */
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setName(item?.name ?? "");
      setPrice(String(item?.price ?? 0));
      setCategoryId(item?.category_id ?? defaultCategoryId ?? null);
      setDescription(item?.description ?? "");
      setVegetarian(item?.vegetarian ?? true);
      setAvailable(item?.is_available ?? true);
      setError(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, item, defaultCategoryId]);

  const folders = folderOptions(categories);

  async function submit(event: FormEvent) {
    event.preventDefault();

    const amount = Number(price);

    if (!name.trim()) {
      setError("Give the dish a name.");
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Price must be zero or more.");
      return;
    }

    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        price: amount,
        category_id: categoryId,
        description: description.trim(),
        vegetarian,
        is_available: available,
      };

      if (item) {
        await updateAdminMenuItem(item.menu_item_id, payload);
      } else {
        await createAdminMenuItem(payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the dish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={item ? `Edit ${item.name}` : "Add a new dish"}
      description={
        item
          ? "Past tickets keep the price they were charged — this only changes the menu."
          : "It appears on every active table's menu the moment you save."
      }
      size="md"
      footer={
        <>
          <Button variant="soft" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="ember" size="lg" type="submit" form="dish-form" loading={busy}>
            {item ? "Save changes" : "Add dish"}
          </Button>
        </>
      }
    >
      <form id="dish-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Dish name"
          value={name}
          onChange={(event) => {
            setError(undefined);
            setName(event.target.value);
          }}
          maxLength={120}
          placeholder="Masala Dosa"
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Price (₹)"
            type="number"
            min={0}
            step="1"
            inputMode="decimal"
            value={price}
            onChange={(event) => {
              setError(undefined);
              setPrice(event.target.value);
            }}
          />
          <FieldShell id="dish-folder" label="Folder">
            <select
              id="dish-folder"
              value={categoryId ?? ""}
              onChange={(event) => {
                setError(undefined);
                setCategoryId(event.target.value || null);
              }}
              className={controlStyles()}
            >
              <option value="">Unfiled (top level)</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.label}
                </option>
              ))}
            </select>
          </FieldShell>
        </div>

        <FieldShell id="dish-description" label="Description">
          <textarea
            id="dish-description"
            value={description}
            maxLength={500}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            className={cn(controlStyles(), "resize-y py-2.5")}
            placeholder="Crisp rice crepe, potato masala, coconut chutney."
          />
        </FieldShell>

        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleField
            label="Vegetarian"
            hint="Shows the green veg mark on the menu."
            checked={vegetarian}
            onChange={setVegetarian}
          />
          <ToggleField
            label="Available"
            hint="Turn off to 86 the dish instantly."
            checked={available}
            onChange={setAvailable}
          />
        </div>

        {item ? (
          <DishImageEditor item={item} onChanged={onImageChanged} />
        ) : (
          <p className="rounded-md border border-line bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-subtle">
            Save the dish first, then open it again to upload a photo.
          </p>
        )}

        {error ? (
          <p role="alert" className="text-sm font-medium text-alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/* The photo section of the dish editor. Uploading is immediate and separate
   from saving the form: the photo belongs to the dish row, and a failed upload
   must never silently roll back a price edit the manager just made. */
function DishImageEditor({
  item,
  onChanged,
}: {
  item: AdminMenuItem;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<AdminMenuImage | null>(null);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = item.image_small_url
    ? {
        image_url: item.image_url ?? item.image_small_url,
        image_small_url: item.image_small_url,
        blur_data_url: item.blur_data_url ?? "",
      }
    : null;
  const current = removed ? null : (uploaded ?? existing);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);

    if (file.size > DISH_IMAGE_MAX_BYTES) {
      setError("Photos must be 8 MB or smaller.");
      return;
    }
    if (file.type && !DISH_IMAGE_TYPES.includes(file.type)) {
      setError("Use a JPEG, PNG, WebP or AVIF photo.");
      return;
    }

    setBusy(true);
    try {
      const saved = await uploadAdminMenuImage(item.menu_item_id, file);
      setUploaded(saved);
      setRemoved(false);
      toast({ title: "Photo saved", tone: "success" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload the photo.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteAdminMenuImage(item.menu_item_id);
      setUploaded(null);
      setRemoved(true);
      toast({ title: "Photo removed", tone: "success" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the photo.");
    } finally {
      setBusy(false);
    }
  }

  const preview = resolveApiAssetUrl(current?.image_small_url ?? null);

  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-3">
      <p className="text-label text-ink-subtle uppercase">Dish photo</p>

      <div className="mt-2 flex items-center gap-3">
        <span className="relative block size-20 shrink-0 overflow-hidden rounded-md bg-canvas">
          {preview ? (
            <Image
              src={preview}
              alt={`Photo of ${item.name}`}
              fill
              unoptimized
              sizes="80px"
              className="object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-ink-subtle">
              <ImagePlus className="size-5" aria-hidden />
            </span>
          )}
        </span>

        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={DISH_IMAGE_TYPES.join(",")}
            className="sr-only"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <Button
            variant="outline"
            size="sm"
            loading={busy}
            onClick={() => fileRef.current?.click()}
            leftIcon={<ImagePlus className="size-3.5" aria-hidden />}
          >
            {current ? "Replace photo" : "Upload photo"}
          </Button>
          {current ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-ink-subtle">
        JPEG, PNG, WebP or AVIF, up to 8 MB. The app stores a full, a 480px and a 50px copy —
        the tiny one is blurred in while the card loads on a slow connection.
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}


function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-line bg-surface-sunken px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="mt-0.5 block text-xs leading-snug text-ink-subtle">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 cursor-pointer rounded-pill transition-colors duration-[var(--duration-fast)]",
          checked ? "bg-ember" : "bg-line-strong",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-0.5 left-0.5 size-5 rounded-pill bg-surface shadow-xs transition-transform duration-[var(--duration-fast)]",
            checked && "translate-x-5",
          )}
        />
      </button>
    </div>
  );
}

/* =====================================================================
   Shared confirm dialog
   ===================================================================== */

function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="soft" size="lg" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="lg" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-muted">{description}</p>
    </Modal>
  );
}
