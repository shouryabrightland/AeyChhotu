/* Deterministic dish recommendations for the assistant.

   The model does the talking, but it does not get to invent the shortlist:
   filtering happens here, over the live menu, with explicit diet/spice/budget
   rules. That keeps recommendations reproducible, cheap (no nested LLM call)
   and impossible to satisfy with an unavailable dish. */

import type { MenuItem } from "@/lib/api/types";
import { normalizeDishName } from "./dish-search";

export type DietPreference = "any" | "vegetarian" | "non_vegetarian" | "jain" | "vegan";

export interface RecommendCriteria {
  query?: string;
  diet?: DietPreference;
  /** Upper bound on heat: 0 mild … 3 very hot. */
  spice_level?: number;
  /** Budget for one person, in rupees. */
  max_price_per_person?: number;
  party_size?: number;
}

export function matchesDiet(item: MenuItem, diet: DietPreference): boolean {
  if (diet === "vegetarian") return item.vegetarian;
  if (diet === "non_vegetarian") return !item.vegetarian;
  if (diet === "jain") return (item.diet_tags ?? []).includes("jain");
  if (diet === "vegan") return (item.diet_tags ?? []).includes("vegan");
  return true;
}

function queryScore(item: MenuItem, query: string): number {
  const q = normalizeDishName(query);
  if (!q) return 0;

  const name = normalizeDishName(item.name);
  if (name.includes(q)) return 4;

  const words = q.split(" ").filter(Boolean);
  const haystack = normalizeDishName(`${item.name} ${item.category} ${item.description}`);
  return words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
}

/** Up to `limit` live, available dishes, best fit first. */
export function recommendDishes(menu: MenuItem[], criteria: RecommendCriteria, limit = 4): MenuItem[] {
  const diet = criteria.diet ?? "any";
  const maxSpice = criteria.spice_level;
  const budget = criteria.max_price_per_person;

  return menu
    .filter((item) => item.is_available)
    .filter((item) => matchesDiet(item, diet))
    .filter((item) => (maxSpice === undefined ? true : (item.spice_level ?? 0) <= maxSpice))
    .filter((item) => (budget === undefined ? true : item.price <= budget))
    .map((item) => ({ item, score: queryScore(item, criteria.query ?? "") }))
    .sort((left, right) => right.score - left.score || left.item.price - right.item.price)
    .slice(0, limit)
    .map((entry) => entry.item);
}
