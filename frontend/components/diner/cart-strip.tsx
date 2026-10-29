"use client";

import { Loader2, Receipt, ShoppingBasket } from "lucide-react";
import { Container } from "@/components/ui/container";
import { Tooltip } from "@/components/ui/tooltip";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface CartStripProps {
  itemCount: number;
  total: number;
  onView: () => void;
  /** Server state: true once this table has asked for the bill. */
  billRequested?: boolean;
  /** Asks the server to bring the bill — the phone's only bill action. */
  onRequestBill?: () => void;
  /** A cart write is still in flight, so the summary admits it instead of
      pretending the table has caught up. */
  syncing?: boolean;
}

/* The phone's version of the cart: one compact bar instead of half the
   screen. It only exists below lg, where the sticky column above is hidden.

   It is ALWAYS rendered, not only once something is in the cart: the bar is
   the phone's only door to the cart and to "Get bill", so an empty table
   still has to show where those live. The empty state swaps the total for
   the honest answer instead of a row of zeroes. */
export function CartStrip({
  itemCount,
  total,
  onView,
  billRequested = false,
  onRequestBill,
  syncing = false,
}: CartStripProps) {
  const empty = itemCount === 0;
  const summary = empty
    ? "Cart is empty"
    : `${itemCount} ${itemCount === 1 ? "item" : "items"} · shared with the table`;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink/20 bg-ink text-ink-inverse shadow-lg lg:hidden">
      {/* The strip is pinned to the very bottom, so it owns the home-indicator
          inset: without this the Review button sits under the gesture bar on
          an iPhone. `max()` keeps a sane minimum on devices with no inset. */}
      <Container className="pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onView}
            aria-label={`Open the table cart: ${
              empty ? "empty" : `${itemCount} ${itemCount === 1 ? "item" : "items"}, ${formatPrice(total)}`
            }${syncing ? ", still syncing" : ""}`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left transition-colors duration-[var(--duration-fast)]"
          >
            <span
              aria-hidden
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-md",
                empty ? "bg-ink-inverse/10 text-ink-inverse/55" : "bg-ink-inverse/10",
              )}
            >
              <ShoppingBasket className="size-5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span
                className={cn(
                  "font-display text-base font-semibold tabular-nums",
                  empty && "text-ink-inverse/75",
                )}
              >
                {empty ? summary : formatPrice(total)}
              </span>
              <span
                aria-live="polite"
                className="flex min-w-0 items-center gap-1.5 truncate text-xs text-ink-inverse/65"
              >
                {syncing ? (
                  <>
                    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                    <span className="truncate">Syncing with the table…</span>
                  </>
                ) : empty ? (
                  "Add dishes to begin"
                ) : (
                  summary
                )}
              </span>
            </span>
          </button>

          {/* Deliberately wordless, exactly like the desktop cart: asking for
              the bill is not a step in the ordering flow, so it gets one glyph
              and says its name on hover / to a screen reader. */}
          {onRequestBill ? (
            <Tooltip label={billRequested ? "Waiting for the server to settle" : "Get bill now"} side="top">
              <button
                type="button"
                onClick={onRequestBill}
                disabled={billRequested}
                aria-label={billRequested ? "Bill requested" : "Get bill now"}
                aria-pressed={billRequested}
                className={cn(
                  "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors duration-[var(--duration-fast)]",
                  "disabled:cursor-default",
                  billRequested
                    ? "border-ember/45 bg-ember-soft/20 text-ember"
                    : "border-ink-inverse/25 text-ink-inverse/85 hover:bg-ink-inverse/10 hover:text-ink-inverse",
                )}
              >
                <Receipt className="size-5" aria-hidden />
              </button>
            </Tooltip>
          ) : null}

          <button
            type="button"
            onClick={onView}
            className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-md bg-ember px-4 text-sm font-semibold text-on-ember shadow-xs sm:px-5"
          >
            Review
            <span aria-hidden>→</span>
          </button>
        </div>
      </Container>
    </div>
  );
}
