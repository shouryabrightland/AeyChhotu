"use client";

import { Activity, ArrowRight, ShieldAlert, ShoppingBasket, type LucideIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface Innovation {
  title: string;
  innovation: string;
  impact: string;
  icon: LucideIcon;
}

const innovations: Innovation[] = [
  {
    title: "The anti-chaos unified cart",
    innovation:
      "Every phone at a table shares one live-syncing room bucket instead of being treated as an independent customer.",
    impact:
      "A digital gatekeeper: the kitchen never receives eight tickets for one table, and course timing is protected without a server merging orders by hand.",
    icon: ShoppingBasket,
  },
  {
    title: "Guardrailed allergy alerts",
    innovation:
      "Dietary notes bypass the standard modifier log and are formatted as bold, high-contrast red directly on the kitchen ticket line.",
    impact:
      "Removes the human error of handwriting and forgotten verbal warnings — chefs see the safety risk without stopping the line.",
    icon: ShieldAlert,
  },
  {
    title: "Two-way micro-status",
    innovation:
      "Prep milestones stream outward: Pending, Preparing, Ready. No static done / not done checkbox.",
    impact:
      "Guests lose waiting anxiety and servers stop running to the kitchen window to ask how long the steaks will be.",
    icon: Activity,
  },
];

/* The Okay button talks back — the label advances with each card, and on
   the last one it loops, so the deck never dead-ends. */
const okayLabels = ["Okay!", "Oh?", "Woww.", "Nicee!"];

/* A deck, not a grid: only the front card is readable and actionable. Every
   card shares one grid cell so the cell height tracks the tallest card, and
   the front card's Okay button sends it to the back of the stack, revealing
   the next one. `order` holds the card indices front-to-back.

   The cards are solid surface cards (the same cream the kitchen display
   mock uses) sitting on the dark ink section — real sheets of paper on a
   dark table, not translucent glass. Ember carries all the ink accents. */
export function InnovationDeck() {
  const [order, setOrder] = useState<number[]>(() => innovations.map((_, index) => index));
  const [advanceCount, setAdvanceCount] = useState(0);
  const reduceMotion = useReducedMotion();

  function advance() {
    setAdvanceCount((count) => count + 1);
    setOrder((previous) => {
      const [front, ...rest] = previous;
      return front === undefined ? previous : [...rest, front];
    });
  }

  return (
    <div className="relative grid pb-14">
      {order.map((index, position) => {
        const item = innovations[index];
        if (!item) return null;

        const isFront = position === 0;

        return (
          <motion.article
            key={item.title}
            initial={false}
            animate={{ y: position * 20, scale: 1 - position * 0.045 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 240, damping: 28, mass: 0.9 }
            }
            style={{ zIndex: innovations.length - position }}
            aria-hidden={!isFront}
            // Padding in steps, not a percentage: 15% of a narrow phone card
            // is ~40px of dead space on a 6-line paragraph, which pushed the
            // Okay button off the card. `p-8` from `sm` up is the same
            // generous inset the desktop layout wanted.
            className={cn(
              "col-start-1 row-start-1 flex flex-col rounded-xl bg-surface p-5 sm:p-8",
              isFront
                ? "border-2 border-ember shadow-lg"
                : "pointer-events-none border border-line opacity-85 shadow-sm",
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-md bg-ember-soft text-ember">
              <item.icon className="size-5" aria-hidden />
            </span>

            <h3 className="mt-5 font-display text-subheading text-ember-strong">{item.title}</h3>

            <p className="mt-3 text-sm leading-relaxed text-ink-muted">{item.innovation}</p>

            <p className="mt-5 border-t border-line pt-5 text-sm leading-relaxed text-ink-muted">
              {item.impact}
            </p>

            {isFront ? (
              <div className="mt-auto flex items-center justify-between gap-4 border-t border-line pt-5">
                <span className="inline-flex items-center gap-1.5 rounded-pill bg-ember-soft px-2.5 py-1 text-label font-semibold tracking-[0.08em] text-ember-strong uppercase tabular-nums">
                  <span aria-hidden className="size-1.5 rounded-pill bg-ember" />
                  {index + 1} / {innovations.length}
                </span>
                <button
                  type="button"
                  onClick={advance}
                  aria-label="Okay, show the next idea"
                  className="group/okay inline-flex h-10 cursor-pointer items-center gap-2 rounded-md bg-ember px-4 text-sm font-semibold text-on-ember shadow-xs transition-[background-color,transform,box-shadow] duration-[var(--duration-fast)] ease-gentle hover:bg-ember-strong hover:shadow-md active:translate-y-px"
                >
                  {okayLabels[advanceCount % okayLabels.length]}
                  <ArrowRight
                    aria-hidden
                    className="size-4 transition-transform duration-[var(--duration-fast)] group-hover/okay:translate-x-0.5"
                  />
                </button>
              </div>
            ) : null}
          </motion.article>
        );
      })}
    </div>
  );
}
