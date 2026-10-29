"use client";

import { Search } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
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
  /** Sticky offset for the search bar — the diner nav band docks above it. */
  stickyTopClass?: string;
}

/* One deck's worth of images, at the width a deck actually renders at. */
const DECK_SIZES = "(min-width: 640px) 25rem, 100vw";

/* No deck is ever wider than this: past ~400px the plate and the copy stop
   reading as a card and start reading as a poster. A capped deck is centred in
   its cell rather than pinned to the left edge. Kept in one place because the
   grid cells, the search deck and the image hints all have to agree. */
const DECK_MAX = "mx-auto max-w-[400px]";

/* The menu as a wall of folders.

   Every section is a folder from the admin catalogue (menu_categories), in the
   folder order the admin set. One folder is one DECK — its dishes sit stacked
   in a single pile, and the guest works down it a card at a time (drag right to
   add, left to skip, or the buttons). The piles are laid out on a responsive
   grid: one per row on a phone, two on a tablet. From `lg` the menu column
   shares its row with the 21rem cart aside, so the count drops back to one and
   only widens to two from `xl` — a deck needs room for a photo, a description
   and a price/action row to look like a card rather than a column of text.

   The admin tree can fail to load (older API, flaky network). When it does,
   `buildMenuSections` falls back to the dishes' own category labels, so the
   table never loses its menu because a grouping convenience failed. Search is
   still a flat filter over everything, and its matches arrive as one deck too. */
export function MenuBrowser({
  menu,
  quantities,
  pendingItemId,
  itemErrors,
  onAdd,
  stickyTopClass = "top-0",
}: MenuBrowserProps) {
  const [query, setQuery] = useState("");
  // One diet at a time, with "All" as an explicit choice — see lib/diner/diet.
  const [diet, setDiet] = useState<DietFilter>("all");
  const [categories, setCategories] = useState<MenuCategoryNode[] | null>(null);

  /* The tree is decoration over the dishes: while it loads (or if it fails),
     the fallback grouping is what renders. An error is deliberately silent —
     a guest should never be shown "category service unavailable".

     docs/14 #7: a renamed / new folder must reach an open diner screen, so
     the tree is re-read whenever the menu reloads (an 86, a realtime menu
     event, the soft refresh). A failed read retries on its own instead of
     leaving the flat fallback in place for the whole visit. */
  const [categoryRetry, setCategoryRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    getMenuCategories()
      .then((rows) => {
        if (cancelled) return;
        // Identical tree ⇒ keep the old array; nothing needs re-rendering.
        setCategories((current) =>
          JSON.stringify(current) === JSON.stringify(rows) ? current : rows,
        );
      })
      .catch(() => {
        if (cancelled) return;
        // Keep whatever is on screen (fallback or the last good tree); try
        // again shortly instead of giving up for the rest of the visit.
        setCategories((current) => current ?? []);
        retryTimer = setTimeout(() => {
          if (!cancelled) setCategoryRetry((count) => count + 1);
        }, 10_000);
      });

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
    // `menu` is a fresh array on every menu reload — that is the trigger.
  }, [menu, categoryRetry]);

  /* The filter narrows the menu BEFORE the sections are built, so a folder
     only ever holds dishes the guest can order under the active diet. */
  const visibleMenu = useMemo(() => menu.filter((item) => matchesDiet(item, diet)), [menu, diet]);
  const matches = useMemo(() => searchMenu(visibleMenu, query), [visibleMenu, query]);
  const sections = useMemo(
    () => buildMenuSections(visibleMenu, categories),
    [visibleMenu, categories],
  );

  /* The grid has no indentation to show nesting, so a child folder carries its
     parent's name as a small line above its own — the hierarchy survives the
     flat layout. Sections arrive depth-first, so a stack of the last section
     seen at each depth is enough. */
  const folders = useMemo(() => {
    const ancestors: (string | undefined)[] = [];
    return sections.map((section) => {
      ancestors.length = section.depth;
      const parentName = section.depth > 0 ? ancestors[section.depth - 1] : undefined;
      ancestors[section.depth] = section.name;
      return { section, parentName };
    });
  }, [sections]);

  const searching = query.trim().length > 0;

  return (
    <div className="flex flex-col gap-7">
      {/* Sticky so search and the diet filter stay reachable while the guest
          scrolls a long menu. The offset is `--diner-nav-h`, published by the
          navbar's ResizeObserver, so the two bands dock together instead of
          the search sliding under the header.

          z-30, deliberately ABOVE the dish cards' own z-20: a card scrolling
          past sits later in the DOM, so at equal z-index it painted over the
          search box and the diet tabs. The band still sits under the nav
          (z-40), so every layer has exactly one job. */}
      <div
        className={cn(
          "sticky z-30 -mx-1 rounded-lg bg-canvas/90 px-1 py-1.5 backdrop-blur-md",
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
        key={searching ? "search" : `decks:${diet}`}
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
              <StageHeading
                title={`${matches.length} ${matches.length === 1 ? "dish" : "dishes"} match “${query.trim()}”`}
                description="Swipe right to add, left to skip — or use the buttons."
              />
              <DishDeck
                /* Remount only when the RESULT SET changes; availability and
                   price changes are reconciled inside the deck instead, so an
                   86 does not reset the pile (docs/14 #25). */
                key={`search:${matches.map((item) => item.id).join(",")}`}
                items={matches}
                quantities={quantities}
                pendingItemId={pendingItemId}
                itemErrors={itemErrors}
                onAdd={onAdd}
                sizes={DECK_SIZES}
                className={cn("w-full", DECK_MAX)}
              />
            </section>
          )
        ) : (
          <div className="flex flex-col gap-9">
            <StageHeading
              title="Today’s menu"
              description={`${visibleMenu.length} ${
                visibleMenu.length === 1 ? "dish" : "dishes"
              } in ${sections.length} ${sections.length === 1 ? "folder" : "folders"} · pick a deck, then swipe right to add, left to skip.`}
            />

            {/* One folder, one deck. Phone 1-up, tablet 2-up; then the cart
                aside appears at `lg` and takes 21rem out of the menu column,
                so a laptop drops back to a single deck (a 584px column split
                in two gave 280px cards, too cramped) and only reaches two
                across from `xl`. Each deck is capped at 400px in every case. */}
            <ul className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {folders.map(({ section, parentName }) => (
                <li key={section.id} className="min-w-0">
                  <DishDeck
                    /* Remount when the folder's dish set changes (86'ing,
                       re-filtering), so the deck always starts where it should. */
                    key={`${section.id}:${diet}:${section.items.map((item) => item.id).join(",")}`}
                    items={section.items}
                    quantities={quantities}
                    pendingItemId={pendingItemId}
                    itemErrors={itemErrors}
                    onAdd={onAdd}
                    label={section.name}
                    eyebrow={parentName}
                    sizes={DECK_SIZES}
                    className={cn("w-full", DECK_MAX)}
                  />
                </li>
              ))}
            </ul>
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
