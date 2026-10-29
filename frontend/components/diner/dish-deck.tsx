"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { DishCard } from "@/components/diner/dish-card";
import { DishPhoto } from "@/components/diner/dish-photo";
import { Button } from "@/components/ui/button";
import type { MenuItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export interface DishDeckProps {
  /** One folder's dishes, in menu order. */
  items: MenuItem[];
  quantities: Record<string, number>;
  pendingItemId: string | null;
  itemErrors?: Record<string, string>;
  /** The existing add-to-cart handler, passed straight through. */
  onAdd: (item: MenuItem) => void;
  /** The folder's name — the deck is the folder, so it heads its own pile. */
  label?: string;
  /** Optional small line above the name (a nested folder's parent, a search). */
  eyebrow?: string;
  /** next/image sizes hint for the top card. */
  sizes?: string;
  className?: string;
}

/* One folder, one deck: every dish in the folder sits in a single stack, and
   the guest works down it a card at a time — drag right to add, left to skip,
   or use the buttons.

   A stacked pile hides the rest of the folder on purpose: the whole menu is a
   grid of these piles, one per folder, so a guest picks a folder first and only
   then leafs through it. The two cards behind the live one are decorative
   (aria-hidden, pointer-events-none) but they are what makes the section read
   as a deck instead of a single tile that keeps changing.

   Replaced / re-filtered dishes remount this component from the browser (its
   key carries the dish ids), so the skipped list can never hold a stale dish. */
export function DishDeck({
  items,
  quantities,
  pendingItemId,
  itemErrors,
  onAdd,
  label,
  eyebrow,
  sizes = "(min-width: 1280px) 20rem, (min-width: 640px) 40vw, 100vw",
  className,
}: DishDeckProps) {
  const [queue, setQueue] = useState<MenuItem[]>(items);
  const [skipped, setSkipped] = useState<MenuItem[]>([]);
  const [addedCount, setAddedCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const current = queue[0] ?? null;
  const next = queue[1] ?? null;
  const total = items.length;
  const seen = total - queue.length;
  const progress = total === 0 ? 0 : Math.round((seen / total) * 100);

  function advance() {
    setQueue((rest) => rest.slice(1));
  }

  function handleAdd(item: MenuItem) {
    setAddedCount((count) => count + 1);
    setAnnouncement(`${item.name} added to the table cart.`);
    onAdd(item);
  }

  function handleSkip(item: MenuItem) {
    setSkipped((list) => (list.some((entry) => entry.id === item.id) ? list : [...list, item]));
    setAnnouncement(`Skipped ${item.name}.`);
  }

  function bringBack(item: MenuItem) {
    setSkipped((list) => list.filter((entry) => entry.id !== item.id));
    setQueue((list) => [item, ...list]);
    setAnnouncement(`${item.name} is back on top of the deck.`);
  }

  function startOver() {
    setQueue(items);
    setSkipped([]);
    setAddedCount(0);
    setAnnouncement(label ? `Starting ${label} again.` : "Starting this deck again.");
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {label ? (
        <header className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            {eyebrow ? (
              <span className="text-label text-ink-subtle uppercase">{eyebrow}</span>
            ) : null}
            <h3 className="truncate font-display text-subheading text-ink">{label}</h3>
          </div>
          <span className="shrink-0 text-xs font-medium text-ink-subtle tabular-nums">
            {total} {total === 1 ? "dish" : "dishes"}
          </span>
        </header>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {current ? (
        <div className="flex flex-col gap-3">
          {/* The padding reserves the room the pile spills into, so the cards
              behind the live one show as a stack edge instead of colliding
              with the progress row underneath. */}
          <div className="relative pr-3.5 pb-3">
            <div className="relative">
              {/* The next two cards peek out from behind the live one — a pile
                  that visibly has more underneath it. */}
              {queue.slice(1, 3).map((item, index) => {
                const depth = index + 1;
                return (
                  <div
                    key={item.id}
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
                    style={{
                      transform: `translate(${depth * 6}px, ${depth * 5}px)`,
                      opacity: depth === 1 ? 0.95 : 0.75,
                      zIndex: 10 - depth,
                    }}
                  >
                    <div className="p-3">
                      <DishPhoto
                        item={item}
                        sizes={sizes}
                        muted={!item.is_available}
                        className="rounded-md"
                      />
                    </div>
                    <p className="truncate px-4 pt-3 font-display text-subheading text-ink-subtle">
                      {item.name}
                    </p>
                  </div>
                );
              })}

              <div className="relative z-10">
                {/* The key is the dish id, so React swaps the card the moment
                    the deck advances — after the old one has already left. */}
                <DishCard
                  key={current.id}
                  item={current}
                  quantityInCart={quantities[current.id] ?? 0}
                  pending={pendingItemId === current.id}
                  error={itemErrors?.[current.id]}
                  sizes={sizes}
                  onAdd={handleAdd}
                  onSkip={handleSkip}
                  onExited={advance}
                />
              </div>
            </div>
          </div>

          {/* How far into the folder the guest is, in words as well as a bar,
              so "how much is left" is never something they have to infer. */}
          <div className="flex items-center gap-3">
            <span className="h-1 flex-1 overflow-hidden rounded-pill bg-sand">
              <span
                className="block h-full rounded-pill bg-ember transition-[width] duration-[var(--duration-base)] ease-organic"
                style={{ width: `${progress}%` }}
              />
            </span>
            <span className="text-xs font-medium text-ink-subtle tabular-nums">
              {Math.min(seen + 1, total)} / {total}
            </span>
          </div>

          {next || skipped.length > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-xs text-ink-subtle">
                {next ? `Up next · ${next.name}` : "Last one in this folder."}
              </p>
              {skipped.length > 0 ? (
                <span className="shrink-0 text-xs font-medium text-ink-muted tabular-nums">
                  {skipped.length} skipped
                </span>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-ink-subtle">Last one in this folder.</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-line-strong bg-surface/70 px-5 py-8 text-center">
          <div className="flex flex-col gap-1.5">
            <h4 className="font-display text-subheading text-ink">
              {label ? `That’s every dish in ${label}.` : "That’s every match."}
            </h4>
            <p className="text-sm leading-relaxed text-ink-muted">
              {addedCount > 0
                ? `${addedCount} ${addedCount === 1 ? "dish" : "dishes"} went to the table cart.`
                : "Nothing added from this folder."}
            </p>
          </div>

          {skipped.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {skipped.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => bringBack(item)}
                  aria-label={`Show ${item.name} again`}
                  className="cursor-pointer rounded-pill border border-line-strong bg-sand px-3.5 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-[var(--duration-fast)] hover:border-ember/40 hover:bg-ember-soft hover:text-ember"
                >
                  {item.name}
                </button>
              ))}
            </div>
          ) : null}

          <Button
            variant="soft"
            size="sm"
            onClick={startOver}
            leftIcon={<RotateCcw className="size-4" aria-hidden />}
          >
            Start again
          </Button>
        </div>
      )}
    </div>
  );
}
