"use client";

import {
  BarChart3,
  Check,
  Download,
  IndianRupee,
  KeyRound,
  LayoutGrid,
  LogOut,
  Pencil,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Utensils,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
  clearAdminTable,
  createAdminMenuItem,
  createAdminTable,
  deleteAdminMenuItem,
  deleteAdminTable,
  getAdminAnalytics,
  getAdminMenu,
  getAdminTables,
  getAdminToken,
  loginAdmin,
  regenerateAdminTableToken,
  renameAdminTable,
  subscribeMenuUpdates,
  subscribeTableUpdates,
  updateAdminMenuItem,
  type AdminAnalytics,
  type AdminMenuItem,
  type AdminTable,
} from "@/lib/api-client";
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

function AdminConsole({ onLock }: { onLock: () => void }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<AdminTab>("analytics");

  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [menu, setMenu] = useState<AdminMenuItem[]>([]);
  const [phase, setPhase] = useState<"loading" | "error" | "success">("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [clearingId, setClearingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [nextAnalytics, nextTables, nextMenu] = await Promise.all([
          getAdminAnalytics(),
          getAdminTables(),
          getAdminMenu(),
        ]);
        if (cancelled) return;
        setAnalytics(nextAnalytics);
        setTables(nextTables);
        setMenu(nextMenu);
        setPhase("success");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // The token expired or was rejected: the gate owns the next step.
          onLock();
          return;
        }
        setError(err instanceof ApiError ? err : new ApiError(0, "INTERNAL", "Could not load the console."));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadKey, onLock]);

  function refresh() {
    setPhase("loading");
    setError(null);
    setReloadKey((key) => key + 1);
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

  /* Realtime revalidation. Every console tab reads one of two published
     tables (sql/008): menu_items for the catalog, restaurant_tables for the
     grid and bill state. A burst of events — a fire, a settle, an 86 — is
     collapsed into one REST read, and the read never flips the screen back
     to skeletons. No refresh button exists because none is needed. */
  const revalidating = useRef(false);
  useEffect(() => {
    if (phase !== "success") return;

    const revalidate = () => {
      if (revalidating.current) return;
      revalidating.current = true;
      void Promise.all([getAdminAnalytics(), getAdminTables(), getAdminMenu()])
        .then(([nextAnalytics, nextTables, nextMenu]) => {
          setAnalytics(nextAnalytics);
          setTables(nextTables);
          setMenu(nextMenu);
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            onLock();
          }
        })
        .finally(() => {
          revalidating.current = false;
        });
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        revalidate();
      }, 400);
    };

    const detachMenu = subscribeMenuUpdates(schedule);
    const detachTables = subscribeTableUpdates(schedule);

    // Safety net for deployments where RLS denies the table channel (an
    // admin JWT is not a floor claim): the console still refreshes itself,
    // just more slowly, and never through a button.
    const poll = setInterval(revalidate, 15_000);

    return () => {
      if (timer !== null) clearTimeout(timer);
      clearInterval(poll);
      detachMenu();
      detachTables();
    };
  }, [phase, onLock]);

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
                  onClick={refresh}
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
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur-md">
        <Container className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-md bg-ink text-ink-inverse">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-label text-ink-subtle uppercase">AeyChhotu</p>
              <h1 className="truncate font-display text-subheading leading-none text-ink">
                Manager console
              </h1>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Backup refresh: Realtime revalidates the console on its own,
                but an operator gets a manual re-read when a socket dies. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              leftIcon={<RefreshCw className="size-4" aria-hidden />}
            >
              Refresh
            </Button>
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
          <AnalyticsTab analytics={analytics} tables={tables} />
        ) : tab === "tables" ? (
          <TablesTab
            tables={tables}
            onChanged={refresh}
            onError={(message) => toast({ title: message, tone: "error" })}
          />
        ) : (
          <MenuTab
            menu={menu}
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
}: {
  analytics: AdminAnalytics | null;
  tables: AdminTable[];
}) {
  if (!analytics) {
    return <EmptyState title="No analytics yet" description="Fire and serve an order to see it here." />;
  }

  const activeTables = tables.filter((table) => table.status === "active").length;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Revenue collected"
          value={money(analytics.total_revenue)}
          icon={IndianRupee}
          hint="Served tickets only"
        />
        <Stat
          label="Orders completed"
          value={String(analytics.total_orders_served)}
          icon={Check}
          hint="Tickets marked served"
        />
        <Stat
          label="Active tables"
          value={String(activeTables)}
          icon={LayoutGrid}
          hint="Sessions open right now"
        />
      </div>

      <section className="rounded-xl border border-line bg-surface">
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-subheading text-ink">Top 10 best sellers</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Ranked by units sold across fully served orders.
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
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: typeof IndianRupee;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <span className="flex size-9 items-center justify-center rounded-md bg-ember-soft text-ember">
        <Icon className="size-4" aria-hidden />
      </span>
      <p className="mt-4 text-label text-ink-subtle uppercase">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold text-ink tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-ink-subtle">{hint}</p>
    </div>
  );
}

/* =====================================================================
   Tab 2 — Tables
   ===================================================================== */

function TablesTab({
  tables,
  onChanged,
  onError,
}: {
  tables: AdminTable[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AdminTable | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AdminTable | null>(null);
  const [qrTarget, setQrTarget] = useState<{ code: string; name: string } | null>(null);
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

                <div className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2">
                  <span className="font-mono text-sm font-semibold tracking-[0.12em] text-ink">
                    {table.code}
                  </span>
                  <QrCode className="size-4 text-ink-subtle" aria-hidden />
                </div>

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

                <p className="text-xs text-ink-subtle">
                  {table.has_session && table.session_started_at
                    ? `Session since ${formatIstDateTime(table.session_started_at)}`
                    : "No session — the next scan claims it."}
                </p>

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
                    disabled={busy}
                    onClick={() => void regenerate(table)}
                    leftIcon={<RefreshCw className="size-3.5" aria-hidden />}
                  >
                    Regenerate QR
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

function QrCodeModal({
  target,
  onClose,
}: {
  target: { code: string; name: string } | null;
  onClose: () => void;
}) {
  const [svg, setSvg] = useState<{ code: string; markup: string | null } | null>(null);

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

  function download() {
    if (!target || !markup) return;
    const blob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `aeychhotu-table-${target.code}.svg`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={target ? `QR for ${target.name}` : "Table QR"}
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
            onClick={download}
            disabled={!markup}
            leftIcon={<Download className="size-4" aria-hidden />}
          >
            Download SVG
          </Button>
        </>
      }
    >
      {/* Only this block survives the print stylesheet — see globals.css. */}
      <div className="admin-print-area flex flex-col items-center gap-4">
        <div className="flex size-64 items-center justify-center rounded-xl border border-line bg-surface p-3">
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

        <div className="text-center">
          <p className="font-mono text-lg font-semibold tracking-[0.14em] text-ink">
            {target?.code}
          </p>
          <p className="mt-1 text-xs text-ink-subtle">
            Scanning opens this table&apos;s shared cart. Regenerating invalidates this printout.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* =====================================================================
   Tab 3 — Menu catalog
   ===================================================================== */

function MenuTab({
  menu,
  onChanged,
  onError,
}: {
  menu: AdminMenuItem[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminMenuItem | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AdminMenuItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-title font-semibold text-ink">Menu catalog</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Archived dishes leave the diner menu but keep their history.
          </p>
        </div>
        <Button
          variant="ember"
          size="md"
          onClick={() => setAddOpen(true)}
          leftIcon={<Plus className="size-4" aria-hidden />}
        >
          Add new dish
        </Button>
      </div>

      {menu.length === 0 ? (
        <EmptyState
          title="The catalog is empty"
          description="Add the first dish and it appears on every active table's menu."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {menu.map((item) => (
            <li key={item.menu_item_id}>
              <article className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface p-4">
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
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
                    {item.description || "No description yet."}
                  </p>
                  <p className="mt-1.5 text-xs text-ink-subtle">
                    {item.category} · {money(item.price)}
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
          ))}
        </ul>
      )}

      <DishModal
        open={addOpen}
        item={null}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          setAddOpen(false);
          onChanged();
        }}
      />

      <DishModal
        open={editTarget !== null}
        item={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          onChanged();
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

function DishModal({
  open,
  item,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: AdminMenuItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  const [category, setCategory] = useState("Main Course");
  const [description, setDescription] = useState("");
  const [vegetarian, setVegetarian] = useState(true);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  /* Fill the form when it opens (edit) or open it empty (create). Deferred a
     frame so the effect body never writes state synchronously, which would
     cascade a second render before the modal has even painted. */
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setName(item?.name ?? "");
      setPrice(String(item?.price ?? 0));
      setCategory(item?.category ?? "Main Course");
      setDescription(item?.description ?? "");
      setVegetarian(item?.vegetarian ?? true);
      setAvailable(item?.is_available ?? true);
      setError(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, item]);

  async function submit(event: FormEvent) {
    event.preventDefault();

    const amount = Number(price);
    if (!name.trim()) {
      setError("Give the dish a name.");
      return;
    }
    if (!category.trim()) {
      setError("Pick a category.");
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
        category: category.trim(),
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
          <Input
            label="Category"
            value={category}
            onChange={(event) => {
              setError(undefined);
              setCategory(event.target.value);
            }}
            maxLength={80}
          />
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

        {error ? (
          <p role="alert" className="text-sm font-medium text-alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
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
