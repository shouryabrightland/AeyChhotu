/* Allergy screening against the kitchen's own metadata (sql/015).

   This is a WARNING TOOL, not a medical clearance. It can only report what the
   recipe lists; it can never say a dish is safe, because shared equipment,
   substitutions and kitchen practice are outside the data. Every result
   carries that caveat, and `status: "not_listed"` means "none of your terms
   appear", not "allergen-free". */

import type { MenuItem } from "@/lib/api/types";
import { normalizeDishName } from "./dish-search";

export type AllergyStatus = "contains" | "may_contain" | "not_recorded" | "not_listed";

export interface AllergyScan {
  dish: string;
  status: AllergyStatus;
  /** Ingredient/allergen words that matched the guest's terms. */
  matches: string[];
}

/** Always shown with a scan. Deliberately not softened. */
export const ALLERGY_CAVEAT =
  "Recipe data is kitchen-maintained, not a medical guarantee. Our kitchen uses shared equipment, so please confirm with staff before ordering.";

/* Guest vocabulary → the words a recipe might use. Keys are normalized. */
const SYNONYMS: Record<string, string[]> = {
  dairy: ["dairy", "milk", "butter", "cream", "paneer", "cheese", "yogurt", "curd", "khoya", "ghee", "raita", "lassi"],
  milk: ["milk", "dairy", "butter", "cream", "paneer", "cheese", "yogurt", "khoya", "ghee"],
  gluten: ["gluten", "flour", "wheat", "naan", "roti", "bread", "bun", "bhature", "noodles", "samosa", "paratha", "pastry"],
  wheat: ["wheat", "flour", "naan", "roti", "bread", "bun", "paratha"],
  nut: ["nuts", "nut", "almond", "cashew", "pistachio", "walnut", "peanut", "groundnut"],
  nuts: ["nuts", "nut", "almond", "cashew", "pistachio", "walnut", "peanut", "groundnut"],
  /* Peanut is a legume: a peanut allergy must not be matched by a generic
     "nuts" ingredient tag, and vice versa. The guest's words are kept exact
     enough that neither direction produces a false "contains". */
  peanut: ["peanut", "groundnut"],
  peanuts: ["peanut", "groundnut"],
  tree_nut: ["almond", "cashew", "pistachio", "walnut", "nuts"],
  soy: ["soy", "soya", "tofu"],
  soya: ["soy", "soya", "tofu"],
  egg: ["egg", "mayonnaise", "mayo"],
  coconut: ["coconut"],
  fish: ["fish", "salmon", "tuna", "seafood"],
  seafood: ["fish", "prawn", "shrimp", "crab", "lobster", "seafood"],
  shellfish: ["shellfish", "prawn", "shrimp", "crab", "lobster"],
  sesame: ["sesame", "til"],
  mustard: ["mustard"],
};

function singular(value: string): string {
  return value.length > 3 && value.endsWith("s") && !value.endsWith("ss") ? value.slice(0, -1) : value;
}

/* Token equality, not substring: "peanuts" must not match the allergen tag
   "nuts" just because the letters appear inside the word. */
function containsTerm(haystack: string, term: string): boolean {
  const words = new Set(normalizeDishName(haystack).split(" ").filter(Boolean).map(singular));
  return normalizeDishName(term)
    .split(" ")
    .filter(Boolean)
    .map(singular)
    .some((token) => words.has(token));
}

function termsFor(allergy: string): string[] {
  const key = normalizeDishName(allergy).replace(/\s+/g, "_");
  if (!key) return [];
  const base = normalizeDishName(allergy);
  return [...new Set([base, singular(base), ...(SYNONYMS[key] ?? []), ...(SYNONYMS[base] ?? [])])].filter(Boolean);
}

/** True when the dish has no metadata at all for ingredients/allergens. */
export function hasRecordedMetadata(dish: MenuItem): boolean {
  return Boolean(dish.ingredients?.length || dish.allergens?.length);
}

/* Screens one dish. `contains` = the recipe lists a matching ingredient or
   declared allergen. `may_contain` = the word only appears in the prose
   description/name. Both are warnings; neither is a clearance. */
export function scanDishAllergies(dish: MenuItem, allergies: string[]): AllergyScan {
  const wanted = allergies.flatMap((allergy) =>
    termsFor(allergy).map((term) => ({ original: allergy.trim(), term })),
  );

  if (wanted.length === 0) {
    return { dish: dish.name, status: "not_recorded", matches: [] };
  }

  if (!hasRecordedMetadata(dish)) {
    return { dish: dish.name, status: "not_recorded", matches: [] };
  }

  const ingredientWords = (dish.ingredients ?? []).map(normalizeDishName);
  const allergenWords = (dish.allergens ?? []).map(normalizeDishName);
  const description = `${dish.name} ${dish.description}`;

  const contains = new Set<string>();
  const maybe = new Set<string>();

  for (const { original, term } of wanted) {
    const normalized = normalizeDishName(term);
    if (!normalized) continue;

    const inAllergens = allergenWords.some((word) => containsTerm(word, normalized));
    const inIngredients = ingredientWords.some((word) => containsTerm(word, normalized));
    if (inAllergens || inIngredients) {
      contains.add(original);
      continue;
    }
    if (containsTerm(description, normalized)) maybe.add(original);
  }

  if (contains.size > 0) {
    return { dish: dish.name, status: "contains", matches: [...contains] };
  }
  if (maybe.size > 0) {
    return { dish: dish.name, status: "may_contain", matches: [...maybe] };
  }
  return { dish: dish.name, status: "not_listed", matches: [] };
}
