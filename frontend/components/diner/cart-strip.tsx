"use client";

import { ShoppingBasket } from "lucide-react";
import { Container } from "@/components/ui/container";
import { formatPrice } from "@/lib/format";

export interface CartStripProps {
  itemCount: number;
  total: number;
  onView: () => void;
}

/* The phone's version of the cart: one compact bar instead of half the
   screen, and the whole bar is the tap target that opens the full cart. It
   only exists below lg, where the sticky column above is hidden. */
export function CartStrip({ itemCount, total, onView }: CartStripProps) {
  if (itemCount === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink/20 bg-ink text-ink-inverse shadow-lg lg:hidden">
      {/* The strip is pinned to the very bottom, so it owns the home-indicator
          inset: without this the Review button sits under the gesture bar on
          an iPhone. `max()` keeps a sane minimum on devices with no inset. */}
      <Container className="pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onView}
          aria-label={`Open the table cart: ${itemCount} ${
            itemCount === 1 ? "item" : "items"
          }, ${formatPrice(total)}`}
          className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-md text-left transition-colors duration-[var(--duration-fast)]"
        >
          <span className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-md bg-ink-inverse/10"
            >
              <ShoppingBasket className="size-5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="font-display text-base font-semibold tabular-nums">
                {formatPrice(total)}
              </span>
              <span className="truncate text-xs text-ink-inverse/65">
                {itemCount} {itemCount === 1 ? "item" : "items"} · shared with the table
              </span>
            </span>
          </span>

          <span className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-ember px-5 text-sm font-semibold text-on-ember shadow-xs">
            Review
            <span aria-hidden>→</span>
          </span>
        </button>
      </Container>
    </div>
  );
}
