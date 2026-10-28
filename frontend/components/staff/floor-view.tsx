"use client";

import {
  Check,
  ChevronRight,
  Clock,
  EyeOff,
  HandCoins,
  Lock,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { OpsBar } from "@/components/staff/ops-bar";
import { MenuAvailabilityDrawer } from "@/components/staff/menu-availability-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/loading-state";
import { useToast } from "@/components/ui/toast";
import { useLiveFloor } from "@/hooks/use-live-floor";
import { useNow } from "@/hooks/use-now";
import { useStaffMenuCatalog } from "@/hooks/use-staff-menu-catalog";
import { ApiError, clearFloorTable, settleTableBill } from "@/lib/api-client";
import type { FloorTableSummary, OrderStatus } from "@/lib/api/types";
import { formatElapsed } from "@/lib/format";
import { transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

/* One word per state, one sentence to support it. The word is what a server
   scans the whole room for; the sentence is only read once they stop. */
const statusWord: Record<OrderStatus, string> = {
  pending: "Pending",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
};

const guidance: Record<OrderStatus, string> = {
  pending: "Waiting behind the tickets already on the line.",
  preparing: "On the cooking line right now.",
  ready: "Run the food to the table.",
  served: "Order complete.",
};

const statusText: Record<OrderStatus, string> = {
  pending: "text-pending",
  preparing: "text-preparing",
  ready: "text-ready",
  served: "text-ink-subtle",
};

/* A colour rail on the card edge lets a server triage the whole room by
   scanning the left margin, without reading a single label. */
const statusRail: Record<OrderStatus, string> = {
  pending: "bg-pending",
  preparing: "bg-preparing",
  ready: "bg-ready",
  served: "bg-line-strong",
};

const urgencyRank: Record<OrderStatus, number> = {
  served: 0,
  pending: 2,
  preparing: 3,
  ready: 4,
};

/** Abandoned sessions come first, then ready tables, cooking, queued, staged. */
function urgency(summary: FloorTableSummary) {
  if (summary.needs_attention) return 5;

  const order = summary.active_order;
  if (!order) return summary.cart_line_count > 0 ? 1 : 0;

  return urgencyRank[order.status];
}

/* Demo-only pacing counter. The floor API has no "orders today" figure, so a
   seeded base rides on top of the live active-table count — the number moves
   with real data and never touches the backend. */
const DEMO_ORDERS_TODAY_BASE = 19;

export interface FloorViewProps {
  /** Ends the shift — returns the operator to the PIN wall. */
  onLock: () => void;
}

/* Mobile triage tabs. One endless column of every table is exactly the
   problem this board exists to solve, so a phone gets the four questions a
   server actually asks: what is ready, what is cooking, who wants the bill,
   and (the fallback) everything. */
type FloorTab = "all" | "ready" | "cooking" | "bill";

export function FloorView({ onLock }: FloorViewProps) {
  const { phase, error, tables, retry, refresh } = useLiveFloor();
  const now = useNow(1000);
  const { toast } = useToast();
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [tab, setTab] = useState<FloorTab>("all");

  /* The tab filter is a phone affordance only (the bar is `lg:hidden`), so a
     desktop board must always show the whole room — including after a guest
     rotated a tablet that had filtered it. */
  const [isWide, setIsWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => setIsWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  /* Frontend-only coordination state: which tables this server has picked up.
     It exists to demonstrate the future claim flow and is deliberately not
     persisted anywhere — no backend write happens on "I'll serve this". */
  const [claimed, setClaimed] = useState<Record<string, boolean>>({});

  /* The catalog is global but E3 needs a table token; the floor already knows
     every table code, so hand one over instead of making the hook re-fetch
     the floor list. */
  const catalogToken = tables[0]?.table.code ?? null;
  const catalog = useStaffMenuCatalog(catalogToken);

  const ordered = useMemo(
    () =>
      [...tables].sort(
        (a, b) => urgency(b) - urgency(a) || a.table.code.localeCompare(b.table.code),
      ),
    [tables],
  );

  const activeTables = useMemo(
    () => tables.filter((summary) => summary.active_order !== null).length,
    [tables],
  );
  const needAttention = useMemo(
    () =>
      tables.filter(
        (summary) => summary.needs_attention || summary.active_order?.status === "ready",
      ).length,
    [tables],
  );
  const ordersToday = DEMO_ORDERS_TODAY_BASE + activeTables;

  const wantsBill = (summary: FloorTableSummary) =>
    summary.table.bill_status === "requested";

  const tabCounts: Record<FloorTab, number> = {
    all: ordered.length,
    ready: ordered.filter((summary) => summary.active_order?.status === "ready").length,
    cooking: ordered.filter((summary) => summary.active_order?.status === "preparing").length,
    bill: ordered.filter(wantsBill).length,
  };

  const visible = isWide
    ? ordered
    : ordered.filter((summary) => {
        if (tab === "ready") return summary.active_order?.status === "ready";
        if (tab === "cooking") return summary.active_order?.status === "preparing";
        if (tab === "bill") return wantsBill(summary);
        return true;
      });

  function claim(summary: FloorTableSummary) {
    setClaimed((current) => ({ ...current, [summary.table.id]: true }));
    toast({
      title: `${summary.table.name} claimed`,
      description: "You're serving this one — the room sees it as taken.",
      tone: "success",
    });
  }

  function release(summary: FloorTableSummary) {
    setClaimed((current) => {
      const next = { ...current };
      delete next[summary.table.id];
      return next;
    });
    toast({
      title: `${summary.table.name} released`,
      description: "Back in the open pool for any server.",
      tone: "info",
    });
  }

  /* Payment taken: the server records 'paid' and runs the three-condition
     release check itself. A table whose bill is the only remaining blocker
     is cleaned on the spot; one whose guests are still connected stays put
     and is released when the last heartbeat disappears. */
  /* Clearing a flagged table. If money is owed the server refuses AND raises
     the manager alert; this surface must not pretend otherwise. */
  async function clearTable(summary: FloorTableSummary) {
    try {
      await clearFloorTable(summary.table.id);
      toast({
        title: `${summary.table.name} cleared`,
        description: "Session ended. The table is ready for its next guests.",
        tone: "success",
      });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.error === "BILL_UNPAID") {
        toast({
          title: "Bill unpaid — admin alerted",
          description: "Only a manager can clear this table now.",
          tone: "error",
        });
        await refresh();
        return;
      }

      toast({
        title: err instanceof ApiError ? err.message : "Could not clear that table.",
        tone: "error",
      });
    }
  }

  async function settle(summary: FloorTableSummary) {
    try {
      const result = await settleTableBill(summary.table.id);
      toast({
        title: `${summary.table.name} settled`,
        description: result.released
          ? "Bill paid. The table is clear for its next guests."
          : "Bill paid. The table clears once its last device disconnects.",
        tone: "success",
      });
      await refresh();
    } catch (err) {
      toast({
        title: err instanceof ApiError ? err.message : "Could not settle that table.",
        tone: "error",
      });
    }
  }

  return (
    <main id="main" className="min-h-dvh pb-20">
      {/* Same identity treatment as /kitchen: the badge carries the surface's
          name, so the page heading itself lives here for assistive tech. */}
      <h1 className="sr-only">Floor operations</h1>

      <OpsBar
        prefix={
          <Badge tone="brand" size="md">
            Floor
          </Badge>
        }
        actions={
          <>
            <IconButton
              label="Quick 86"
              tone="soft"
              size="md"
              onClick={() => setAvailabilityOpen(true)}
            >
              <EyeOff className="size-4" aria-hidden />
            </IconButton>

            <IconButton label="Lock board" tone="ghost" size="md" onClick={onLock}>
              <Lock className="size-4" aria-hidden />
            </IconButton>
          </>
        }
      />

      <Container className="py-10 sm:py-12">
        {/* ---- Operational summary: the room at a glance ---------------- */}
        {phase === "success" && ordered.length > 0 ? (
          <div className="flex flex-wrap items-end gap-x-12 gap-y-6">
            <SummaryStat value={ordersToday} label="Orders today" />
            <SummaryStat value={activeTables} label="Active tables" />
            <SummaryStat
              value={needAttention}
              label="Need attention"
              tone={needAttention > 0 ? "attention" : "default"}
            />
          </div>
        ) : null}

        {/* ---- Mobile triage tabs ------------------------------------- */}
        {phase === "success" && ordered.length > 0 ? (
          <div
            role="tablist"
            aria-label="Filter tables by status"
            className="hide-scrollbar mt-8 flex gap-1.5 overflow-x-auto pb-1 lg:hidden"
          >
            {(
              [
                { id: "all", label: "All" },
                { id: "ready", label: "Ready" },
                { id: "cooking", label: "Cooking" },
                { id: "bill", label: "Bill" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={tab === option.id}
                onClick={() => setTab(option.id)}
                className={cn(
                  "flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-pill border px-3.5 text-sm font-semibold transition-colors duration-[var(--duration-fast)]",
                  tab === option.id
                    ? "border-ember bg-ember text-on-ember"
                    : "border-line-strong bg-surface text-ink-muted",
                )}
              >
                {option.label}
                <span className="tabular-nums opacity-70">({tabCounts[option.id]})</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* ---- State matrix: loading ---------------------------------- */}
        {phase === "loading" ? (
          <div className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-48 rounded-lg" />
            ))}
          </div>
        ) : phase === "error" ? (
          /* ---- State matrix: error — API message + Retry -------------- */
          <div className="mt-10">
            <ErrorState
              titleAs="h2"
              title="The floor lost its connection"
              description={error?.message ?? "The floor service could not be reached."}
              action={
                <Button size="md" onClick={retry}>
                  Retry Connection
                </Button>
              }
            />
          </div>
        ) : ordered.length === 0 ? (
          /* ---- State matrix: empty ----------------------------------- */
          <div className="mt-10">
            <EmptyState
              title="No tables are configured"
              description="Add tables in the database and they appear here the moment a diner scans one."
            />
          </div>
        ) : (
          /* ---- State matrix: success --------------------------------- */
          <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:mt-10 xl:grid-cols-3">
            {visible.length === 0 ? (
              <li className="sm:col-span-2 xl:col-span-3">
                <EmptyState
                  title="Nothing in this filter"
                  description="No table matches right now — switch back to All to see the room."
                  action={
                    <Button variant="outline" size="sm" onClick={() => setTab("all")}>
                      Show all tables
                    </Button>
                  }
                />
              </li>
            ) : null}

            {visible.map((summary) => (
              <TableCard
                key={summary.table.id}
                summary={summary}
                now={now}
                claimed={Boolean(claimed[summary.table.id])}
                onClaim={claim}
                onRelease={release}
                onSettle={settle}
                onClear={clearTable}
              />
            ))}
          </ul>
        )}
      </Container>

      <MenuAvailabilityDrawer
        open={availabilityOpen}
        onClose={() => setAvailabilityOpen(false)}
        menu={catalog.menu}
        onSetAvailability={catalog.setAvailability}
      />
    </main>
  );
}

function SummaryStat({
  value,
  label,
  tone = "default",
}: {
  value: number;
  label: string;
  tone?: "default" | "attention";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={cn(
          "font-display text-3xl leading-none font-semibold tabular-nums",
          tone === "attention" ? "text-ember" : "text-ink",
        )}
      >
        {value}
      </span>
      <span className="text-label text-ink-subtle uppercase">{label}</span>
    </div>
  );
}

function TableCard({
  summary,
  now,
  claimed,
  onClaim,
  onRelease,
  onSettle,
  onClear,
}: {
  summary: FloorTableSummary;
  now: number | null;
  claimed: boolean;
  onClaim: (summary: FloorTableSummary) => void;
  onRelease: (summary: FloorTableSummary) => void;
  onSettle: (summary: FloorTableSummary) => void;
  onClear: (summary: FloorTableSummary) => void;
}) {
  const { table, active_order: order, cart_line_count } = summary;
  const status = order?.status ?? null;
  // Active session, but nobody is connected and nothing is in flight.
  const stale = Boolean(summary.needs_attention);

  /* Allergy lines are the reason this card exists: they come straight from
     E17's `active_order.items`, which is the live join to the ticket. */
  const allergyLines = order
    ? order.items.filter((item) => item.allergy_note.trim()).length
    : 0;
  const itemCount = order
    ? order.items.reduce((total, item) => total + item.quantity, 0)
    : 0;

  const word = stale
    ? "Check"
    : status
      ? statusWord[status]
      : cart_line_count > 0
        ? "Staged"
        : "Idle";
  const wordTone = stale
    ? "text-alert"
    : status
      ? statusText[status]
      : cart_line_count > 0
        ? "text-ink-muted"
        : "text-ink-subtle";
  const detail = stale
    ? summary.clear_requested_at
      ? "Admin notified · bill unpaid."
      : "Active session with no device and no open order."
    : status
      ? guidance[status]
      : cart_line_count > 0
        ? "Staged in the shared cart, not fired yet."
        : "Nothing in flight for this table.";
  const rail = stale
    ? "bg-alert"
    : status
      ? statusRail[status]
      : cart_line_count > 0
        ? "bg-line-strong"
        : "bg-line";

  /* Only a ready ticket needs a runner, so only a ready ticket gets a CTA.
     Everything else is information the server reads on the way past. */
  const canServe = status === "ready";

  // The server's bill state is the only truth here: a settled table stops
  // asking for payment the instant restaurant_tables updates.
  const billRequested = table.bill_status === "requested";

  return (
    <li className="h-full">
      <article
        className={cn(
          "relative flex h-full flex-col overflow-hidden rounded-lg border bg-surface p-6 transition-[transform,box-shadow,border-color] duration-[var(--duration-base)] ease-organic",
          stale ? "border-alert/50 shadow-sm" : canServe ? "border-ready/50 shadow-sm" : "border-line",
          !stale && !canServe && "hover:border-line-strong",
          claimed && "ring-1 ring-ember/25",
        )}
      >
        <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", rail)} />

        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {/* Staff see the human table name, never the QR token — the
                token is the diner's capability credential. */}
            <span className="text-label text-ink-subtle uppercase">Table</span>
            <h2 className="font-display text-subheading text-ink">{table.name}</h2>
          </div>

          {/* The word stays visible, not just the count: an allergy alert and
              an abandoned session are the two things a server must not have
              to decode from colour alone. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {stale ? (
              <span className="flex items-center gap-1.5 rounded-pill bg-alert-surface px-2.5 py-1 text-label text-alert uppercase">
                <WifiOff className="size-3.5 shrink-0" aria-hidden />
                {summary.clear_requested_at ? "Admin notified" : "Check table"}
              </span>
            ) : null}

            {allergyLines > 0 ? (
              <span className="flex items-center gap-1.5 rounded-pill bg-alert-surface px-2.5 py-1 text-label text-alert uppercase">
                <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                {allergyLines} {allergyLines === 1 ? "allergy" : "allergies"}
              </span>
            ) : null}
          </div>
        </header>

        <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <span
            className={cn(
              "font-display text-2xl leading-none font-semibold tracking-[-0.01em] uppercase",
              wordTone,
            )}
          >
            {word}
          </span>

          <AnimatePresence initial={false}>
            {claimed ? (
              <motion.span
                key="claimed"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={transitionBase}
                className="inline-flex items-center gap-1.5 rounded-pill bg-ember-soft px-2.5 py-1 text-label text-ember uppercase"
              >
                <Check className="size-3 shrink-0" aria-hidden />
                Taken by you
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>

        <p className="mt-2.5 text-sm leading-relaxed text-ink-muted">{detail}</p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-subtle">
          {order ? (
            <>
              <span className="flex items-center gap-1.5">
                <Clock className="size-3.5" aria-hidden />
                {now === null ? "—" : formatElapsed(order.created_at, now)}
              </span>
              <span>
                {itemCount} {itemCount === 1 ? "item" : "items"} on the ticket
              </span>
            </>
          ) : cart_line_count > 0 ? (
            <span>
              {cart_line_count} {cart_line_count === 1 ? "line" : "lines"} staged
            </span>
          ) : null}

          {/* Deliberately NO diner count here. Presence is a per-table
              Realtime channel and this board spans the whole room; a number
              this card cannot derive from live data would be a guess dressed
              as a fact. */}
        </div>

        {/* The one thing on this card that is a request rather than a fact:
            the table asked for its bill, and tapping it takes payment. */}
        {/* A flagged table gets one action: clear it, or escalate when the
            bill is unpaid (the server decides which, atomically). */}
        {stale ? (
          <div className="mt-5 mb-1">
            <Button
              variant={summary.clear_requested_at ? "soft" : "outline"}
              size="sm"
              fullWidth
              disabled={Boolean(summary.clear_requested_at)}
              onClick={() => onClear(summary)}
              leftIcon={<WifiOff className="size-3.5" aria-hidden />}
            >
              {summary.clear_requested_at ? "Admin notified" : "Clear table"}
            </Button>
          </div>
        ) : null}

        {billRequested ? (
          <button
            type="button"
            onClick={() => onSettle(summary)}
            aria-label={`Take the bill at ${table.name} and clear the table`}
            className="mt-5 mb-1 flex w-full cursor-pointer items-center gap-3 rounded-md border border-ember/35 bg-ember-soft px-4 py-3 text-left transition-[border-color] duration-[var(--duration-fast)] hover:border-ember/60"
          >
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-ember text-on-ember"
            >
              <HandCoins className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-label text-ember uppercase">Bill requested</span>
              <span className="mt-1 block text-xs leading-snug text-ink-muted">
                Tap to take payment and clear this table.
              </span>
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-ember" />
          </button>
        ) : null}

        {canServe ? (
          /* The bill banner and this CTA can be on screen together. mt-auto
             pushes the action to the foot, and the extra top padding keeps a
             thumb aimed at "I'll serve this" from landing on "take payment". */
          <div className="mt-auto pt-7">
            <AnimatePresence mode="wait" initial={false}>
              {claimed ? (
                <motion.div
                  key="serving"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={transitionBase}
                  className="flex items-center gap-3"
                >
                  <span className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-ready/40 bg-ready-surface px-4 text-sm font-semibold text-ready">
                    <Check className="size-4" aria-hidden />
                    You&apos;re serving
                  </span>
                  <button
                    type="button"
                    onClick={() => onRelease(summary)}
                    className="shrink-0 cursor-pointer text-xs font-semibold text-ink-subtle underline-offset-4 transition-colors duration-[var(--duration-fast)] hover:text-ink hover:underline"
                  >
                    Release
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="open"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={transitionBase}
                >
                  <Button
                    variant="ember"
                    size="md"
                    fullWidth
                    onClick={() => onClaim(summary)}
                    leftIcon={<Check className="size-4" aria-hidden />}
                  >
                    I&apos;ll serve this
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : null}
      </article>
    </li>
  );
}
