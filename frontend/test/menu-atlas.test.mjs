import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/* Unit tests for the diner's presentation layer — the menu atlas that turns
   the API's flat category strings into cuisines, and the dish photo resolver.

   These two modules decide what a guest sees first, and they are the only
   place where a backend vocabulary change could quietly break the ordering
   flow, so they are pinned here rather than eyeballed in the browser. */

import { seedMenu } from "../lib/api/seed.ts";
import { buildMenuAtlas, searchMenu } from "../lib/diner/menu-atlas.ts";
import {
  DISH_PHOTOS,
  dishFallbackWash,
  resolveDishPhoto,
} from "../lib/diner/food-photos.ts";

const findByDish = (cuisines, dish) =>
  cuisines.find((cuisine) =>
    cuisine.categories.some((category) => category.items.some((item) => item.name === dish)),
  );

describe("buildMenuAtlas over the seeded menu", () => {
  const atlas = buildMenuAtlas(seedMenu);

  it("groups the real dishes into the menus a guest would recognise", () => {
    assert.deepEqual(
      atlas.cuisines.map((cuisine) => cuisine.name),
      [
        "South Indian",
        "Indo-Chinese",
        "North Indian",
        "Biryani & Rice",
        "Snacks & Starters",
        "Drinks & Desserts",
      ],
    );
    assert.equal(atlas.grouped, true);
  });

  it("files each dish under the right menu", () => {
    assert.equal(findByDish(atlas.cuisines, "Masala Dosa")?.id, "south-indian");
    assert.equal(findByDish(atlas.cuisines, "Veg Hakka Noodles")?.id, "chinese");
    assert.equal(findByDish(atlas.cuisines, "Paneer Butter Masala")?.id, "north-indian");
    assert.equal(findByDish(atlas.cuisines, "Garlic Naan")?.id, "north-indian");
    assert.equal(findByDish(atlas.cuisines, "Hyderabadi Biryani")?.id, "rice");
    assert.equal(findByDish(atlas.cuisines, "Onion Pakora")?.id, "snacks");
    assert.equal(findByDish(atlas.cuisines, "Masala Chai")?.id, "drinks-desserts");
    assert.equal(findByDish(atlas.cuisines, "Malai Kulfi")?.id, "drinks-desserts");
  });

  it("keeps the API's own category string as the section inside a menu", () => {
    const northIndian = atlas.cuisines.find((cuisine) => cuisine.id === "north-indian");
    assert.deepEqual(
      northIndian?.categories.map((category) => category.name),
      ["North Indian"],
    );
  });

  it("stocks every menu with enough dishes to browse", () => {
    for (const cuisine of atlas.cuisines) {
      assert.ok(cuisine.itemCount >= 6, `${cuisine.name} holds only ${cuisine.itemCount}`);
    }
  });

  it("counts what it actually holds, and loses nothing on the way", () => {
    const placed = atlas.cuisines.flatMap((cuisine) =>
      cuisine.categories.flatMap((category) => category.items),
    );
    assert.equal(placed.length, seedMenu.length);
    assert.deepEqual(
      [...new Set(placed.map((item) => item.id))].sort(),
      [...new Set(seedMenu.map((item) => item.id))].sort(),
    );
    for (const cuisine of atlas.cuisines) {
      assert.equal(
        cuisine.itemCount,
        cuisine.categories.reduce((sum, category) => sum + category.items.length, 0),
      );
    }
  });

  it("flags a menu whose whole content sits in one section", () => {
    // Every seeded cuisine is stocked as a single section, so opening it lands
    // on the dishes rather than on a one-card list of sections.
    for (const cuisine of atlas.cuisines) {
      assert.equal(cuisine.singleCategory, true, cuisine.name);
    }

    // A menu with two sections is the case the flag exists to catch.
    const split = buildMenuAtlas([
      { id: "a", name: "Paneer Butter Masala", price: 1, category: "Main Course", is_available: true, description: "", vegetarian: true },
      { id: "b", name: "Garlic Naan", price: 1, category: "Breads", is_available: true, description: "", vegetarian: true },
    ]);
    assert.equal(split.cuisines[0]?.singleCategory, false);
  });
});

describe("buildMenuAtlas degradation", () => {
  it("falls back to one honest group instead of dropping unknown dishes", () => {
    const unknown = [
      { id: "x1", name: "Mystery Plate", price: 100, category: "Chef's Table", is_available: true, description: "", vegetarian: true },
      { id: "x2", name: "Another Plate", price: 120, category: "Chef's Table", is_available: true, description: "", vegetarian: true },
    ];
    const atlas = buildMenuAtlas(unknown);

    assert.equal(atlas.grouped, false);
    assert.equal(atlas.cuisines.length, 1);
    assert.equal(atlas.cuisines[0]?.name, "From the kitchen");
    assert.equal(atlas.cuisines[0]?.itemCount, 2);
    // The real categories survive, so the two levels still exist.
    assert.deepEqual(
      atlas.cuisines[0]?.categories.map((category) => category.name),
      ["Chef's Table"],
    );
  });

  it("returns an empty atlas for an empty menu", () => {
    const atlas = buildMenuAtlas([]);
    assert.deepEqual(atlas.cuisines, []);
    assert.equal(atlas.grouped, false);
  });
});

describe("searchMenu", () => {
  it("matches a dish name", () => {
    assert.deepEqual(
      searchMenu(seedMenu, "dosa").map((item) => item.name),
      ["Masala Dosa", "Rava Dosa", "Egg Dosa"],
    );
  });

  it("matches a description or a category, case-insensitively", () => {
    // "Tandoori Roti" by name, "Garlic Naan" and "Chicken Tikka Masala" by
    // their descriptions.
    assert.deepEqual(
      searchMenu(seedMenu, "TANDOOR")
        .map((item) => item.name)
        .sort(),
      ["Chicken Tikka Masala", "Garlic Naan", "Tandoori Roti"],
    );
    assert.ok(searchMenu(seedMenu, "drinks").length >= 2);
  });

  it("returns everything for an empty query and nothing for a miss", () => {
    assert.equal(searchMenu(seedMenu, "   ").length, seedMenu.length);
    assert.deepEqual(searchMenu(seedMenu, "sushi"), []);
  });
});

describe("resolveDishPhoto", () => {
  it("prefers the dish's own photo over its category's", () => {
    const naan = seedMenu.find((item) => item.name === "Garlic Naan");
    assert.ok(naan);
    assert.equal(resolveDishPhoto(naan), DISH_PHOTOS.naan);
  });

  it("still photographs a dish the curated map has never heard of", () => {
    const invented = {
      name: "House Bread Basket",
      description: "Whatever came out of the oven",
      category: "Breads",
    };
    assert.ok(resolveDishPhoto(invented));
  });

  it("returns null rather than a wrong picture", () => {
    assert.equal(
      resolveDishPhoto({ name: "Zzz", description: "", category: "Zzz" }),
      null,
    );
  });

  it("only ever points at a photo shipped in public/food", () => {
    for (const url of Object.values(DISH_PHOTOS)) {
      assert.match(url, /^\/food\/[a-z]+\.jpg$/);
    }
  });

  it("every referenced photo file actually exists in public/food", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "food");
    for (const url of new Set(Object.values(DISH_PHOTOS))) {
      assert.ok(existsSync(join(dir, basename(url))), `missing photo file for ${url}`);
    }
  });
});

describe("dishFallbackWash", () => {
  it("is stable for a dish and always inside the palette ramp", () => {
    const dish = { id: "itm_dosa", name: "Masala Dosa" };
    assert.equal(dishFallbackWash(dish), dishFallbackWash(dish));
    assert.match(dishFallbackWash(dish), /^(from|via|to)-/);
  });
});
