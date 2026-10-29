"use client";

import { AnimatePresence } from "motion/react";
import { BellRing, Check, ChefHat, EyeOff, Flame, Lock, RefreshCw, Sparkles, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { KdsCard } from "@/components/staff/kds-card";
import { KitchenVoice } from "@/components/staff/kitchen-voice";
import { MenuAvailabilityDrawer } from "@/components/staff/menu-availability-drawer";
import { OpsBar } from "@/components/staff/ops-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/loading-state";
import { useToast } from "@/components/ui/toast";
import { useLiveKds } from "@/hooks/use-live-kds";
import { useNow } from "@/hooks/use-now";
import { usePresence } from "@/hooks/use-presence";
import { useStaffMenuCatalog } from "@/hooks/use-staff-menu-catalog";
import { activateShift } from "@/lib/api-client";
import { getDeviceId } from "@/lib/api/session";
import type { Order, OrderStatus } from "@/lib/api/types";
import { armAudio, isAudioArmed, playChime } from "@/lib/sound";
import { cn } from "@/lib/utils";

/** The board's three lanes. Served and denied tickets are closed and never
    rendered here, so they are not part of this union. */
type ColumnStatus = "pending" | "preparing" | "ready";

/* Every class a lane needs is written out literally so Tailwind can see it
   at build time — a template-built `bg-${status}` would never be generated. */
interface Column {
  status: ColumnStatus;
  title: string;
  rail: string;
  count: string;
  Icon: typeof Flame;
  emptyTitle: string;
}

const columns: Column[] = [
  {
    status: "pending",
    title: "Pending",
    rail: "bg-pending",
    count: "text-pending",
    Icon: Flame,
    emptyTitle: "No tickets waiting",
  },
  {
    status: "preparing",
    title: "Preparing",
    rail: "bg-preparing",
    count: "text-preparing",
    Icon: ChefHat,
    emptyTitle: "Nothing is cooking",
  },
  {
    status: "ready",
    title: "Ready",
    rail: "bg-ready",
    count: "text-ready",
    Icon: BellRing,
    emptyTitle: "Nothing at the pass",
  },
];

export interface KdsBoardProps {
  onLock: () => void;
}

export function KdsBoard({ onLock }: KdsBoardProps) {
  const { phase, error, tickets, busy, retry, refresh, advance, deny } = useLiveKds();
  /* The 86 drawer needs the LIVE catalog. E3 requires a table token that the
     kitchen does not hold, so the hook resolves one from E17 — see
     useStaffMenuCatalog. Was previously read from the offline demo store,
     which meant real dishes could not be 86'd from the board. */
  const catalog = useStaffMenuCatalog();
  /* Frontend-only checklist ticks, keyed by ticket then by line. Purely
     presentational: ticking a line never writes a status, and the real
     one-tap advance below is untouched. */
  const [checked, setChecked] = useState<Record<string, string[]>>({});

  /* Manual refresh feedback. The board usually updates itself over Realtime,
     so a silent re-read was indistinguishable from a dead button. The arrow
     now turns slowly while the read is in flight, then a green tick holds for
     a second — the same confirmation the manager console uses. */
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const refreshDoneTimer = useRef<number | null>(null);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;

    if (refreshDoneTimer.current !== null) {
      window.clearTimeout(refreshDoneTimer.current);
      refreshDoneTimer.current = null;
    }
    setJustRefreshed(false);
    setRefreshing(true);
    try {
      await refresh();
      setJustRefreshed(true);
      refreshDoneTimer.current = window.setTimeout(() => {
        refreshDoneTimer.current = null;
        setJustRefreshed(false);
      }, 1_100);
    } finally {
      setRefreshing(false);
    }
  }, [refresh, refreshing]);

  useEffect(
    () => () => {
      if (refreshDoneTimer.current !== null) window.clearTimeout(refreshDoneTimer.current);
    },
    [],
  );

  const toggleItem = useCallback((orderId: string, itemId: string) => {
    setChecked((current) => {
      const set = new Set(current[orderId] ?? []);
      if (set.has(itemId)) set.delete(itemId);
      else set.add(itemId);
      return { ...current, [orderId]: [...set] };
    });
  }, []);

  const now = useNow(1000);
  const { toast } = useToast();
  const [audioArmed, setAudioArmed] = useState(false);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  /* Opens the voice dock from the header — the assistant is not just a
     floating pill a cook has to discover mid-service. */
  const [voiceRequest, setVoiceRequest] = useState(0);

  /* Below `lg` the three-column Kanban becomes ONE lane plus a segmented
     control. Stacking three full-height lanes meant a cook scrolled past two
     screens of other work to reach the tickets they were hired to look at. */
  const [lane, setLane] = useState<ColumnStatus>("pending");
  const [isWide, setIsWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => setIsWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  usePresence(null);

  const knownTickets = useRef<Set<string> | null>(null);
  if (knownTickets.current === null) {
    knownTickets.current = new Set(tickets.map((order) => order.id));
  }

  // Realtime B (`kds_orders` INSERT) lands as a refreshed ticket list —
  // the diff below drives the chime + arrival toast without a page reload.
  useEffect(() => {
    const known = knownTickets.current;
    if (!known) return;

    const arriving = tickets.filter((order) => !known.has(order.id));
    const first = arriving[0];
    if (!first) return;

    for (const order of arriving) known.add(order.id);
    if (!audioArmed || !isAudioArmed()) return;

    playChime();
    toast({
      title: `New ticket · Table ${first.table_code}`,
      description: `${arriving.reduce((total, order) => total + order.items.length, 0)} lines just landed in Pending.`,
    });
  }, [tickets, audioArmed, toast]);

  /* A waiter's "I'll serve this" on the floor writes serve_requested_at on the
     table (sql/018), which rides along on the ticket. Announce each new one so
     the pass knows someone is walking over — the strip above the lanes stays
     up until the ticket is served or refused. */
  const announcedServing = useRef<Set<string>>(new Set());
  useEffect(() => {
    const announced = announcedServing.current;
    const fresh = tickets.filter(
      (order) => order.serve_requested_at && !announced.has(order.id),
    );

    for (const order of tickets) {
      if (order.serve_requested_at) announced.add(order.id);
      else announced.delete(order.id);
    }

    const first = fresh[0];
    if (!first) return;
    if (audioArmed && isAudioArmed()) playChime();

    toast({
      title: `Waiter coming · Table ${first.table_code}`,
      description: "A server tapped “I'll serve this” on the floor board.",
    });
  }, [tickets, audioArmed, toast]);

  /* Stale pings are hidden after 20 minutes; the backend clears the flag when
     the ticket is served or denied, so this only catches a crashed device. */
  const incoming = tickets.filter((order) => {
    if (order.status !== "ready" || !order.serve_requested_at) return false;
    const requestedAt = Date.parse(order.serve_requested_at);
    if (!Number.isFinite(requestedAt)) return false;
    // Before the clock ticks, show the ping rather than hiding it.
    return now === null || now - requestedAt < 20 * 60_000;
  });

  /* Also the voice assistant's `start_shift` tool target, so a chef can arm
     the line by saying it. Returns a result instead of only toasting. */
  const handleStartShift = useCallback(async () => {
    const armed = armAudio();
    setAudioArmed(armed);

    // E13 — register this device for shift chimes (no-op when offline).
    try {
      await activateShift(getDeviceId());
    } catch {
      return { ok: false, message: "This device could not register for shift chimes." };
    }

    toast({
      title: armed ? "Shift active · Audio armed." : "Audio blocked",
      description: armed
        ? "The board will ping every time a table fires an order."
        : "This browser blocked the audio context — the board still updates visually.",
      tone: armed ? "success" : "error",
    });

    return armed
      ? { ok: true }
      : { ok: false, message: "This browser blocked audio, but the board is live." };
  }, [toast]);

  /* Manual refusal. The card has already collected a required reason in its
     confirmation modal; this only reports the outcome. */
  async function handleDeny(order: Order, reason: string) {
    const result = await deny(order, reason);

    if (!result.ok) {
      toast({ title: result.message ?? "Could not deny that ticket.", tone: "error" });
      return;
    }

    toast({
      title: `Table ${order.table_code} order denied`,
      description: "The diner sees your reason and can retry, edit, or cancel it.",
      tone: "success",
    });
  }

  async function handleAdvance(order: Order, next: OrderStatus) {
    // One-tap mutation guardrail: the hook's per-ticket busy map blocks the
    // second tap, and the card renders the button in its spinner state.
    const result = await advance(order, next);

    if (!result.ok) {
      toast({ title: result.message ?? "Could not update that ticket.", tone: "error" });
      return;
    }

    if (next === "served") {
      toast({
        title: `Table ${order.table_code} served`,
        description: "The ticket has been pruned from the board.",
        tone: "success",
      });
    } else {
      toast({
        title: `Table ${order.table_code} → ${next === "preparing" ? "Preparing" : "Ready"}`,
        description: "The table's live tracker updated instantly.",
        tone: "success",
      });
    }
  }

  return (
    <main id="main" className="min-h-dvh pb-16">
      {/* The bar is icon-only and the Kitchen badge carries the surface's
          identity, so the page heading lives here for assistive tech. */}
      <h1 className="sr-only">Kitchen display</h1>

      <OpsBar
        prefix={
          <Badge tone="brand" size="md">
            Kitchen
          </Badge>
        }
        actions={
          <>
            <Button
              variant="soft"
              size="sm"
              onClick={() => setVoiceRequest((current) => current + 1)}
              leftIcon={<Sparkles className="size-4" aria-hidden />}
            >
              Chhotu
            </Button>

            {/* Icon carries the state: a crossed speaker while the board is
                silent, ember until it is armed. The label explains it. */}
            <IconButton
              label={audioArmed ? "Audio on" : "Enable audio"}
              tone={audioArmed ? "soft" : "accent"}
              size="md"
              onClick={handleStartShift}
            >
              {audioArmed ? (
                <Volume2 className="size-4" aria-hidden />
              ) : (
                <VolumeX className="size-4" aria-hidden />
              )}
            </IconButton>

            {/* Backup refresh: the board normally updates itself over
                Realtime, but a manual re-read is there when a socket silently
                dies on a wall tablet. The glyph carries the state: a slow
                turn while reading, a green tick for a second after. */}
            <IconButton
              label="Refresh board"
              tone="ghost"
              size="md"
              onClick={() => void handleRefresh()}
              aria-busy={refreshing || undefined}
              className={cn(
                "transition-colors duration-500 ease-gentle",
                justRefreshed && "text-ready hover:text-ready",
              )}
            >
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
            </IconButton>
            <span role="status" className="sr-only">
              {justRefreshed ? "Kitchen board refreshed" : refreshing ? "Refreshing kitchen board" : ""}
            </span>

            <IconButton
              label="Manage 86"
              tone="outline"
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

      {/* ---- State matrix: error — API message + Retry Connection --------- */}
      {phase === "error" ? (
        <Container size="narrow" className="py-16">
          <ErrorState
            titleAs="h1"
            title="The board lost its connection"
            description={error?.message ?? "The kitchen line could not be reached."}
            action={
              <Button size="md" onClick={retry}>
                Retry Connection
              </Button>
            }
          />
        </Container>
      ) : (
        <>
          {incoming.length > 0 ? (
            <Container className="pt-4">
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ember/30 bg-ember-soft px-4 py-3">
                <BellRing className="size-4 shrink-0 text-ember" aria-hidden />
                <p className="text-sm font-semibold text-ink">Waiter coming</p>
                <ul className="flex flex-wrap gap-1.5">
                  {incoming.map((order) => (
                    <li
                      key={order.id}
                      className="rounded-pill bg-surface px-2.5 py-1 text-xs font-semibold text-ink tabular-nums"
                    >
                      Table {order.table_code}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-ink-muted">Hand the plate over at the pass.</p>
              </div>
            </Container>
          ) : null}

          {/* Segmented control — instant, local, no server round trip. */}
          <div className="lg:hidden">
            <Container className="pt-4">
              <div
                role="tablist"
                aria-label="Filter tickets by stage"
                className="grid grid-cols-3 gap-1 rounded-lg border border-line-strong bg-surface-sunken p-1"
              >
                {columns.map((column) => {
                  const count = tickets.filter((order) => order.status === column.status).length;
                  const active = lane === column.status;

                  return (
                    <button
                      key={column.status}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setLane(column.status)}
                      className={cn(
                        "flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1 text-xs font-semibold transition-colors duration-[var(--duration-fast)]",
                        active ? "bg-surface text-ink shadow-xs" : "text-ink-muted",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn("size-2 rounded-pill", column.rail)}
                      />
                      {column.title}
                      <span className="tabular-nums opacity-70">({count})</span>
                    </button>
                  );
                })}
              </div>
            </Container>
          </div>

          <Container className="grid gap-6 py-6 lg:grid-cols-3 lg:items-start">
            {columns.map((column) => {
              const list = tickets.filter((order) => order.status === column.status);
              const showOnPhone = column.status === lane;

              return (
                <section
                  key={column.status}
                  aria-label={`${column.title} tickets`}
                  /* Exactly one display utility per breakpoint, so no
                     ordering-dependent `hidden`/`flex` collision. */
                  className={cn(
                    "relative min-h-[20rem] flex-col gap-4 overflow-hidden rounded-lg border border-line-strong bg-surface p-4 pt-5 sm:p-5 lg:flex lg:min-h-[26rem]",
                    showOnPhone ? "flex" : "hidden",
                  )}
                >
                {/* The lane's own colour runs across its top edge so the three
                    columns are separable at a glance across the whole board. */}
                <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", column.rail)} />

                <header className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 className="font-display text-subheading leading-none text-ink">
                      {column.title}
                    </h2>
                  </div>

                  <span
                    aria-label={`${list.length} ${column.title} tickets`}
                    className={cn(
                      "font-display text-2xl leading-none font-semibold tabular-nums",
                      column.count,
                    )}
                  >
                    {list.length}
                  </span>
                </header>

                {/* ---- State matrix: loading — column skeletons ------------ */}
                {phase === "loading" ? (
                  <ul className="flex flex-col gap-4" aria-hidden>
                    {[0, 1].map((row) => (
                      <li
                        key={row}
                        className="flex flex-col gap-4 rounded-lg border border-line-strong bg-paper p-4"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Skeleton className="h-6 w-24 rounded-pill" />
                          <Skeleton className="h-3 w-12" />
                        </div>
                        <Skeleton className="h-4 w-36" />
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-10 w-full rounded-md" />
                      </li>
                    ))}
                  </ul>
                ) : list.length === 0 ? (
                  /* ---- State matrix: empty — contextual copy + CTA ------- */
                  <EmptyState
                    icon={column.Icon}
                    title={column.emptyTitle}
                    className="flex-1 py-8"
                  />
                ) : (
                  /* ---- State matrix: success — interactive grid ---------- */
                  <ul className="flex flex-col gap-4">
                    <AnimatePresence initial={false}>
                      {list.map((order) => (
                        <KdsCard
                          key={order.id}
                          order={order}
                          now={now}
                          busy={Boolean(busy[order.id])}
                          checkedItemIds={checked[order.id]}
                          onToggleItem={toggleItem}
                          onAdvance={(ticket, next) => void handleAdvance(ticket, next)}
                          onDeny={(ticket, denialReason) => void handleDeny(ticket, denialReason)}
                        />
                      ))}
                    </AnimatePresence>
                  </ul>
                )}
                </section>
              );
            })}
          </Container>
        </>
      )}

      <KitchenVoice
        tickets={tickets}
        menu={catalog.menu}
        refresh={refresh}
        onMove={(order, next) => advance(order, next)}
        onServe={(order) => advance(order, "served")}
        onDeny={deny}
        onSetAvailability={catalog.setAvailability}
        onStartShift={handleStartShift}
        openRequest={voiceRequest}
      />

      <MenuAvailabilityDrawer
        open={availabilityOpen}
        onClose={() => setAvailabilityOpen(false)}
        menu={catalog.menu}
        onSetAvailability={catalog.setAvailability}
      />
    </main>
  );
}
