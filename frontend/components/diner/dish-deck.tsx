"use client";

import { Flame, RotateCcw } from "lucide-react";
import { useState } from "react";
import { DishCard } from "@/components/diner/dish-card";
import { DishPhoto } from "@/components/diner/dish-photo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MenuItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export interface DishDeckProps {
  items: MenuItem[];
  quantities: Record<string, number>;
  pendingItemId: string | null;
  itemErrors?: Record<string, string>;
  /** The existing add-to-cart handler, passed straight through. */
  onAdd: (item: MenuItem) => void;
  /** The stage's name, used in the progress and completion copy. */
  stageLabel: string;
  /** Existing cart size, only to decide whether the finish CTA is useful. */
  cartItemCount: number;
  onReview: () => void;
  className?: string;
}

/* The ordering round: one dish at a time, taken off the top.

   Deliberately stateful per mount and not a real queue in any data sense —
   the parent remounts it with a key when the guest changes category, which is
   cheaper and more predictable than reconciling an ordered list against a
   menu that can change under it. Adding and skipping both run the caller's
   existing handlers; nothing here touches the cart itself. */
export function DishDeck({
  items,
  quantities,
  pendingItemId,
  itemErrors,
  onAdd,
  stageLabel,
  cartItemCount,
  onReview,
  className,
}: DishDeckProps) {
  const [queue, setQueue] = useState<MenuItem[]>(items);
  const [skipped, setSkipped] = useState<MenuItem[]>([]);
  const [addedCount, setAddedCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const current = queue[0] ?? null;
  const total = items.length;
  const done = total - queue.length;

  function handleAdd(item: MenuItem) {
    setAddedCount((count) => count + 1);
    setAnnouncement(`${item.name} added to the table cart.`);
    onAdd(item);
  }

  function handleSkip(item: MenuItem) {
    setSkipped((list) => [...list, item]);
    setAnnouncement(`Skipped ${item.name}.`);
  }

  function startOver() {
    setQueue(items);
    setSkipped([]);
    setAddedCount(0);
    setAnnouncement(`Starting ${stageLabel} again.`);
  }

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {/* Progress. Named in words as well as drawn, so "how much is left" is
          never something the guest has to infer from a bar. */}
      <div className="flex items-center gap-4">
        <span className="text-label text-ink-subtle uppercase tabular-nums">
          {Math.min(done + (current ? 1 : 0), total)} of {total}
        </span>
        <span className="h-1 flex-1 overflow-hidden rounded-pill bg-sand">
          <span
            className="block h-full rounded-pill bg-ember transition-[width] duration-[var(--duration-base)] ease-organic"
            style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }}
          />
        </span>
        <span className="text-xs font-medium text-ink-muted">
          {addedCount > 0 ? `${addedCount} added` : "Drag or tap"}
        </span>
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {current ? (
        <div className="flex flex-col gap-4">
          {/* The next two dishes peek out from behind the live card. They are
              decorative — aria-hidden and pointer-events-none — but they make
              the section read as a rail of cards instead of a single tile
              that happens to be replaceable. */}
          <div className="relative">
            {queue.slice(1, 3).map((item, index) => {
              const depth = index + 1;
              return (
                <div
                  key={item.id}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
                  style={{
                    transform: `translate(${depth * 14}px, ${depth * 7}px) scale(${1 - depth * 0.035})`,
                    opacity: depth === 1 ? 0.7 : 0.45,
                    zIndex: 10 - depth,
                  }}
                >
                  <div className="relative h-1/2 w-full overflow-hidden">
                    <DishPhoto
                      item={item}
                      sizes="(min-width: 1024px) 30rem, (min-width: 640px) 28rem, 100vw"
                    />
                  </div>
                  <div className="p-5">
                    <p className="font-display text-subheading text-ink-subtle">{item.name}</p>
                  </div>
                </div>
              );
            })}

            <div className="relative z-20">
              {/* The key is the dish id, so React swaps the card the moment the
                  deck advances — after the old one has already left. */}
              <DishCard
                key={current.id}
                item={current}
                quantityInCart={quantities[current.id] ?? 0}
                pending={pendingItemId === current.id}
                error={itemErrors?.[current.id]}
                onAdd={handleAdd}
                onSkip={handleSkip}
                onExited={() => setQueue((rest) => rest.slice(1))}
                sizes="(min-width: 1024px) 30rem, (min-width: 640px) 28rem, 100vw"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 px-1">
            <p className="text-xs leading-relaxed text-ink-subtle">
              {done === 0
                ? "Swipe right to add, left to skip — or use the buttons."
                : queue[1]
                  ? `Up next · ${queue[1].name}`
                  : "Last one in this section."}
            </p>
            {skipped.length > 0 ? (
              <p className="text-xs font-medium text-ink-muted tabular-nums">
                {skipped.length} skipped
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <Card className="flex flex-col items-center gap-5 py-10 text-center">
          <div className="flex flex-col gap-2">
            <h3 className="font-display text-subheading text-ink">
              That&rsquo;s every dish in {stageLabel}.
            </h3>
            <p className="mx-auto max-w-sm text-sm leading-relaxed text-ink-muted">
              {addedCount > 0
                ? `${addedCount} ${addedCount === 1 ? "dish" : "dishes"} went to the shared cart. `
                : "Nothing added from this section. "}
              {skipped.length > 0
                ? "You can still bring back anything you skipped."
                : "Pick another section whenever you are ready."}
            </p>
          </div>

          {skipped.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {skipped.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSkipped((list) => list.filter((entry) => entry.id !== item.id));
                    handleAdd(item);
                    setQueue(items);
                  }}
                  className="cursor-pointer rounded-pill border border-line-strong bg-sand px-3.5 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-[var(--duration-fast)] hover:border-ember/40 hover:bg-ember-soft hover:text-ember"
                >
                  + {item.name}
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              variant="soft"
              size="md"
              onClick={startOver}
              leftIcon={<RotateCcw className="size-4" aria-hidden />}
            >
              Start {stageLabel} again
            </Button>
            {cartItemCount > 0 ? (
              <Button
                variant="ember"
                size="md"
                onClick={onReview}
                leftIcon={<Flame className="size-4" aria-hidden />}
              >
                Review &amp; fire
              </Button>
            ) : null}
          </div>
        </Card>
      )}
    </div>
  );
}