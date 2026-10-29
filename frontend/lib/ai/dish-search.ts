/* Fuzzy dish resolution for voice and chat.

   Guests say "butter paneer", "dosa", "the burger" — never the exact catalog
   name. The model is told to pass the guest's words through unchanged; this
   module maps them onto the LIVE menu and, when several dishes are plausible,
   returns the candidates so Chhotu can ask instead of guessing.

   Pure and dependency-free so it can be unit-tested without a browser. */

import type { MenuItem } from "@/lib/api/types";

/** Lower-case, punctuation-free, whitespace-collapsed. */
export function normalizeDishName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeDishName(value).split(" ").filter(Boolean);
}

/** Cheap singular fold: "dosas" → "dosa", "naans" → "naan". */
function singular(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** Token equality with one typo tolerated on longer words. */
function tokenMatches(query: string, candidate: string): boolean {
  const left = singular(query);
  const right = singular(candidate);
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4) {
    return levenshtein(left, right) <= Math.min(2, Math.floor(Math.min(left.length, right.length) / 3));
  }
  return false;
}

/** 0–100, where 100 is an exact normalized name. */
function score(query: string, name: string): number {
  const q = normalizeDishName(query);
  const n = normalizeDishName(name);
  if (!q || !n) return 0;
  if (q === n) return 100;

  const queryTokens = tokens(q).map(singular);
  const nameTokens = tokens(n).map(singular);
  const matched = queryTokens.filter((token) => nameTokens.some((other) => tokenMatches(token, other)));

  if (matched.length === queryTokens.length && queryTokens.length > 0) {
    return 72 + (queryTokens.length / Math.max(nameTokens.length, 1)) * 18;
  }

  if (n.includes(q) || q.includes(n)) {
    return 66 + (Math.min(q.length, n.length) / Math.max(q.length, n.length)) * 10;
  }

  const ratio = matched.length / Math.max(queryTokens.length, nameTokens.length);
  const similarity = 1 - levenshtein(q, n) / Math.max(q.length, n.length);
  return Math.max(ratio * 55, similarity * 45);
}

export interface DishLookup {
  item: MenuItem | null;
  /** Close alternatives, best first; non-empty when `item` is null. */
  candidates: MenuItem[];
}

/* Resolve one spoken/typed dish against what this table can order.

   Live UUIDs always win. A name that several dishes share ("paneer") is
   returned as ambiguous rather than silently picking the first — picking the
   wrong dish on a voice command is exactly the kind of mistake the guest
   cannot see. */
export function findDish(menu: MenuItem[], query: string): DishLookup {
  const raw = query.trim();
  if (!raw) return { item: null, candidates: [] };

  const byId = menu.find((item) => item.id === raw);
  if (byId) return { item: byId, candidates: [] };

  const ranked = menu
    .map((item) => ({ item, score: score(raw, item.name) }))
    .filter((entry) => entry.score >= 45)
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name));

  const best = ranked[0];
  if (!best) return { item: null, candidates: [] };

  // Exact name: nothing to ask about.
  if (best.score >= 100) return { item: best.item, candidates: [] };

  const close = ranked.filter((entry) => entry.score >= best.score - 10 && entry.score >= 55);
  if (close.length > 1) {
    return { item: null, candidates: close.slice(0, 4).map((entry) => entry.item) };
  }

  return { item: best.item, candidates: [] };
}

/** Free-text search over name/description/category (get_menu's `query`). */
export function searchDishes(menu: MenuItem[], query: string, limit = 30): MenuItem[] {
  const q = normalizeDishName(query);
  if (!q) return menu.slice(0, limit);

  const queryTokens = tokens(q).map(singular);
  const ranked = menu
    .map((item) => {
      const haystackName = normalizeDishName(item.name);
      const haystack = normalizeDishName(`${item.name} ${item.category} ${item.description}`);
      const nameTokens = tokens(item.name).map(singular);
      const allTokens = tokens(haystack).map(singular);

      const nameHits = queryTokens.filter((token) => nameTokens.some((other) => tokenMatches(token, other)));
      const hits = queryTokens.filter((token) => allTokens.some((other) => tokenMatches(token, other)));
      const nameScore = haystackName.includes(q) ? 3 : nameHits.length;
      const score = nameScore * 10 + hits.length;

      return { item, score };
    })
    .filter((entry) => entry.score >= queryTokens.length || normalizeDishName(entry.item.name).includes(q))
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name));

  return ranked.slice(0, limit).map((entry) => entry.item);
}
