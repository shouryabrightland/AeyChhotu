import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The console assistant's catalogue tool. Pure executor, fake runtime: the
   point is that a spoken question about ingredients is answered from the
   kitchen's records — never from the model's imagination. */

import { executeAdminTool } from "../lib/ai/admin-tools.ts";

function dish(overrides = {}) {
  return {
    menu_item_id: "dish-1",
    name: "Paneer Butter Masala",
    category: "Main Course",
    price: 320,
    description: "Cottage cheese in a tomato-cashew gravy.",
    vegetarian: true,
    spice_level: 2,
    ingredients: ["paneer", "tomato", "cashew", "butter", "cream"],
    allergens: ["dairy", "tree nuts"],
    diet_tags: ["vegetarian"],
    portion_description: "1 bowl, serves one",
    is_available: true,
    stock_quantity: 12,
    low_stock_threshold: 5,
    ...overrides,
  };
}

function makeRuntime(items) {
  return {
    salesSummary: async () => {
      throw new Error("not used");
    },
    bestSelling: async () => [],
    pendingOrders: async () => [],
    occupancy: async () => ({ total: 0, occupied: 0, free: 0, tables: [] }),
    inventory: async () => ({ tracked: 0, untracked: 0, out: 0, low: 0, items: [] }),
    feedback: async () => [],
    catalog: async () => items,
  };
}

describe("console catalogue tool", () => {
  it("returns ingredients and allergens for a named dish", async () => {
    const runtime = makeRuntime([dish()]);
    const result = await executeAdminTool("get_menu_catalog", { query: "paneer butter" }, runtime);

    assert.equal(result.response.ok, true);
    const items = result.response.data.items;
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].ingredients, ["paneer", "tomato", "cashew", "butter", "cream"]);
    assert.deepEqual(items[0].allergens, ["dairy", "tree nuts"]);
  });

  it("finds every dish containing an allergen", async () => {
    const runtime = makeRuntime([
      dish(),
      dish({ menu_item_id: "dish-2", name: "Peanut Chutney", ingredients: ["peanut"], allergens: ["peanuts"] }),
    ]);

    const result = await executeAdminTool("get_menu_catalog", { query: "peanut" }, runtime);
    assert.equal(result.response.data.count, 1);
    assert.equal(result.response.data.items[0].name, "Peanut Chutney");
  });

  it("filters by category and availability together", async () => {
    const runtime = makeRuntime([
      dish(),
      dish({ menu_item_id: "dish-2", name: "Masala Chai", category: "Beverages", is_available: false }),
    ]);

    const result = await executeAdminTool(
      "get_menu_catalog",
      { category: "beverages", available_only: true },
      runtime,
    );

    assert.equal(result.response.data.count, 0);
    assert.match(result.response.data.note, /nothing/i);
  });

  it("says the catalogue does not match instead of inventing a dish", async () => {
    const runtime = makeRuntime([dish()]);
    const result = await executeAdminTool("get_menu_catalog", { query: "sushi" }, runtime);

    assert.equal(result.response.data.count, 0);
    assert.match(result.response.data.note, /improvising/i);
  });

  it("gives every dish the labels the menu screen shows", async () => {
    const runtime = makeRuntime([
      dish(),
      dish({
        menu_item_id: "dish-2",
        name: "Tandoori Roti",
        vegetarian: false,
        diet_tags: ["jain"],
        is_available: false,
      }),
    ]);

    const result = await executeAdminTool("get_menu_catalog", {}, runtime);
    const items = result.response.data.items;

    assert.deepEqual(items[0].labels, ["veg"]);
    assert.deepEqual(items[1].labels, ["non-veg", "jain", "86"]);
    assert.deepEqual(result.response.data.labels_in_menu, ["86", "jain", "non-veg", "veg"]);
  });

  it("filters by a spoken diet label", async () => {
    const runtime = makeRuntime([
      dish(),
      dish({ menu_item_id: "dish-2", name: "Tandoori Roti", diet_tags: ["jain"] }),
      dish({ menu_item_id: "dish-3", name: "Chicken Curry", vegetarian: false, diet_tags: ["halal"] }),
    ]);

    const jain = await executeAdminTool("get_menu_catalog", { diet: "jain" }, runtime);
    assert.equal(jain.response.data.count, 1);
    assert.equal(jain.response.data.items[0].name, "Tandoori Roti");

    const nonVeg = await executeAdminTool("get_menu_catalog", { diet: "non-veg" }, runtime);
    assert.equal(nonVeg.response.data.count, 1);
    assert.equal(nonVeg.response.data.items[0].name, "Chicken Curry");

    const veg = await executeAdminTool("get_menu_catalog", { diet: "veg" }, runtime);
    assert.equal(veg.response.data.count, 2);
  });

  it("lists only the 86'd dishes on request", async () => {
    const runtime = makeRuntime([
      dish(),
      dish({ menu_item_id: "dish-2", name: "Masala Chai", is_available: false }),
    ]);

    const result = await executeAdminTool("get_menu_catalog", { only_86: true }, runtime);
    assert.equal(result.response.data.count, 1);
    assert.equal(result.response.data.items[0].name, "Masala Chai");
    assert.ok(result.response.data.items[0].labels.includes("86"));
  });

  it("never claims a dish is halal when the label is not recorded", async () => {
    const runtime = makeRuntime([dish()]);
    const result = await executeAdminTool("get_menu_catalog", { diet: "halal" }, runtime);

    assert.equal(result.response.data.count, 0);
    assert.match(result.response.data.note, /not recorded/i);
  });
});
