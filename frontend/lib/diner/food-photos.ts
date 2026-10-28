/* Dish imagery — a frontend-only presentation layer.

   The menu contract carries no image field and the database is not ours to
   change, so the photography is resolved here: a curated keyword map from the
   dish's own words (name, description, category) to a warm, plate-level photo,
   then a category-level photo, then a designed palette tile. Nothing in this
   file invents menu data — it only decides what a dish looks like.

   The photos are DOWNLOADED INTO THE APP (public/food) rather than hot-linked:
   a dish render must never depend on a third-party host being reachable, on
   its CDN allowing the Next optimiser, or on the same URL still existing next
   month. `npm run build` therefore ships them, and the optimiser only ever
   reads from disk. To swap a dish's photo, replace the file in public/food/;
   to add a dish the backend grows later, add a keyword line and it inherits
   the right picture. */

import type { MenuItem } from "@/lib/api/types";

/** Photos live in the app bundle, so a router push or an offline table never
    turns into a broken frame. */
const photo = (name: string) => `/food/${name}.jpg`;

/* Plate photos, named once and reused across the dish map below. */
const DOSA = photo("dosa");
const PANEER = photo("paneer");
const NOODLES = photo("noodles");
const BIRYANI = photo("biryani");
const TACO = photo("taco");
const BURGER = photo("burger");
const PAKORA = photo("pakora");
const NAAN = photo("naan");
const ROTI = photo("roti");
const LASSI = photo("lassi");
const CHAI = photo("chai");
const KULFI = photo("kulfi");

const BREAD_CAT = photo("bread");
const DRINK_CAT = photo("drink");
const DESSERT_CAT = photo("dessert");
const STARTER_CAT = photo("starter");
const MAIN_CAT = photo("main");

/* One photo per signature dish. Keys are matched as substrings against the
   dish's lowercased name + description + category, longest key first, so
   "paneer butter masala" wins over "paneer". */
export const DISH_PHOTOS: Record<string, string> = {
  /* South Indian */
  dosa: DOSA,
  idli: DOSA,
  vada: DOSA,
  uttapam: DOSA,
  pongal: DOSA,
  rasam: DOSA,
  sambar: DOSA,
  /* Indo-Chinese */
  noodles: NOODLES,
  hakka: NOODLES,
  chowmein: NOODLES,
  manchurian: NOODLES,
  schezwan: NOODLES,
  "spring roll": NOODLES,
  /* North Indian */
  "paneer butter masala": PANEER,
  "butter masala": PANEER,
  paneer: PANEER,
  tikka: PANEER,
  kofta: PANEER,
  curry: PANEER,
  naan: NAAN,
  kulcha: NAAN,
  roti: ROTI,
  paratha: ROTI,
  /* Biryani & Rice */
  biryani: BIRYANI,
  pulao: BIRYANI,
  "jeera rice": BIRYANI,
  "curd rice": BIRYANI,
  "lemon rice": BIRYANI,
  /* Starters */
  taco: TACO,
  burger: BURGER,
  pakora: PAKORA,
  samosa: PAKORA,
  chaat: PAKORA,
  fries: PAKORA,
  momo: STARTER_CAT,
  kebab: STARTER_CAT,
  /* Drinks & Desserts */
  "egg curry": CHAI,
  "egg fried rice": NOODLES,
  "egg dosa": DOSA,
  /* Drinks & Desserts */
  lassi: LASSI,
  chai: CHAI,
  coffee: CHAI,
  soda: DRINK_CAT,
  kulfi: KULFI,
  "filter coffee": CHAI,
  "fresh lime soda": DRINK_CAT,
  "gulab jamun": DESSERT_CAT,
  "mango falooda": DESSERT_CAT,
  "ice cream": KULFI,
  jamun: DESSERT_CAT,
  gulab: DESSERT_CAT,
  falooda: DESSERT_CAT,
  dal: PANEER,
  "dal makhani": PANEER,
  "veg biryani": BIRYANI,
  "chicken biryani": BIRYANI,
  "hyderabadi biryani": BIRYANI,
  "peas pulao": BIRYANI,
  "sweet lassi": LASSI,
  "masala chai": CHAI,
  "malai kulfi": KULFI,
};

/* The category net only comments on what the dish map missed. If it started to
   hand out photos for the seeded menu we would have put them in the dish map
   instead. */

/* Category-level photography: the safety net for any dish the map above does
   not know, so a growing backend menu is never photo-less. Keys include the
   section names the seed uses (lib/api/seed.ts) as well as the older generic
   ones, so both vocabularies resolve. */
const CATEGORY_PHOTOS: Record<string, string> = {
  bread: BREAD_CAT,
  drink: DRINK_CAT,
  beverage: DRINK_CAT,
  dessert: DESSERT_CAT,
  sweet: DESSERT_CAT,
  starter: STARTER_CAT,
  appetiser: STARTER_CAT,
  appetizer: STARTER_CAT,
  main: MAIN_CAT,
  rice: BIRYANI,
  "south indian": DOSA,
  "indo-chinese": NOODLES,
  "north indian": PANEER,
  "biryani & rice": BIRYANI,
  "drinks & desserts": DRINK_CAT,
  starters: STARTER_CAT,
};

/* The category net only comments on what the dish map missed. If it started to
   hand out photos for the seeded menu we would have put them in the dish map
   instead. */

const KEYS_BY_LENGTH = Object.keys(DISH_PHOTOS).sort((a, b) => b.length - a.length);

function haystack(item: Pick<MenuItem, "name" | "description" | "category">) {
  return `${item.name} ${item.description} ${item.category}`.toLowerCase();
}

/** The best photo for a dish, or null when the curated map has nothing. */
export function resolveDishPhoto(item: Pick<MenuItem, "name" | "description" | "category">) {
  const text = haystack(item);

  for (const key of KEYS_BY_LENGTH) {
    if (text.includes(key)) {
      const match = DISH_PHOTOS[key];
      if (match) return match;
    }
  }

  for (const [key, url] of Object.entries(CATEGORY_PHOTOS)) {
    if (text.includes(key)) return url;
  }

  return null;
}

/** Stable alt text: the photo is decoration next to the dish name, but a
    screen reader still deserves to know what the image is. */
export function dishPhotoAlt(item: Pick<MenuItem, "name">) {
  return `${item.name}, as served in the restaurant`;
}

/* ---- Fallback tile -------------------------------------------------------
   If the network is unavailable (the demo store runs offline on purpose) the
   optimiser request fails and the card falls back to this: a warm two-stop
   wash picked from the dish's own key, so two cards never look like a
   loading error and the palette never leaves the brand. */

const FALLBACK_WASHES = [
  "from-ember-soft via-beige to-tan/60",
  "from-beige via-sand to-tan/70",
  "from-sand via-beige to-ember-soft",
  "from-tan/50 via-beige to-cream",
] as const;

export function dishFallbackWash(item: Pick<MenuItem, "id" | "name">) {
  const seed = `${item.id}${item.name}`.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return FALLBACK_WASHES[seed % FALLBACK_WASHES.length] ?? FALLBACK_WASHES[0];
}
