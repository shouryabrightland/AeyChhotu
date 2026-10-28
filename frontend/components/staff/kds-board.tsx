"use client";

import { AnimatePresence } from "motion/react";
import { BellRing, ChefHat, EyeOff, Flame, Lock, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { KdsCard } from "@/components/staff/kds-card";
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
import { activateShift, getMe, type SessionIdentity } from "@/lib/api-client";
import { getDeviceId } from "@/lib/api/session";
import type { Order, OrderStatus } from "@/lib/api/types";
import { formatIstTime } from "@/lib/format";
import { armAudio, isAudioArmed, playChime } from "@/lib/sound";
import { cn } from "@/lib/utils";

type ColumnStatus = Exclude<OrderStatus, "served">;

/* Every class a lane needs is written out literally so Tailwind can see it
   at build time — a template-built `bg-${status}` would never be generated. */
interface Column {
  status: ColumnStatus;
  title: string;
  hint: string;
  rail: string;
  count: string;
  Icon: typeof Flame;
  emptyTitle: string;
  emptyBody: string;
}

const columns: Column[] = [
  {
    status: "pending",
    title: "Pending",
    hint: "Waiting to start",
    rail: "bg-pending",
    count: "text-pending",
    Icon: Flame,
    emptyTitle: "No tickets waiting",
    emptyBody: "Tickets appear here when a table fires an order.",
  },
  {
    status: "preparing",
    title: "Preparing",
    hint: "On the line",
    rail: "bg-preparing",
    count: "text-preparing",
    Icon: ChefHat,
    emptyTitle: "Nothing is cooking",
    emptyBody: "Tickets move here the moment the line starts them.",
  },
  {
    status: "ready",
    title: "Ready",
    hint: "At the pass",
    rail: "bg-ready",
    count: "text-ready",
    Icon: BellRing,
    emptyTitle: "Nothing at the pass",
    emptyBody: "Finished tickets wait here until the floor runs them.",
  },
];

export interface KdsBoardProps {
  onLock: () => void;
}

export function KdsBoard({ onLock }: KdsBoardProps) {
  const { phase, error, source, tickets, busy, retry, refresh, advance } = useLiveKds();
  /* The 86 drawer needs the LIVE catalog. E3 requires a table token that the
     kitchen does not hold, so the hook resolves one from E17 — see
     useStaffMenuCatalog. Was previously read from the offline demo store,
     which meant real dishes could not be 86'd from the board. */
  const catalog = useStaffMenuCatalog();
  const [shift, setShift] = useState<SessionIdentity | null>(null);

  /* Frontend-only checklist ticks, keyed by ticket then by line. Purely
     presentational: ticking a line never writes a status, and the real
     one-tap advance below is untouched. */
  const [checked, setChecked] = useState<Record<string, string[]>>({});

  const toggleItem = useCallback((orderId: string, itemId: string) => {
    setChecked((current) => {
      const set = new Set(current[orderId] ?? []);
      if (set.has(itemId)) set.delete(itemId);
      else set.add(itemId);
      return { ...current, [orderId]: [...set] };
    });
  }, []);

  /* E2b — restore the armed shift's identity from the stored bearer token.
     Claims only (role, terminal, expiry); a lapsed token 401s and the
     api-client's global guard sends the operator back to the PIN wall. */
  useEffect(() => {
    let cancelled = false;
    void getMe()
      .then((identity) => {
        if (!cancelled) setShift(identity);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const now = useNow(1000);
  const { toast } = useToast();
  const [audioArmed, setAudioArmed] = useState(false);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);

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

  // Offline fallback heads-up: one toast so the operator knows the board
  // is serving seeded demo data instead of the live kitchen.
  const demoToastShown = useRef(false);
  useEffect(() => {
    if (phase !== "success" || source !== "demo" || demoToastShown.current) return;
    demoToastShown.current = true;
    toast({
      title: "Offline demo board",
      description: "The backend is unreachable — showing the seeded demo tickets.",
      tone: "info",
    });
  }, [phase, source, toast]);

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

  function handleStartShift() {
    const armed = armAudio();
    setAudioArmed(armed);

    // E13 — register this device for shift chimes (no-op when offline).
    void activateShift(getDeviceId()).catch(() => undefined);

    toast({
      title: armed ? "Audio armed" : "Audio blocked",
      description: armed
        ? "The board will ping every time a table fires an order."
        : "This browser blocked the audio context — the board still updates visually.",
      tone: armed ? "success" : "error",
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

  const boardEmpty = tickets.length === 0;

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
            {/* E2b — the shift's own expiry, decoded from the bearer token.
                An 8-hour token expiring mid-service used to mean every one-tap
                action silently 401ing; now the line can see it coming. */}
            {shift ? (
              <Badge tone="neutral" size="md" title={`Signed in as ${shift.role}`}>
                Shift ends {formatIstTime(shift.expires_at)}
              </Badge>
            ) : null}

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
                    <span className="text-xs text-ink-subtle">{column.hint}</span>
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
                    description={column.emptyBody}
                    className="flex-1 py-8"
                    action={
                      boardEmpty ? (
                        <Button variant="outline" size="sm" onClick={() => void refresh()}>
                          Check again
                        </Button>
                      ) : undefined
                    }
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

      <MenuAvailabilityDrawer
        open={availabilityOpen}
        onClose={() => setAvailabilityOpen(false)}
        menu={catalog.menu}
        onSetAvailability={catalog.setAvailability}
      />
    </main>
  );
}
