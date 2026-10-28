"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  BellRing,
  Check,
  ChefHat,
  CircleCheck,
  Clock,
  Flame,
  ListPlus,
  RotateCcw,
  ShieldX,
  ShoppingBasket,
  Timer,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ActiveDinersBadge } from "@/components/diner/active-diners-badge";
import { InactiveTableState } from "@/components/diner/inactive-table-state";
import { SessionEndedState } from "@/components/diner/session-ended-state";
import { LogoMark } from "@/components/brand/logo";
import { Button, buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/loading-state";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { usePresence } from "@/hooks/use-presence";
import { useLiveTable, type LiveTableValue } from "@/hooks/use-live-table";
import { clearStoredSession } from "@/lib/api/table-session";
import type { Order, OrderStatus } from "@/lib/api/types";
import { ACTIVITY_LINES, estimateArrival } from "@/lib/diner/tracker";
import { formatElapsed, formatIstTime } from "@/lib/format";
import { transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

/* The tracker answers one question — where is my food — so the emblem is the
   page's single dominant object and nothing repeats its name in words. The
   journey names the stage, the activity line supplies the colour copy, and
   the estimate and ticket follow. The status label survives only as the
   screen-reader heading. */

interface StatusMeta {
  label: string;
  Icon: LucideIcon;
  emblem: string;
  halo: string;
}

const statusMeta: Record<OrderStatus, StatusMeta> = {
  pending: {
    label: "Pending",
    Icon: Clock,
    emblem: "border-line-strong bg-surface text-pending",
    halo: "border-transparent",
  },
  preparing: {
    label: "Preparing",
    Icon: ChefHat,
    emblem: "border-preparing/40 bg-preparing-surface text-preparing",
    halo: "animate-pulse-soft border-preparing/30",
  },
  ready: {
    label: "Ready",
    Icon: BellRing,
    emblem: "border-ready/45 bg-ready-surface text-ready",
    halo: "border-ready/30",
  },
  served: {
    label: "Served",
    Icon: CircleCheck,
    emblem: "border-ready/45 bg-ready-surface text-ready",
    halo: "border-ready/30",
  },
  denied: {
    label: "Not available",
    Icon: ShieldX,
    emblem: "border-alert/45 bg-alert-surface text-alert",
    halo: "border-transparent",
  },
};

const steps: { status: OrderStatus; label: string }[] = [
  { status: "pending", label: "Pending" },
  { status: "preparing", label: "Preparing" },
  { status: "ready", label: "Ready" },
];

const stepIndex: Record<OrderStatus, number> = {
  pending: 0,
  preparing: 1,
  ready: 2,
  served: 3,
  // Never rendered: a denied round has its own screen, not the journey.
  denied: -1,
};

export interface LiveTrackerProps {
  tableToken: string;
}

export function LiveTracker({ tableToken }: LiveTrackerProps) {
  const live = useLiveTable(tableToken);
  const { table, cart, orders, totals } = live;
  const now = useNow(1000);

  usePresence(tableToken);

  const order = useMemo(
    () =>
      [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)).at(0) ?? null,
    [orders],
  );

  const estimate = useMemo(() => estimateArrival(orders), [orders]);

  const [flashing, setFlashing] = useState(false);
  const previousStatus = useRef<OrderStatus | null>(null);

  useEffect(() => {
    const next = order?.status ?? null;
    const previous = previousStatus.current;
    previousStatus.current = next;

    if (next !== "ready" || previous === next) return;

    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), 4400);
    return () => window.clearTimeout(timer);
  }, [order?.status]);

  // ---- State matrix: loading (stable skeleton, no layout jump) ----------
  if (live.phase === "loading") return <TrackerSkeleton />;

  // ---- State matrix: error (specific API message + Retry Connection) -----
  if (live.phase === "error") {
    // Settled mid-view: the tracker's whole subject is gone, so drop the dead
    // credentials and show the end state rather than a retry that cannot work.
    if (live.error?.error === "SESSION_ENDED") {
      clearStoredSession(tableToken);
      return <SessionEndedState />;
    }

    return (
      <main id="main" className="min-h-dvh">
        <Container size="narrow" className="py-16">
          <ErrorState
            titleAs="h1"
            title="The tracker lost its connection"
            description={live.error?.message ?? "Please try again in a moment."}
            action={
              <Button size="md" onClick={live.retry}>
                Retry Connection
              </Button>
            }
          />
        </Container>
      </main>
    );
  }

  if (!table) return <InactiveTableState />;

  const header = (
    <div className="sticky top-0 z-30 border-b border-line bg-canvas/88 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <Container className="flex flex-wrap items-center justify-between gap-3 py-3.5">
        <div className="flex items-center gap-3">
          <LogoMark className="size-8" />
          <span className="text-label text-ink-subtle uppercase">Your table</span>
        </div>

        <div className="flex items-center gap-3">
          <ActiveDinersBadge tableToken={table.code} />
          {/* Minimal icon rather than a labelled button: the guest is one tap
              from the menu, and the screen stays quiet. */}
          <Link
            href={`/table/${table.code}`}
            aria-label="Back to the menu"
            title="Back to the menu"
            className="inline-flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-gentle hover:bg-sand hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </div>
      </Container>
    </div>
  );

  // ---- State matrix: empty (nothing fired yet) --------------------------
  if (!order) {
    return (
      <main id="main" className="min-h-dvh">
        {header}
        <Container size="narrow" className="py-16">
          <EmptyState
            icon={Flame}
            titleAs="h1"
            title={cart.length > 0 ? "Nothing has been fired yet" : "No order is being tracked"}
            description={
              cart.length > 0
                ? `${totals.itemCount} ${
                    totals.itemCount === 1 ? "item is" : "items are"
                  } staged in the shared cart. One tap on review & fire sends them to the kitchen as a single ticket.`
                : "Add dishes to the shared cart and fire them — the live status appears here the moment the kitchen picks the ticket up."
            }
            action={
              <Link href={`/table/${table.code}`} className={buttonStyles({ size: "md" })}>
                Back to the menu
              </Link>
            }
          />
        </Container>
      </main>
    );
  }

  /* ---- State matrix: denied (the kitchen refused this round) ---------
     A refused round is not an error page and not a dead end: the diner is
     told exactly why, sees which dishes are gone, and chooses one of the
     three documented ways forward. Every one of them calls the API, so two
     phones at the table cannot disagree about what happened. */
  if (order.status === "denied") {
    return (
      <main id="main" className="relative isolate min-h-dvh bg-canvas">
        {header}
        <Container size="narrow" className="py-12 sm:py-16">
          <DeniedOrderPanel live={live} order={order} />
        </Container>
      </main>
    );
  }

  const meta = statusMeta[order.status];

  return (
    <main id="main" className="relative isolate min-h-dvh bg-canvas">
      {flashing ? (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50 animate-flash-ready" />
      ) : null}

      {header}

      <Container
        size="narrow"
        className="flex flex-col items-center gap-10 py-12 sm:gap-12 sm:py-16"
      >
        {/* ---- Status hero: the emblem says it, nothing repeats it ------- */}
        <div className="flex flex-col items-center gap-6 text-center" aria-live="polite">
          <span className="text-label text-ink-subtle uppercase">Live order</span>

          <StatusEmblem status={order.status} />

          {/* The status word and its sentence were removed on purpose — the
              emblem colour, the journey and the activity line carry the
              meaning. The heading stays for assistive tech only. */}
          <h1 className="sr-only">Order status: {meta.label}</h1>

          <ActivityLine status={order.status} />
        </div>

        {/* ---- Journey: where the order is in the pipeline -------------- */}
        <ProgressJourney status={order.status} />

        <ArrivalEstimateModule status={order.status} estimate={estimate} />

        <OrderTicket order={order} now={now} />

        {cart.length > 0 && order.status !== "served" ? (
          <p className="flex items-center gap-2 text-xs text-ink-subtle">
            <ShoppingBasket className="size-3.5 shrink-0" aria-hidden />
            {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"} staged for next round.
          </p>
        ) : null}

        {/* A finished round is the only case that still needs a real button:
            ordering again is the point. Everything else is one icon away. */}
        {order.status === "served" ? (
          <Link
            href={`/table/${table.code}`}
            className={buttonStyles({ variant: "ember", size: "lg" })}
          >
            Start a new round
          </Link>
        ) : null}
      </Container>
    </main>
  );
}

/* The single largest object on the page: the icon IS the status. A soft halo
   — pulsing only while the food is actually being cooked — is the one piece
   of motion allowed up here. */
function StatusEmblem({ status }: { status: OrderStatus }) {
  const meta = statusMeta[status];
  const reduceMotion = useReducedMotion();
  const Icon = meta.Icon;

  return (
    <div
      className={cn(
        "relative flex size-28 items-center justify-center rounded-pill border sm:size-32",
        meta.emblem,
      )}
    >
      <span
        aria-hidden
        className={cn("absolute -inset-2.5 rounded-pill border", meta.halo)}
      />

      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.86, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
          transition={transitionBase}
          className="flex items-center justify-center"
        >
          <Icon className="size-11 sm:size-12" aria-hidden />
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

/* A horizontal journey. Finished stages carry a small check, the live stage
   is filled and carries a ring, and everything ahead stays quiet. */
function ProgressJourney({ status }: { status: OrderStatus }) {
  const current = stepIndex[status];
  const complete = status === "served";

  return (
    <ol className="flex w-full max-w-xl items-start" aria-label="Order progress">
      {steps.map((step, index) => {
        const done = complete || index < current;
        const active = !complete && index === current;
        const reached = done || active;
        /* The connector after this stage is live once the NEXT stage is
           reached, so the line fills in step with the order. */
        const segmentReached = complete || index + 1 <= current;

        return (
          <li
            key={step.status}
            className={cn("flex items-start", index < steps.length - 1 && "flex-1")}
          >
            {/* Elastic stages: each one may grow to 90px but no wider, so
                three of them plus their connectors still fit a 320px screen
                without the last label clipping off the edge. */}
            <span className="flex w-full max-w-[90px] flex-1 flex-col items-center gap-2.5">
              <span
                aria-hidden
                className={cn(
                  "flex size-8 items-center justify-center rounded-pill border transition-all duration-[var(--duration-base)] ease-organic",
                  done && "border-ember/35 bg-ember-soft text-ember",
                  active && "scale-110 border-ember bg-ember text-on-ember ring-4 ring-ember/10",
                  !reached && "border-line-strong bg-surface text-ink-subtle",
                )}
              >
                {done ? (
                  <Check className="size-4" />
                ) : (
                  <span
                    className={cn(
                      "rounded-pill",
                      active ? "size-2 bg-on-ember" : "size-1.5 bg-current",
                    )}
                  />
                )}
              </span>
              <span
                className={cn(
                  "text-label uppercase",
                  active ? "text-ember" : reached ? "text-ink" : "text-ink-subtle",
                )}
              >
                {step.label}
              </span>
            </span>

            {index < steps.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "mx-1.5 mt-4 h-px flex-1 transition-colors duration-[var(--duration-slow)] ease-gentle",
                  segmentReached ? "bg-ember/45" : "bg-line-strong",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* Small, deliberately not a card: one line of intelligence under the
   journey. The number is a demo-only estimate built from the open tickets. */
function ArrivalEstimateModule({
  status,
  estimate,
}: {
  status: OrderStatus;
  estimate: ReturnType<typeof estimateArrival>;
}) {
  const arriving = status === "ready" || status === "served";

  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3.5 gap-y-1 rounded-pill border border-line bg-surface/70 px-4 py-2 sm:px-5">
      <span className="flex items-center gap-2 text-label text-ink-subtle uppercase">
        <Timer className="size-3.5" aria-hidden />
        {arriving ? "Arriving now" : "Estimated arrival"}
      </span>

      {arriving ? null : (
        <span className="font-display text-xl leading-none font-semibold text-ink tabular-nums">
          ~ {estimate.minutes} min
        </span>
      )}

      <span className="text-xs text-ink-subtle">
        {arriving ? "Waiting for a runner." : "Est. arrival"}
      </span>
    </div>
  );
}

/* The order as one cohesive object: a receipt. Dashed rule, tabular counts,
   generous line spacing, and the table's own notes kept where the guest
   wrote them. */
function OrderTicket({ order, now }: { order: Order; now: number | null }) {
  const lineCount = order.items.length;

  return (
    <section
      aria-label="Order ticket"
      className="w-full overflow-hidden rounded-lg border border-line bg-surface shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-dashed border-line-strong px-6 py-4">
        <span className="text-label text-ink-subtle uppercase">Order ticket</span>
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <Clock className="size-3.5" aria-hidden />
          {lineCount} {lineCount === 1 ? "line" : "lines"}
          <span aria-hidden className="text-ink-subtle">
            ·
          </span>
          {now === null ? "Fired just now" : `Fired ${formatElapsed(order.created_at, now)} ago`}
          <span aria-hidden className="text-ink-subtle">
            ·
          </span>
          {formatIstTime(order.created_at)}
        </span>
      </div>

      <ul className="flex flex-col px-6">
        {order.items.map((item, index) => (
          <li
            key={item.id}
            className={cn("flex flex-col gap-1.5 py-4", index > 0 && "border-t border-line/70")}
          >
            <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-base font-medium text-ink">
              <span className="font-display text-lg font-semibold text-ink tabular-nums">
                {item.quantity}×
              </span>
              {item.name}
              {item.added_by && item.added_by !== "Guest" ? (
                <span className="text-xs font-normal text-ink-subtle">
                  · added by {item.added_by}
                </span>
              ) : null}
            </p>

            {item.request_note ? (
              <p className="text-sm leading-relaxed text-ink-muted">Note: {item.request_note}</p>
            ) : null}

            {item.allergy_note ? (
              <p className="mt-0.5 flex items-center gap-2 text-xs font-bold tracking-wide text-alert uppercase">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                Allergy · {item.allergy_note}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* One quiet line of live colour under the status. The copy rotates inside the
   pool for the REAL status, so it can never contradict the kitchen. */
function ActivityLine({ status }: { status: OrderStatus }) {
  const lines = ACTIVITY_LINES[status];
  const [index, setIndex] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % lines.length),
      7000,
    );
    return () => window.clearInterval(timer);
  }, [lines.length]);

  return (
    <span className="flex items-center justify-center gap-2 text-sm text-ink-subtle">
      <span aria-hidden className="size-1.5 shrink-0 animate-pulse-soft rounded-pill bg-ember/70" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={`${status}-${index}`}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={transitionBase}
        >
          {lines[index % lines.length]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* The refused-round screen.

   Three outcomes, and they are genuinely different things:

     Retry         preview the re-fire, then send the still-available lines
     Move to list  put those lines back in the cart and go edit them there
     Cancel        discard the refused round entirely

   The preview exists because Retry is destructive in a subtle way: a dish
   that is still 86'd cannot come back, so the diner must SEE that it is
   being left out before confirming, not discover it on the next ticket. */
function DeniedOrderPanel({ live, order }: { live: LiveTableValue; order: Order }) {
  const router = useRouter();
  const { toast } = useToast();
  const plan = live.deniedRetryPlan;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState<"retry" | "move" | "cancel" | null>(null);

  const reason =
    order.denial_reason?.trim() ||
    plan?.reason ||
    "The kitchen could not prepare this round.";
  const keep = plan?.keep ?? [];
  const omitted = plan?.omitted ?? [];
  const itemCount = keep.reduce((total, line) => total + line.quantity, 0);

  async function handleRetry() {
    if (busy) return;
    setBusy("retry");

    const result = await live.retryDenied();
    setBusy(null);

    if (!result.ok) {
      toast({
        title: result.message ?? "The round could not be re-fired.",
        tone: "error",
      });
      return;
    }

    setPreviewOpen(false);
    toast({
      title: "Round re-fired",
      description: result.omitted?.length
        ? `${result.omitted.join(", ")} left out — still out of stock.`
        : "The kitchen has the new ticket.",
      tone: "success",
    });
  }

  async function handleMoveToCart() {
    if (busy) return;
    setBusy("move");

    const result = await live.moveDeniedToCart();
    setBusy(null);

    if (!result.ok) {
      toast({
        title: result.message ?? "Those items could not be moved back.",
        tone: "error",
      });
      return;
    }

    toast({
      title: "Back in the cart",
      description: result.omitted?.length
        ? `${result.omitted.join(", ")} stayed out — out of stock. Edit and fire when ready.`
        : "Edit the lines and fire when ready.",
      tone: "success",
    });
    router.push(`/table/${order.table_code}`);
  }

  async function handleCancel() {
    if (busy) return;
    setBusy("cancel");

    const result = await live.dismissDenied();
    setBusy(null);

    if (!result.ok) {
      toast({ title: result.message ?? "That order could not be cancelled.", tone: "error" });
      return;
    }

    toast({ title: "Order cancelled", description: "Nothing was charged." });
  }

  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <span className="flex size-24 items-center justify-center rounded-pill border border-alert/40 bg-alert-surface text-alert sm:size-28">
        <ShieldX className="size-10 sm:size-11" aria-hidden />
      </span>

      <div className="flex flex-col gap-3">
        <span className="text-label text-ink-subtle uppercase">Live order</span>
        <h1 className="font-display text-title font-semibold text-ink">
          This round was not cooked
        </h1>
        <p className="max-w-md text-lead text-ink-muted">
          The kitchen could not take it. Nothing on it has been charged.
        </p>
      </div>

      <div
        role="status"
        className="w-full rounded-lg border-2 border-alert/35 bg-alert-surface px-5 py-4 text-left"
      >
        <span className="text-label text-alert uppercase">Kitchen said</span>
        <p className="mt-1.5 text-base leading-relaxed font-medium text-ink">{reason}</p>
      </div>

      {omitted.length > 0 ? (
        <section
          aria-label="Out of stock items"
          className="w-full rounded-lg border border-line bg-surface p-5 text-left"
        >
          <span className="text-label text-ink-subtle uppercase">Out of stock</span>
          <ul className="mt-2 flex flex-col gap-1.5">
            {omitted.map((line) => (
              <li key={line.name} className="flex items-baseline gap-2 text-sm text-ink-muted">
                <span className="font-display font-semibold text-ink-subtle tabular-nums">
                  {line.quantity}×
                </span>
                <span className="line-through decoration-ink-subtle/60">{line.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex w-full max-w-sm flex-col gap-3">
        <Button
          variant="ember"
          size="lg"
          fullWidth
          disabled={busy !== null || keep.length === 0}
          loading={busy === "retry"}
          onClick={() => setPreviewOpen(true)}
          leftIcon={<RotateCcw className="size-4" aria-hidden />}
        >
          Retry order
        </Button>

        <Button
          variant="soft"
          size="lg"
          fullWidth
          disabled={busy !== null}
          loading={busy === "move"}
          onClick={() => void handleMoveToCart()}
          leftIcon={<ListPlus className="size-4" aria-hidden />}
        >
          Move to list
        </Button>

        <Button
          variant="ghost"
          size="lg"
          fullWidth
          disabled={busy !== null}
          loading={busy === "cancel"}
          onClick={() => void handleCancel()}
          leftIcon={<X className="size-4" aria-hidden />}
        >
          Cancel
        </Button>

        {keep.length === 0 ? (
          <p className="text-xs leading-snug text-ink-subtle">
            Every dish on this round is out of stock right now — cancel it or pick something else
            from the menu.
          </p>
        ) : null}
      </div>

      {/* ---- Retry preview: what will be re-fired, what will be left out ---- */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        size="sm"
        title="Re-fire this round?"
        description="Check what goes back to the kitchen before you confirm."
        footer={
          <>
            <Button
              variant="ember"
              size="md"
              disabled={busy !== null || itemCount === 0}
              loading={busy === "retry"}
              onClick={() => void handleRetry()}
              leftIcon={<Flame className="size-4" aria-hidden />}
            >
              Re-fire {itemCount} {itemCount === 1 ? "item" : "items"}
            </Button>
            <Button variant="ghost" size="md" onClick={() => setPreviewOpen(false)}>
              Back
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5 text-left">
          <section className="flex flex-col">
            <span className="text-label text-ink-subtle uppercase">Going back in</span>
            <ul className="mt-2 flex flex-col divide-y divide-line/70">
              {keep.map((line) => (
                <li key={line.name} className="flex items-baseline justify-between gap-3 py-2.5">
                  <span className="flex items-baseline gap-2 text-sm text-ink">
                    <span className="font-display font-semibold tabular-nums">{line.quantity}×</span>
                    {line.name}
                  </span>
                  <Check className="size-4 shrink-0 text-ready" aria-hidden />
                </li>
              ))}
            </ul>
          </section>

          {omitted.length > 0 ? (
            <section className="flex flex-col rounded-md border border-alert/30 bg-alert-surface p-3">
              <span className="text-label text-alert uppercase">Left out — out of stock</span>
              <ul className="mt-2 flex flex-col gap-1.5">
                {omitted.map((line) => (
                  <li
                    key={line.name}
                    className="flex items-baseline gap-2 text-sm text-ink-muted line-through decoration-alert/50"
                  >
                    <span className="font-display font-semibold tabular-nums">{line.quantity}×</span>
                    {line.name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

/* Loading state: mirrors the emblem + journey + ticket structure so the
   layout shift stays stable until the first snapshot streams in. */
function TrackerSkeleton() {
  return (
    <main id="main" className="min-h-dvh bg-canvas">
      <Container size="narrow" className="flex flex-col items-center gap-10 py-16">
        <Skeleton className="h-5 w-24 rounded-pill" />
        <Skeleton className="size-28 rounded-pill sm:size-32" />
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />

        <div className="flex w-full max-w-xl items-start" aria-hidden>
          {[0, 1, 2].map((index) => (
            <Fragment key={index}>
              {index > 0 ? <Skeleton className="mx-2 mt-4 h-px flex-1" /> : null}
              <Skeleton className="size-8 shrink-0 rounded-pill" />
            </Fragment>
          ))}
        </div>

        <Skeleton className="h-9 w-64 rounded-pill" />

        <div className="w-full rounded-lg border border-line bg-surface p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-5 h-4 w-full" />
          <Skeleton className="mt-3 h-4 w-3/4" />
        </div>
      </Container>
    </main>
  );
}
