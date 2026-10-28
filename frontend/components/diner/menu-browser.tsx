"use client";

import { Search } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { DishCard } from "@/components/diner/dish-card";
import { DishDeck } from "@/components/diner/dish-deck";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { getMenuCategories, type MenuCategoryNode } from "@/lib/api-client";
import type { MenuItem } from "@/lib/api/types";
import { DIET_FILTERS, matchesDiet, type DietFilter } from "@/lib/diner/diet";
import { buildMenuSections } from "@/lib/diner/menu-sections";
import { searchMenu } from "@/lib/diner/menu-atlas";
import { transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface MenuBrowserProps {
  menu: MenuItem[];
  quantities: Record<string, number>;
  pendingItemId: string | null;
  /** Per-item API validation messages rendered inline on the card. */
  itemErrors?: Record<string, string>;
  onAdd: (item: MenuItem) => void;
  /** Opens the existing review-and-fire surface. */
  onReview: () => void;
  /** Existing shared cart size, so the deck can offer the final step. */
  cartItemCount: number;
  /** Sticky offset for the search bar — the diner nav band docks above it. */
  stickyTopClass?: string;
}

/* The menu, laid out exactly as the manager organised it.

   Every section is a folder from the admin catalogue (menu_categories), in
   the folder order the admin set, with child folders nested one step in.
   Inside a section sits the one-card deck: swipe right to add, left to skip,
   and the next two dishes peek out from behind so the rail reads as a row
   that continues rather than a single card.

   The admin tree can fail to load (older API, flaky network). When it does,
   `buildMenuSections` falls back to the dishes' own category labels, so the
   table never loses its menu because a grouping convenience failed. Search is
   still a flat filter over everything, independent of the sections. */
export function MenuBrowser({
  menu,
  quantities,
  pendingItemId,
  itemErrors,
  onAdd,
  onReview,
  cartItemCount,
  stickyTopClass = "top-0",
}: MenuBrowserProps) {
  const [query, setQuery] = useState("");
  // One diet at a time, with "All" as an explicit choice — see lib/diner/diet.
  const [diet, setDiet] = useState<DietFilter>("all");
  const [categories, setCategories] = useState<MenuCategoryNode[] | null>(null);

  /* The tree is decoration over the dishes: while it loads (or if it fails),
     the fallback grouping is what renders. An error is deliberately silent —
     a guest should never be shown "category service unavailable". */
  useEffect(() => {
    let cancelled = false;

    getMenuCategories()
      .then((rows) => {
        if (!cancelled) setCategories(rows);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /* The filter narrows the menu BEFORE the sections are built, so a section
     only ever describes dishes the guest can order under the active diet. */
  const visibleMenu = useMemo(() => menu.filter((item) => matchesDiet(item, diet)), [menu, diet]);
  const matches = useMemo(() => searchMenu(visibleMenu, query), [visibleMenu, query]);
  const sections = useMemo(
    () => buildMenuSections(visibleMenu, categories),
    [visibleMenu, categories],
  );

  const searching = query.trim().length > 0;

  return (
    <div className="flex flex-col gap-7">
      {/* Sticky so search and the diet filter stay reachable while the guest
          scrolls a long menu. The offset is `--diner-nav-h`, published by the
          navbar's ResizeObserver, so the two bands dock together instead of
          the search sliding under the header. */}
      <div
        className={cn(
          "sticky z-20 -mx-1 rounded-lg bg-canvas/90 px-1 py-1.5 backdrop-blur-md",
          stickyTopClass,
        )}
      >
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <Input
            // The label is the placeholder here: a visible label row on a
            // phone costs 20px of permanently-stuck height. The accessible
            // name is kept on the control itself.
            aria-label="Ready to order?"
            placeholder="Ready to order? Dosa, biryani, chai…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            leadingIcon={<Search className="size-4" aria-hidden />}
            containerClassName="w-full sm:min-w-0 sm:flex-1"
          />

          {/* Diet is the only axis worth a persistent control here: it maps
              to a real question at an Indian table. Scrolls sideways rather
              than wrapping, so the sticky bar never grows taller. */}
          <div
            role="group"
            aria-label="Filter dishes by diet"
            className="hide-scrollbar flex h-12 w-full shrink-0 items-center gap-1 overflow-x-auto rounded-md border border-line-strong bg-surface p-1 sm:w-auto"
          >
            {DIET_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setDiet(option.id)}
                aria-pressed={diet === option.id}
                className={cn(
                  "flex h-full shrink-0 cursor-pointer items-center rounded-sm px-3 text-sm font-semibold transition-colors duration-[var(--duration-fast)] sm:px-3.5",
                  diet === option.id ? "bg-ember text-on-ember" : "text-ink-muted hover:text-ink",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <motion.div
        key={searching ? "search" : `rails:${diet}`}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionBase}
        className="flex flex-col gap-7"
      >
        {visibleMenu.length === 0 ? (
          <EmptyState
            title="Nothing on the menu fits that"
            description="No dish is tagged for this diet yet. Try another filter."
            action={
              <Button variant="soft" size="md" onClick={() => setDiet("all")}>
                Show everything
              </Button>
            }
          />
        ) : searching ? (
          matches.length === 0 ? (
            <EmptyState
              title="Nothing matches that"
              description="Try another dish, or clear the search to browse the menu."
              action={
                <Button variant="soft" size="md" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <section className="flex flex-col gap-5">
              <h2 className="font-display text-heading text-ink">
                {matches.length} {matches.length === 1 ? "dish" : "dishes"} match
                <span className="text-ember"> “{query.trim()}”</span>
              </h2>
              <DishGrid
                items={matches}
                quantities={quantities}
                pendingItemId={pendingItemId}
                itemErrors={itemErrors}
                onAdd={onAdd}
              />
            </section>
          )
        ) : (
          <div className="flex flex-col gap-9">
            <StageHeading
              title="Today’s menu"
              description={`${visibleMenu.length} ${
                visibleMenu.length === 1 ? "dish" : "dishes"
              } in ${sections.length} ${sections.length === 1 ? "section" : "sections"} · swipe right to add, left to skip.`}
            />

            {sections.map((section) => (
              <section
                key={section.id}
                className={cn(
                  "flex flex-col gap-4",
                  // Child folders read as one step in, like a nested menu.
                  section.depth > 0 && "border-l border-line pl-4 sm:pl-6",
                )}
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3
                    className={cn(
                      "font-display text-ink",
                      section.depth === 0 ? "text-heading" : "text-subheading",
                    )}
                  >
                    {section.name}
                  </h3>
                  <span className="text-xs font-medium text-ink-subtle tabular-nums">
                    {section.items.length} {section.items.length === 1 ? "dish" : "dishes"}
                  </span>
                </header>

                <DishDeck
                  /* Remount when the section's dish set changes (86'ing,
                     re-filtering), so the queue can never hold a stale dish. */
                  key={`${section.id}:${diet}:${section.items.map((item) => item.id).join(",")}`}
                  items={section.items}
                  quantities={quantities}
                  pendingItemId={pendingItemId}
                  itemErrors={itemErrors}
                  onAdd={onAdd}
                  stageLabel={section.name}
                  cartItemCount={cartItemCount}
                  onReview={onReview}
                  className="w-full"
                />
              </section>
            ))}
          </div>
        )}
      </motion.div>
    </div>
  );
}

function StageHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="relative flex w-full flex-col gap-2 border-b border-line pb-4">
      <h2 className="font-display text-heading text-balance text-ink">{title}</h2>
      {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
      <span aria-hidden className="absolute -bottom-px left-0 h-0.5 w-12 bg-ember" />
    </div>
  );
}

function DishGrid({
  items,
  quantities,
  pendingItemId,
  itemErrors,
  onAdd,
}: {
  items: MenuItem[];
  quantities: Record<string, number>;
  pendingItemId: string | null;
  itemErrors?: Record<string, string>;
  onAdd: (item: MenuItem) => void;
}) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item.id} className="h-full">
          <DishCard
            variant="grid"
            item={item}
            quantityInCart={quantities[item.id] ?? 0}
            pending={pendingItemId === item.id}
            error={itemErrors?.[item.id]}
            onAdd={onAdd}
            sizes="(min-width: 1024px) 24rem, (min-width: 640px) 45vw, 100vw"
          />
        </li>
      ))}
    </ul>
  );
}
