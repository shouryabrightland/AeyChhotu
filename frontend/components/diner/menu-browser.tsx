"use client";

import { ArrowLeft, Search } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { DishCard } from "@/components/diner/dish-card";
import { DishDeck } from "@/components/diner/dish-deck";
import { DiscoveryCard } from "@/components/diner/discovery-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import type { MenuItem } from "@/lib/api/types";
import { DIET_FILTERS, matchesDiet, type DietFilter } from "@/lib/diner/diet";
import { buildMenuAtlas, searchMenu } from "@/lib/diner/menu-atlas";
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

/* Search is a filter over the whole menu rather than a place you navigate to,
   so it is deliberately not a stage: clearing the query puts the guest back
   exactly where they were. */
type Stage =
  | { level: "cuisines" }
  | { level: "categories"; cuisineId: string }
  | { level: "dishes"; cuisineId: string; categoryName: string | null };

/* The menu, opened the way a menu opens: a few broad menus first, then the
   sections inside one, then the dishes themselves.

   Every level is derived from the dishes the API already sent — the cuisines
   are a presentation layer (lib/diner/menu-atlas) and the sections inside
   them are the backend's own category strings. Search stays as the secondary
   way in for a guest who already knows what they want. */
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
  const [stage, setStage] = useState<Stage>({ level: "cuisines" });
  // One diet at a time, with "All" as an explicit choice — see lib/diner/diet.
  const [diet, setDiet] = useState<DietFilter>("all");

  /* The filter narrows the menu BEFORE the atlas is built, so a cuisine card
     and its count only ever describe dishes the guest can order under the
     active diet. Changing the filter returns to the top, because the level
     the guest was standing on may no longer exist. */
  const visibleMenu = useMemo(() => menu.filter((item) => matchesDiet(item, diet)), [menu, diet]);
  const atlas = useMemo(() => buildMenuAtlas(visibleMenu), [visibleMenu]);
  const matches = useMemo(() => searchMenu(visibleMenu, query), [visibleMenu, query]);

  function chooseDiet(next: DietFilter) {
    setDiet(next);
    setStage({ level: "cuisines" });
  }

  const searching = query.trim().length > 0;
  const cuisines = atlas.cuisines;
  const activeCuisine =
    stage.level === "categories" || stage.level === "dishes"
      ? (cuisines.find((cuisine) => cuisine.id === stage.cuisineId) ?? null)
      : null;
  const activeCategory =
    stage.level === "dishes" && stage.categoryName
      ? (activeCuisine?.categories.find((category) => category.name === stage.categoryName) ?? null)
      : null;

  /* When the backend's vocabulary is unknown, the atlas collapses to a single
     group and the root stage leads with the real categories instead — the two
     levels survive, they just start one rung lower. */
  const rootCuisine = atlas.grouped ? null : (cuisines[0] ?? null);
  const dishes = activeCategory
    ? activeCategory.items
    : (activeCuisine?.categories.flatMap((category) => category.items) ?? []);

  const stageKey = searching
    ? `search:${diet}`
    : stage.level === "cuisines"
      ? `cuisines:${diet}`
      : stage.level === "categories"
        ? `categories:${diet}:${stage.cuisineId}`
        : `dishes:${diet}:${stage.cuisineId}:${stage.categoryName ?? "all"}`;

  function selectCuisine(cuisineId: string, categoryName: string | null) {
    // A cuisine with one section goes straight to its dishes: a level that
    // only ever holds a single card is friction, not discovery.
    setStage(
      categoryName === null
        ? { level: "categories", cuisineId }
        : { level: "dishes", cuisineId, categoryName },
    );
  }

  function goBack() {
    setStage(
      stage.level === "dishes" && stage.categoryName && activeCuisine && !activeCuisine.singleCategory
        ? { level: "categories", cuisineId: stage.cuisineId }
        : { level: "cuisines" },
    );
  }

  return (
    <div className="flex flex-col gap-7">
      {/* Sticky so search and the diet filter stay reachable while the guest
          scrolls a long section. The offset is `--diner-nav-h`, published by
          the navbar's ResizeObserver, so the two bands dock together instead
          of the search sliding under the header.

          ONE row, not two: on a 320px phone a labelled search above a
          bordered filter strip measured ~124px of permanently-stuck chrome.
          Search + chips side by side is 60px, which keeps the sticky band
          under the 90px budget and gives the menu the screen back. */}
      <div
        className={cn(
          "sticky z-20 -mx-1 rounded-lg bg-canvas/90 px-1 py-1.5 backdrop-blur-md",
          stickyTopClass,
        )}
      >
        <div className="flex items-center gap-2">
          <Input
            // The label is the placeholder here: a visible label row on a
            // phone costs 20px of permanently-stuck height. The accessible
            // name is kept on the control itself.
            aria-label="Ready to order?"
            placeholder="Ready to order? Dosa, biryani, chai…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            leadingIcon={<Search className="size-4" aria-hidden />}
            containerClassName="min-w-0 flex-1"
          />

          {/* Diet is the only axis worth a persistent control here: it maps
              to a real question at an Indian table. Scrolls sideways rather
              than wrapping, so the sticky bar never grows taller. */}
          <div
            role="group"
            aria-label="Filter dishes by diet"
            className="hide-scrollbar flex h-12 shrink-0 items-center gap-1 overflow-x-auto rounded-md border border-line-strong bg-surface p-1"
          >
            {DIET_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => chooseDiet(option.id)}
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
        key={stageKey}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionBase}
        className="flex flex-col gap-7"
      >
        {/* Path + way back. Two ways out of any level, so nobody gets lost. */}
        {searching ? null : (
          <div className="flex flex-wrap items-center gap-3">
            {/* One way up, one trail. The arrow is the control a thumb
                reaches for; the trail says where you are. */}
            {stage.level === "cuisines" ? null : (
              <IconButton
                label={
                  activeCategory && activeCuisine && !activeCuisine.singleCategory
                    ? `Back to all ${activeCuisine.name}`
                    : atlas.grouped
                      ? "Back to all menus"
                      : "Back to the full menu"
                }
                size="sm"
                tone="outline"
                onClick={goBack}
              >
                <ArrowLeft className="size-4" aria-hidden />
              </IconButton>
            )}

            <nav
              aria-label="Where you are in the menu"
              className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-subtle"
            >
              <button
                type="button"
                onClick={() => setStage({ level: "cuisines" })}
                className="cursor-pointer rounded-sm transition-colors duration-[var(--duration-fast)] hover:text-ember"
              >
                {atlas.grouped ? "All menus" : "Full menu"}
              </button>
              {atlas.grouped && activeCuisine ? (
                <>
                  <span aria-hidden>/</span>
                  <button
                    type="button"
                    onClick={goBack}
                    className="cursor-pointer rounded-sm transition-colors duration-[var(--duration-fast)] hover:text-ember"
                  >
                    {activeCuisine.name}
                  </button>
                </>
              ) : null}
              {/* Skip the section crumb when it repeats the menu's own name:
                  a single-section cuisine would otherwise read
                  "South Indian / South Indian". */}
              {activeCategory && activeCategory.name !== activeCuisine?.name ? (
                <>
                  <span aria-hidden>/</span>
                  <span className="text-ink">{activeCategory.name}</span>
                </>
              ) : null}
            </nav>
          </div>
        )}

        {!searching && visibleMenu.length === 0 ? (
          <EmptyState
            title="Nothing on the menu fits that"
            description="No dish is tagged for this diet yet. Try another filter."
            action={
              <Button variant="soft" size="md" onClick={() => chooseDiet("all")}>
                Show everything
              </Button>
            }
          />
        ) : searching ? (
          matches.length === 0 ? (
            <EmptyState
              title="Nothing matches that"
              description="Try another dish, or clear the search to browse the menus."
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
        ) : stage.level === "cuisines" ? (
          atlas.grouped ? (
            <section className="flex flex-col gap-5">
              <StageHeading
                title="What are you in the mood for?"
                description="Pick a menu, then the section you want."
              />
              <div className="grid gap-5 sm:grid-cols-2">
                {cuisines.map((cuisine) => {
                  // Every cuisine the atlas builds has at least one dish; the
                  // guard is here so the type is honest, not because it fires.
                  const dish = cuisine.categories[0]?.items[0];
                  if (!dish) return null;

                  return (
                    <DiscoveryCard
                      key={cuisine.id}
                      name={cuisine.name}
                      tagline={cuisine.tagline}
                      itemCount={cuisine.itemCount}
                      representative={dish}
                      onSelect={() =>
                        selectCuisine(
                          cuisine.id,
                          cuisine.singleCategory ? (cuisine.categories[0]?.name ?? null) : null,
                        )
                      }
                    />
                  );
                })}
              </div>
            </section>
          ) : (
            <section className="flex flex-col gap-5">
              <StageHeading title="Sections" description="Everything the kitchen is serving today." />
              <div className="grid gap-5 sm:grid-cols-2">
                {(rootCuisine?.categories ?? []).map((category) => {
                  const dish = category.items[0];
                  if (!dish) return null;

                  return (
                    <DiscoveryCard
                      key={category.name}
                      name={category.name}
                      itemCount={category.items.length}
                      representative={dish}
                      variant="category"
                      onSelect={() =>
                        setStage({
                          level: "dishes",
                          cuisineId: rootCuisine?.id ?? "",
                          categoryName: category.name,
                        })
                      }
                    />
                  );
                })}
              </div>
            </section>
          )
        ) : stage.level === "categories" && activeCuisine ? (
          <section className="flex flex-col gap-5">
            <StageHeading
              title={activeCuisine.name}
              description={activeCuisine.tagline}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              {activeCuisine.categories.map((category) => {
                const dish = category.items[0];
                if (!dish) return null;

                return (
                  <DiscoveryCard
                    key={category.name}
                    name={category.name}
                    itemCount={category.items.length}
                    representative={dish}
                    variant="category"
                    onSelect={() =>
                      setStage({
                        level: "dishes",
                        cuisineId: activeCuisine.id,
                        categoryName: category.name,
                      })
                    }
                  />
                );
              })}
            </div>
            <Button
              variant="soft"
              size="md"
              className="self-start"
              onClick={() =>
                setStage({ level: "dishes", cuisineId: activeCuisine.id, categoryName: null })
              }
            >
              See everything in {activeCuisine.name}
            </Button>
          </section>
        ) : (
          <section className="flex flex-col gap-5">
            <StageHeading
              title={activeCategory?.name ?? (activeCuisine?.name ?? "The menu")}
              description={
                activeCategory
                  ? `${activeCategory.items.length} ${
                      activeCategory.items.length === 1 ? "dish" : "dishes"
                    } the kitchen is serving.`
                  : "Every section of this menu, in one run."
              }
            />

            {dishes.length === 0 ? (
              <EmptyState
                title="Nothing in this section yet"
                description="The kitchen has not stocked it under this filter. Try another section."
              />
            ) : (
              <DishDeck
                key={stageKey}
                items={dishes}
                quantities={quantities}
                pendingItemId={pendingItemId}
                itemErrors={itemErrors}
                onAdd={onAdd}
                stageLabel={activeCategory?.name ?? (activeCuisine?.name ?? "this section")}
                cartItemCount={cartItemCount}
                onReview={onReview}
                className="mx-auto w-full max-w-xl"
              />
            )}
          </section>
        )}
      </motion.div>
    </div>
  );
}

function StageHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="relative flex flex-col gap-2 border-b border-line pb-4">
      <h2 className="font-display text-heading text-ink">{title}</h2>
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
