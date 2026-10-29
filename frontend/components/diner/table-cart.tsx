"use client";

import { Flame, Loader2, Pencil, Receipt } from "lucide-react";
import { QuantityStepper } from "@/components/diner/quantity-stepper";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface TableCartProps {
  /** The same live snapshot every other surface at this table reads. */
  live: LiveTableValue;
  /** Opens the existing review-and-fire surface. */
  onReview: () => void;
  /** Asks the server to bring the bill. */
  onRequestBill: () => void;
  /** True once this table has asked, so the icon stops inviting a second tap. */
  billRequested?: boolean;
  className?: string;
}

/* The shared cart, kept in view while the guest browses.

   It shows the same lines, calls the same updateLine / removeLine handlers and
   totals the same way as the review modal — it is a second window onto one
   cart, not a second cart. Quantity changes are optimistic-feeling because
   the server applies them as deltas and the realtime channel echoes back. */
export function TableCart({
  live,
  onReview,
  onRequestBill,
  billRequested = false,
  className,
}: TableCartProps) {
  const { cart, menuIndex, totals, soldOutInCart, syncing, updateLine, removeLine } = live;

  function changeQuantity(cartItemId: string, nextQuantity: number, delta: number) {
    /* Optimistic (#4): the hook paints the new quantity immediately, so there
       is no per-line spinner blocking the next tap. */
    if (nextQuantity < 1) {
      void removeLine(cartItemId);
    } else if (delta !== 0) {
      void updateLine(cartItemId, { quantity_delta: delta });
    }
  }

  return (
    <Card marked className={className}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-label text-ember uppercase">Live table cart</p>
          <p className="mt-2 font-display text-3xl font-semibold text-ink tabular-nums">
            {formatPrice(totals.total)}
          </p>
        </div>
        {/* The count is the one place the cart admits to a write still in
            flight: an add paints instantly, and until the server has been read
            back this pill says "Syncing" instead of a number that may change. */}
        <span
          aria-live="polite"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold tabular-nums transition-colors duration-[var(--duration-fast)]",
            syncing ? "bg-ember-soft text-ember" : "bg-sand text-ink-muted",
          )}
        >
          {syncing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {syncing
            ? "Syncing"
            : `${totals.itemCount} ${totals.itemCount === 1 ? "item" : "items"}`}
        </span>
      </div>

      {soldOutInCart.length > 0 ? (
        <p className="mt-5 rounded-md border border-alert/35 bg-alert-surface px-3.5 py-3 text-sm font-medium text-alert">
          Sold out since it was added: {soldOutInCart.map((item) => item.name).join(", ")}.
        </p>
      ) : null}

      {cart.length === 0 ? (
        <div className="mt-5 rounded-lg border border-dashed border-line-strong bg-canvas px-5 py-9 text-center">
          <p className="font-display text-subheading text-ink">Your table is waiting.</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            Cart is empty. Add dishes to begin.
          </p>
        </div>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {cart.map((line) => {
            const item = menuIndex.get(line.menu_item_id);
            const unitPrice = item?.price ?? 0;
            const unavailable = item ? !item.is_available : false;

            return (
              <li key={line.id} className="flex flex-col gap-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-display text-base text-ink">
                      {item?.name ?? "Removed item"}
                    </p>
                    <p className="mt-1 text-xs text-ink-subtle">
                      Added by {line.added_by} · {formatPrice(unitPrice)} each
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-ink tabular-nums">
                    {formatPrice(unitPrice * line.quantity)}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs leading-relaxed">
                    {line.allergy_note ? (
                      <p className="truncate font-semibold tracking-wide text-alert uppercase">
                        Allergy · {line.allergy_note}
                      </p>
                    ) : null}
                    {line.request_note ? (
                      <p className="truncate text-ink-subtle">Note · {line.request_note}</p>
                    ) : null}
                    {unavailable ? (
                      <p className="font-medium text-alert">
                        Ran out while you were ordering — remove it to keep firing.
                      </p>
                    ) : null}
                  </div>

                  <QuantityStepper
                    quantity={line.quantity}
                    label={item?.name ?? "this item"}
                    onChange={(nextQuantity) =>
                      changeQuantity(line.id, nextQuantity, nextQuantity - line.quantity)
                    }
                    className="shrink-0"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6 flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <Button
            variant="ember"
            size="lg"
            className="flex-1"
            disabled={cart.length === 0}
            onClick={onReview}
            leftIcon={<Flame className="size-5" aria-hidden />}
          >
            Review &amp; fire
          </Button>

          {/* Deliberately wordless: asking for the bill is not a step in the
              ordering flow, so it gets one glyph beside the primary action
              and says its name on hover. */}
          <Tooltip
            label={billRequested ? "Waiting for the server to settle" : "Get bill now"}
            side="top"
            className="max-w-40"
          >
            <button
              type="button"
              onClick={onRequestBill}
              disabled={billRequested}
              aria-label="Get bill now"
              aria-pressed={billRequested}
              className={cn(
                "inline-flex size-13 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors duration-[var(--duration-fast)]",
                "disabled:cursor-default",
                billRequested
                  ? "border-ember/40 bg-ember-soft text-ember"
                  : "border-line-strong text-ink-muted hover:border-ink-subtle hover:bg-sand hover:text-ink",
              )}
            >
              <Receipt className="size-5" aria-hidden />
            </button>
          </Tooltip>
        </div>

        {cart.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            fullWidth
            onClick={onReview}
            leftIcon={<Pencil className="size-4" aria-hidden />}
          >
            Edit quantities and notes
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
