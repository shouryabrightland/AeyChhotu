"use client";

import { Check, Plus, X } from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useState } from "react";
import { DietMark } from "@/components/diner/diet-mark";
import { DishPhoto } from "@/components/diner/dish-photo";
import { Button } from "@/components/ui/button";
import type { MenuItem } from "@/lib/api/types";
import { formatPrice } from "@/lib/format";
import { easeGentle } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** How far, or how fast, the card has to travel before it commits. */
const DISTANCE_THRESHOLD = 108;
const VELOCITY_THRESHOLD = 620;
const EXIT_DISTANCE = 520;

export type SwipeDirection = 1 | -1;

export interface DishCardProps {
  item: MenuItem;
  quantityInCart: number;
  pending?: boolean;
  /** API validation / inventory message rendered under the description. */
  error?: string;
  onAdd: (item: MenuItem) => void;
  /** Only a swipe surface has a queue to skip through. */
  onSkip?: (item: MenuItem) => void;
  /** Fired once the card has finished leaving, with the direction it went
      (+1 added, -1 skipped) so the caller can advance the queue — or, in a
      grid, drop a skipped card out of the row. */
  onExited?: (direction: SwipeDirection) => void;
  /** Grid mode: an ADD flicks the card out and then brings it back to its own
      cell (with the "in cart" badge), because a grid has no next card to
      advance to. Skips still leave for good. */
  returnAfterAdd?: boolean;
  /** "deck" is the swipe surface; "grid" is the plain browse card. */
  variant?: "deck" | "grid";
  sizes?: string;
  className?: string;
}

/* One dish, one card, two ways to order: drag it right, or press Add. Both
   run the caller's existing add handler and both advance the deck, so a guest
   who never discovers the gesture loses nothing.

   The card owns its own exit — it animates out from wherever the finger left
   it and only then tells the deck to move on, so the next dish never appears
   underneath a card that is still sliding. */
export function DishCard({
  item,
  quantityInCart,
  pending = false,
  error,
  onAdd,
  onSkip,
  onExited,
  returnAfterAdd = false,
  variant = "deck",
  sizes = "(min-width: 1024px) 28rem, 100vw",
  className,
}: DishCardProps) {
  const reduceMotion = useReducedMotion();
  const dragX = useMotionValue(0);
  const opacity = useMotionValue(1);
  const rotate = useTransform(dragX, [-320, 0, 320], [-7, 0, 7]);
  const addReveal = useTransform(dragX, [18, 120], [0, 1]);
  const skipReveal = useTransform(dragX, [-120, -18], [1, 0]);

  const [leaving, setLeaving] = useState<SwipeDirection | null>(null);
  const unavailable = !item.is_available;
  const isDeck = variant === "deck";
  /* Draggability no longer depends on availability: a sold-out dish has no
     Add button, so WITHOUT the swipe (and the Skip button below) a guest
     would be stranded on a card they cannot order. */
  const interactive = isDeck && leaving === null;
  const canAdd = interactive && !unavailable;

  function decide(direction: SwipeDirection) {
    if (!isDeck || leaving !== null) return;

    /* A sold-out dish cannot be added, so BOTH directions skip it: swiping
       right on it still moves the deck on rather than dead-ending. */
    const commit: SwipeDirection = unavailable ? -1 : direction;

    // The existing handler runs first: the cart is already updated while the
    // card is still on its way out.
    if (commit === 1) onAdd(item);
    else onSkip?.(item);

    setLeaving(direction);

    /* The card comes back to its cell only after an ADD: it has to be home
       before the guest can add a second portion, and the badge that fades in
       behind it is what tells them the tap landed. */
    const restore = () => {
      setLeaving(null);
      dragX.set(0);
      void animate(opacity, 1, { duration: 0.18, ease: easeGentle });
    };

    if (reduceMotion) {
      onExited?.(commit);
      if (commit === 1 && returnAfterAdd) restore();
      return;
    }

    /* One frame later, on purpose: releasing inside the constraints also asks
       motion to spring the card back to zero, and whichever animation starts
       last wins. Waiting a frame lets the exit animation be the one that
       owns the value instead of being cancelled by the spring. */
    requestAnimationFrame(() => {
      // Leaves the way the guest pushed it — or the OPPOSITE way when the
      // dish was sold out and a right-swipe was answered with a skip.
      const slide = animate(dragX, commit * EXIT_DISTANCE, {
        duration: 0.24,
        ease: easeGentle,
      });
      void Promise.resolve(slide).then(() => {
        animate(opacity, 0, { duration: 0.12 }).then(() => {
          onExited?.(commit);
          if (commit === 1 && returnAfterAdd) restore();
        });
      });
    });
  }

  return (
    <motion.div
      drag={interactive ? "x" : false}
      /* Vertical scrolling wins: the browser decides the gesture axis once,
         so a downward flick that wanders a few pixels sideways scrolls the
         deck instead of adding a dish. Without this, long menus were almost
         impossible to scroll with a thumb. */
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.55}
      dragMomentum={false}
      onDragEnd={(_, info) => {
        if (info.offset.x > DISTANCE_THRESHOLD || info.velocity.x > VELOCITY_THRESHOLD) decide(1);
        else if (info.offset.x < -DISTANCE_THRESHOLD || info.velocity.x < -VELOCITY_THRESHOLD) decide(-1);
      }}
      style={{ x: dragX, opacity, ...(reduceMotion ? {} : { rotate }) }}
      aria-hidden={leaving !== null || undefined}
      className={cn(
        "h-full touch-pan-y",
        interactive && "cursor-grab",
        leaving !== null && "pointer-events-none",
      )}
    >
      <div
        className={cn(
          "group relative flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-md",
          className,
        )}
      >
        <div className="relative p-3">
          <DishPhoto item={item} sizes={sizes} muted={unavailable} />

          <span className="absolute top-5 left-5">
            <DietMark vegetarian={item.vegetarian} />
          </span>

          {quantityInCart > 0 ? (
            <span className="absolute top-5 right-5 inline-flex items-center gap-1.5 rounded-pill border border-ember/25 bg-ember-soft px-2.5 py-1 text-xs font-semibold text-ember">
              <Check className="size-3.5" aria-hidden />
              {quantityInCart} in cart
            </span>
          ) : null}

          {/* Swipe stamps. They fade in with travel, so the card answers the
              gesture before the guest lets go. A sold-out dish shows neither:
              there is nothing to "Add", and the stamp would lie. */}
          {canAdd ? (
            <>
              <motion.span
                aria-hidden
                style={{ opacity: addReveal }}
                className="pointer-events-none absolute bottom-5 left-5 inline-flex -rotate-6 items-center gap-1.5 rounded-md border-2 border-ready/45 bg-ready-surface/95 px-3 py-1.5 text-xs font-bold tracking-[0.12em] text-ready uppercase"
              >
                <Check className="size-4" />
                Add
              </motion.span>
              <motion.span
                aria-hidden
                style={{ opacity: skipReveal }}
                className="pointer-events-none absolute right-5 bottom-5 inline-flex rotate-6 items-center gap-1.5 rounded-md border-2 border-alert/45 bg-alert-surface/95 px-3 py-1.5 text-xs font-bold tracking-[0.12em] text-alert uppercase"
              >
                <X className="size-4" />
                Skip
              </motion.span>
            </>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col p-4 pt-3">
          <h3
            className={cn(
              "font-display text-subheading",
              unavailable ? "text-ink-subtle line-through" : "text-ink",
            )}
          >
            {item.name}
          </h3>

          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{item.description}</p>

          {error ? (
            <p role="alert" className="mt-3 text-xs font-medium text-alert">
              {error}
            </p>
          ) : null}

          {/* Price and actions are deliberately TWO rows. At the three-across
              laptop width a single row needs ~248px inside a 213px card, and
              the card's own overflow-hidden was slicing the Add button off —
              which is what made the grid look broken. flex-wrap is the last
              resort: if a card ever gets narrower than its buttons, they stack
              instead of being cut. */}
          <div className="mt-auto flex flex-col gap-3 pt-4">
            <span className="font-display text-xl font-semibold text-ink tabular-nums">
              {formatPrice(item.price)}
            </span>

            {/* Buttons keep their taps: a press that starts on them is not a
                drag, so nobody adds a dish by accident while swiping.

                justify-between puts Skip on the left edge and Add on the
                right edge of the card — the row spans the card instead of
                huddling in the corner with dead space beside it. flex-wrap
                stays as the guard for any card narrower than both buttons. */}
            <div
              onPointerDownCapture={(event) => event.stopPropagation()}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              {isDeck && onSkip ? (
                <Button
                  variant="ghost"
                  size="md"
                  disabled={leaving !== null}
                  onClick={() => decide(-1)}
                  aria-label={`Skip ${item.name}`}
                >
                  Skip
                </Button>
              ) : null}

              {unavailable ? (
                <span className="rounded-pill bg-pending-surface px-4 py-2 text-label text-pending uppercase">
                  Out of stock
                </span>
              ) : (
                <Button
                  variant="ember"
                  size="md"
                  loading={pending}
                  disabled={leaving !== null}
                  onClick={() => (isDeck ? decide(1) : onAdd(item))}
                  aria-label={`Add ${item.name} to the table cart`}
                  leftIcon={<Plus className="size-4" aria-hidden />}
                >
                  Add
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
