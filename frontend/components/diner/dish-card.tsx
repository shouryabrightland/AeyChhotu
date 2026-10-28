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
  /** Only the deck has a queue to skip through. */
  onSkip?: (item: MenuItem) => void;
  /** Fired once the card has finished leaving, so the deck can advance. */
  onExited?: () => void;
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
  const interactive = isDeck && !unavailable && leaving === null;

  function decide(direction: SwipeDirection) {
    if (!isDeck || leaving !== null || unavailable) return;

    // The existing handler runs first: the cart is already updated while the
    // card is still on its way out.
    if (direction === 1) onAdd(item);
    else onSkip?.(item);

    setLeaving(direction);

    if (reduceMotion) {
      onExited?.();
      return;
    }

    /* One frame later, on purpose: releasing inside the constraints also asks
       motion to spring the card back to zero, and whichever animation starts
       last wins. Waiting a frame lets the exit animation be the one that
       owns the value instead of being cancelled by the spring. */
    requestAnimationFrame(() => {
      const slide = animate(dragX, direction * EXIT_DISTANCE, {
        duration: 0.24,
        ease: easeGentle,
      });
      void Promise.resolve(slide).then(() => {
        animate(opacity, 0, { duration: 0.12 }).then(() => onExited?.());
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
              gesture before the guest lets go. */}
          {interactive ? (
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

        <div className="flex flex-1 flex-col p-5 pt-3 sm:p-6 sm:pt-4">
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

          <div className="mt-auto flex items-end justify-between gap-4 pt-6">
            <span className="font-display text-xl font-semibold text-ink tabular-nums">
              {formatPrice(item.price)}
            </span>

            {/* Buttons keep their taps: a press that starts on them is not a
                drag, so nobody adds a dish by accident while swiping. */}
            <div
              onPointerDownCapture={(event) => event.stopPropagation()}
              className="flex items-center gap-2"
            >
              {isDeck && onSkip && !unavailable ? (
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
