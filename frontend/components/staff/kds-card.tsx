"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, Clock, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { Order, OrderStatus } from "@/lib/api/types";
import { formatElapsed } from "@/lib/format";
import { transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface AdvanceAction {
  label: string;
  variant: "ember" | "primary" | "soft";
  next: OrderStatus;
}

const actions: Record<Exclude<OrderStatus, "served">, AdvanceAction> = {
  pending: { label: "Start cooking", variant: "ember", next: "preparing" },
  preparing: { label: "Mark ready", variant: "ember", next: "ready" },
  ready: { label: "Mark served", variant: "primary", next: "served" },
};

const statusRail: Record<Exclude<OrderStatus, "served">, string> = {
  pending: "bg-pending",
  preparing: "bg-preparing",
  ready: "bg-ready",
};

/* Time-on-ticket is the one number a chef scans for, so it escalates through
   the status colours rather than sitting in flat grey. */
function elapsedClass(minutes: number) {
  if (minutes >= 12) return "bg-alert-surface text-alert";
  if (minutes >= 6) return "bg-preparing-surface text-preparing";
  return "bg-sand text-ink-muted";
}

export interface KdsCardProps {
  order: Order;
  now: number | null;
  /** True while this card's one-tap advance is in flight — locks the
      button so a double-tap can't fire a duplicate status mutation. */
  busy?: boolean;
  /** Frontend-only checklist ticks for this ticket (item ids). */
  checkedItemIds?: string[];
  /** Frontend-only: flips one line's tick. Never talks to the backend. */
  onToggleItem?: (orderId: string, itemId: string) => void;
  onAdvance: (order: Order, next: OrderStatus) => void;
}

export function KdsCard({
  order,
  now,
  busy = false,
  checkedItemIds,
  onToggleItem,
  onAdvance,
}: KdsCardProps) {
  const reduceMotion = useReducedMotion();
  // Narrowed once into a local: `order.status` is a property access, so
  // TypeScript cannot carry the `served` exclusion through to later reads.
  const status = order.status;

  const checked = useMemo(() => new Set(checkedItemIds ?? []), [checkedItemIds]);

  if (status === "served") return null;

  const action = actions[status];
  const checklist = status === "preparing";
  const lineCount = order.items.length;
  const doneCount = order.items.filter((item) => checked.has(item.id)).length;
  const allDone = checklist && lineCount > 0 && doneCount === lineCount;
  const progress = lineCount === 0 ? 0 : Math.round((doneCount / lineCount) * 100);

  const createdAt = new Date(order.created_at).getTime();
  const minutes = now === null ? 0 : Math.max(0, Math.floor((now - createdAt) / 60_000));

  return (
    <motion.li
      layout
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      transition={transitionBase}
      className={cn(
        "relative overflow-hidden rounded-lg border",
        // The pass is where the floor looks, so finished tickets sit forward.
        status === "ready"
          ? "border-ready/45 bg-ready-surface/45 shadow-md"
          : "border-line-strong bg-paper shadow-sm",
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1.5", statusRail[status])} />

      <div className="flex flex-col gap-4 p-4 pl-5">
        <header className="flex items-start justify-between gap-3">
          <p className="font-display text-xl leading-none font-semibold text-ink">
            Table {order.table_code}
          </p>

          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2 py-1 text-xs font-semibold tabular-nums",
              elapsedClass(minutes),
            )}
          >
            <Clock className="size-3.5" aria-hidden />
            {now === null ? "—" : formatElapsed(order.created_at, now)}
          </span>
        </header>

        {/* ---- The line's own workflow bar (preparing only) ------------- */}
        {checklist ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span
                className={cn(
                  "text-xs font-semibold tracking-[0.08em] uppercase tabular-nums",
                  allDone ? "text-ready" : "text-ink-subtle",
                )}
              >
                {allDone ? "All items ready" : `${doneCount} / ${lineCount} items ready`}
              </span>
            </div>

            <span className="block h-1 w-full overflow-hidden rounded-pill bg-sand">
              <span
                className={cn(
                  "block h-full rounded-pill transition-[width] duration-[var(--duration-slow)] ease-organic",
                  allDone ? "bg-ready" : "bg-ember",
                )}
                style={{ width: `${progress}%` }}
              />
            </span>
          </div>
        ) : null}

        <ul className="flex flex-col gap-3 border-t border-line pt-4">
          {order.items.map((item) => {
            const ticked = checklist && checked.has(item.id);

            return (
              <li key={item.id} className="flex flex-col gap-1.5">
                <div className="flex items-start gap-3">
                  {checklist ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={ticked}
                      aria-label={`${item.quantity} ${item.name} ready`}
                      onClick={() => onToggleItem?.(order.id, item.id)}
                      className={cn(
                        "mt-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border-2 transition-[background-color,border-color,color] duration-[var(--duration-fast)] ease-gentle",
                        ticked
                          ? "border-ready bg-ready text-on-ember"
                          : "border-line-strong bg-surface text-transparent hover:border-ink-subtle",
                      )}
                    >
                      <motion.span
                        initial={false}
                        animate={{ scale: ticked ? 1 : 0.5, opacity: ticked ? 1 : 0 }}
                        transition={{ duration: 0.14, ease: [0.4, 0, 0.2, 1] }}
                        className="flex items-center justify-center"
                      >
                        <Check className="size-4" strokeWidth={3} aria-hidden />
                      </motion.span>
                    </button>
                  ) : null}

                  <p
                    className={cn(
                      "flex flex-wrap items-baseline gap-2 text-base font-medium",
                      ticked ? "text-ink-subtle" : "text-ink",
                    )}
                  >
                    <span
                      className={cn(
                        "font-display text-lg font-semibold tabular-nums",
                        ticked && "line-through decoration-ink-subtle/60",
                      )}
                    >
                      {item.quantity}×
                    </span>
                    <span className={cn(ticked && "line-through decoration-ink-subtle/60")}>
                      {item.name}
                    </span>
                  </p>
                </div>

                {item.added_by && item.added_by !== "Guest" ? (
                  <p className={cn("text-xs text-ink-subtle", checklist && "pl-9")}>
                    {item.added_by}
                  </p>
                ) : null}

                {item.request_note ? (
                  <p className={cn("text-sm leading-relaxed text-ink-muted", checklist && "pl-9")}>
                    Note: {item.request_note}
                  </p>
                ) : null}

                {item.allergy_note ? (
                  <p
                    className={cn(
                      "mt-1 flex items-start gap-2 rounded-md border-2 border-alert/50 bg-alert-surface px-3 py-2",
                      "text-sm leading-snug font-bold tracking-wide text-alert uppercase",
                    )}
                  >
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>Allergy · {item.allergy_note}</span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        <Button
          variant={action.variant}
          size="lg"
          fullWidth
          className={cn(
            "h-14 text-base",
            // A fully ticked ticket is ready to leave the line — the action
            // takes the success colour so the chef's eye lands on it.
            allDone && "bg-ready hover:brightness-110",
          )}
          disabled={busy}
          loading={busy}
          onClick={() => {
            if (busy) return;
            onAdvance(order, action.next);
          }}
          rightIcon={busy ? undefined : <ArrowRight className="size-5" aria-hidden />}
        >
          {busy ? "Updating…" : action.label}
        </Button>
      </div>
    </motion.li>
  );
}
