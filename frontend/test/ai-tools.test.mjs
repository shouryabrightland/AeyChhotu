import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Chhotu's tools run in the BROWSER, so their tests live here rather than in
   backend/test: they exercise the same executors the sheet uses, against a
   fake `ChhotuRuntime` that records the API calls. No Gemini key, no network,
   no database.

   The behaviours pinned here are the ones a language model can get wrong:
   dish resolution, argument coercion, allergy notes surviving to the cart,
   sold-out rejection, the one-round-at-a-time rule and the ambiguous-line rule. */

import { findDish, searchDishes } from "../lib/ai/dish-search.ts";
import { ALLERGY_CAVEAT, scanDishAllergies } from "../lib/ai/allergy.ts";
import { matchesDiet, recommendDishes } from "../lib/ai/recommend.ts";
import { executeTool } from "../lib/ai/tools.ts";
import { estimateWaitTime } from "../lib/ai/wait-time.ts";

function dish(overrides) {
  return {
    id: "id-default",
    name: "Dish",
    price: 100,
    category: "Main Course",
    is_available: true,
    description: "",
    vegetarian: true,
    ingredients: [],
    spice_level: 0,
    allergens: [],
    diet_tags: [],
    portion_description: "",
    ...overrides,
  };
}

const DOSA = dish({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Masala Dosa",
  price: 180,
  description: "Crisp rice crepe, potato masala, coconut chutney.",
  ingredients: ["rice", "urad dal", "potato", "mustard seeds", "curry leaves", "coconut"],
  spice_level: 1,
  allergens: ["coconut"],
  portion_description: "1 dosa with chutney",
});

const PANEER = dish({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Paneer Butter Masala",
  price: 320,
  description: "Paneer in a slow-cooked tomato and cashew gravy.",
  ingredients: ["paneer", "tomato", "cashew", "butter", "cream", "spices"],
  spice_level: 1,
  allergens: ["dairy", "nuts"],
  portion_description: "serves 1–2",
});

const BIRYANI = dish({
  id: "33333333-3333-4333-8333-333333333333",
  name: "Hyderabadi Biryani",
  price: 380,
  description: "Dum-cooked basmati, saffron, fried onions, raita.",
  vegetarian: false,
  ingredients: ["basmati rice", "chicken", "yogurt", "saffron", "fried onions"],
  spice_level: 3,
  allergens: ["dairy"],
  portion_description: "serves 1",
});

const ROTI = dish({
  id: "44444444-4444-4444-8444-444444444444",
  name: "Tandoori Roti",
  price: 60,
  category: "Breads",
  description: "Whole wheat roti straight off the tandoor.",
  ingredients: ["whole wheat flour", "water", "salt"],
  spice_level: 0,
  allergens: ["gluten"],
  diet_tags: ["jain"],
  portion_description: "1 roti",
});

const PAKORA = dish({
  id: "55555555-5555-4555-8555-555555555555",
  name: "Onion Pakora",
  price: 160,
  category: "Starters",
  description: "Crisp gram-flour fritters with mint chutney.",
  ingredients: ["gram flour", "onion", "oil", "mint chutney"],
  spice_level: 2,
  portion_description: "serves 1",
});

const NO_METADATA = dish({
  id: "66666666-6666-4666-8666-666666666666",
  name: "Mystery Curry",
  price: 210,
  description: "Chef's special.",
});

const MENU = [DOSA, PANEER, BIRYANI, ROTI, PAKORA, NO_METADATA];

function makeRuntime(overrides = {}) {
  const calls = { add: [], update: [], remove: [], fire: 0, bill: 0, refresh: 0 };

  const runtime = {
    userName: "Amit",
    menu: MENU,
    cart: [],
    orders: [],
    billStatus: "unrequested",
    addCartItem: async (input) => {
      calls.add.push(input);
      return { id: "line-new", ...input, total_table_quantity: input.quantity };
    },
    updateCartItem: async (id, patch) => {
      calls.update.push({ id, patch });
      return { id, ...patch };
    },
    removeCartItem: async (id) => {
      calls.remove.push(id);
      return { id, message: "Line item purged from table cart." };
    },
    fireOrder: async () => {
      calls.fire += 1;
      return {
        order_id: "order-1",
        table_id: "table-1",
        status: "pending",
        created_at: "2026-10-29T12:00:00Z",
        message: "Order successfully routed to KDS line.",
      };
    },
    requestBill: async () => {
      calls.bill += 1;
      return {
        table_id: "table-1",
        bill_status: "requested",
        bill_requested_at: "2026-10-29T12:05:00Z",
      };
    },
    refresh: async () => {
      calls.refresh += 1;
    },
    now: () => Date.parse("2026-10-29T12:10:00Z"),
    ...overrides,
  };

  return { runtime, calls };
}

describe("fuzzy dish matching", () => {
  it("maps a loose phrase onto the real catalog name", () => {
    const found = findDish(MENU, "butter paneer");
    assert.equal(found.item?.name, "Paneer Butter Masala");
  });

  it("accepts an exact id and an exact name", () => {
    assert.equal(findDish(MENU, PANEER.id).item?.name, "Paneer Butter Masala");
    assert.equal(findDish(MENU, "masala dosa").item?.name, "Masala Dosa");
    assert.equal(findDish(MENU, "Butter Naan").item, null);
  });

  it("asks instead of guessing when several dishes share a word", () => {
    const found = findDish(
      [PANEER, { ...PANEER, id: "77777777-7777-4777-8777-777777777777", name: "Palak Paneer" }],
      "paneer",
    );
    assert.equal(found.item, null);
    assert.ok(found.candidates.length >= 1);
    assert.ok(found.candidates.every((item) => item.name.toLowerCase().includes("paneer")));
  });

  it("searches name, category and description", () => {
    assert.deepEqual(searchDishes(MENU, "crepe").map((item) => item.name), ["Masala Dosa"]);
    assert.deepEqual(searchDishes(MENU, "breads").map((item) => item.name), ["Tandoori Roti"]);
  });
});

describe("allergy screening", () => {
  it("reports a declared allergen as contains and always carries the caveat", () => {
    const scan = scanDishAllergies(PANEER, ["dairy"]);
    assert.equal(scan.status, "contains");
    assert.deepEqual(scan.matches, ["dairy"]);
    assert.match(ALLERGY_CAVEAT, /not a medical guarantee/i);
  });

  it("matches a family word against ingredient words (nuts → cashew)", () => {
    assert.equal(scanDishAllergies(PANEER, ["nuts"]).status, "contains");
    assert.equal(scanDishAllergies(ROTI, ["gluten"]).status, "contains");
  });

  it("never claims a dish is safe: an absent term is not_listed, not safe", () => {
    const scan = scanDishAllergies(PANEER, ["peanuts"]);
    assert.equal(scan.status, "not_listed");
    assert.deepEqual(scan.matches, []);
  });

  it("says metadata is missing instead of implying the dish is clean", () => {
    assert.equal(scanDishAllergies(NO_METADATA, ["dairy"]).status, "not_recorded");
  });
});

describe("recommend_dishes", () => {
  it("filters by diet, price and spice tolerance", () => {
    const picks = recommendDishes(MENU, {
      diet: "vegetarian",
      max_price_per_person: 200,
      spice_level: 1,
    });
    const names = picks.map((item) => item.name);
    assert.ok(names.includes("Masala Dosa"));
    assert.ok(names.includes("Tandoori Roti"));
    assert.ok(!names.includes("Hyderabadi Biryani"));
    assert.ok(!names.includes("Onion Pakora")); // spice 2 > 1
    assert.ok(picks.every((item) => item.price <= 200));
  });

  it("honours the jain tag", () => {
    assert.equal(matchesDiet(ROTI, "jain"), true);
    assert.equal(matchesDiet(DOSA, "jain"), false);
  });

  it("never returns an 86'd dish", () => {
    const picks = recommendDishes([{ ...DOSA, is_available: false }], { diet: "any" });
    assert.deepEqual(picks, []);
  });

  it("hands the sheet the matching dishes so it can show their photos", async () => {
    const { runtime } = makeRuntime();
    const result = await executeTool("recommend_dishes", { diet: "vegetarian" }, runtime);

    const card = result.actions.find((action) => (action.dishes ?? []).length > 0);
    assert.ok(card, "a recommendation must carry dishes, not just a label");
    assert.ok(card.dishes.every((dish) => typeof dish.name === "string" && typeof dish.price === "number"));
    // The card carries a real catalogue item, which is what DishPhoto resolves.
    assert.ok(card.dishes.some((dish) => dish.id === DOSA.id));
  });
});

describe("tool argument parsing", () => {
  it("coerces a numeric string and attributes the line to the device guest", async () => {
    const { runtime, calls } = makeRuntime();
    const result = await executeTool("add_to_cart", { item: "masala dosa", quantity: "2" }, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(calls.add.length, 1);
    assert.equal(calls.add[0].menu_item_id, DOSA.id);
    assert.equal(calls.add[0].quantity, 2);
    assert.equal(calls.add[0].added_by, "Amit");
    assert.equal(result.mutated, true);
  });

  it("rejects an out-of-range quantity and a missing dish", async () => {
    const { runtime, calls } = makeRuntime();

    const zero = await executeTool("add_to_cart", { item: "masala dosa", quantity: 0 }, runtime);
    assert.equal(zero.response.ok, false);
    assert.equal(zero.response.error.code, "VALIDATION_ERROR");

    const missing = await executeTool("add_to_cart", {}, runtime);
    assert.equal(missing.response.ok, false);
    assert.equal(calls.add.length, 0);
  });

  it("refuses an ambiguous dish instead of adding the wrong one", async () => {
    const { runtime, calls } = makeRuntime({ menu: [PANEER, { ...PANEER, id: "other", name: "Palak Paneer" }] });
    const result = await executeTool("add_to_cart", { item: "paneer" }, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "AMBIGUOUS_ITEM");
    assert.equal(calls.add.length, 0);
  });

  it("keeps a medical allergy note on the cart line", async () => {
    const { runtime, calls } = makeRuntime();
    const result = await executeTool(
      "add_to_cart",
      { item: "paneer butter masala", quantity: 1, allergy_note: "No peanuts", request_note: "less spicy" },
      runtime,
    );

    assert.equal(result.response.ok, true);
    assert.equal(calls.add[0].allergy_note, "No peanuts");
    assert.equal(calls.add[0].request_note, "less spicy");
    assert.equal(result.actions[0].label, "Added 1× Paneer Butter Masala (allergy: No peanuts, less spicy) to the table cart");
  });

  it("keeps the cart fresh within the same turn", async () => {
    const { runtime } = makeRuntime();
    await executeTool("add_to_cart", { item: "masala dosa", quantity: 2 }, runtime);

    const cart = await executeTool("get_cart", {}, runtime);
    assert.equal(cart.response.data.item_count, 2);
    assert.equal(cart.response.data.total, 360);
  });

  it("rejects an 86'd dish before touching the cart API", async () => {
    const { runtime, calls } = makeRuntime({ menu: [{ ...DOSA, is_available: false }] });
    const result = await executeTool("add_to_cart", { item: "masala dosa" }, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "ITEM_UNAVAILABLE");
    assert.equal(calls.add.length, 0);
    assert.equal(result.actions[0].ok, false);
  });

  it("requires a name before it can attribute a cart line", async () => {
    const { runtime, calls } = makeRuntime({ userName: "   " });
    const result = await executeTool("add_to_cart", { item: "masala dosa" }, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "NAME_REQUIRED");
    assert.equal(calls.add.length, 0);
  });
});

describe("cart line selection", () => {
  const amitLine = {
    id: "cart-amit",
    table_id: "table-1",
    menu_item_id: PANEER.id,
    quantity: 1,
    request_note: "",
    allergy_note: "",
    added_by: "Amit",
  };
  const raviLine = { ...amitLine, id: "cart-ravi", added_by: "Ravi", allergy_note: "No dairy" };

  it("prefers this guest's own line when a dish appears twice", async () => {
    const { runtime, calls } = makeRuntime({ cart: [raviLine, amitLine] });
    const result = await executeTool("update_cart_item", { item: "paneer butter masala", quantity_delta: 1 }, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(calls.update[0].id, "cart-amit");
    assert.equal(calls.update[0].patch.quantity_delta, 1);
  });

  it("asks which line when the guest owns both", async () => {
    const second = { ...amitLine, id: "cart-amit-2", request_note: "less spicy" };
    const { runtime, calls } = makeRuntime({ cart: [amitLine, second] });
    const result = await executeTool("remove_from_cart", { item: "paneer butter masala" }, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "AMBIGUOUS_CART_LINE");
    assert.equal(result.response.error.candidates.length, 2);
    assert.equal(calls.remove.length, 0);
  });

  it("removes a single matching line", async () => {
    const { runtime, calls } = makeRuntime({ cart: [amitLine] });
    const result = await executeTool("remove_from_cart", { item: "paneer butter masala" }, runtime);

    assert.equal(result.response.ok, true);
    assert.deepEqual(calls.remove, ["cart-amit"]);
    assert.equal(result.mutated, true);
  });

  it("clears every line and reports the count", async () => {
    const { runtime, calls } = makeRuntime({ cart: [amitLine, raviLine] });
    const result = await executeTool("clear_cart", {}, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.removed, 2);
    assert.deepEqual(calls.remove, ["cart-amit", "cart-ravi"]);
  });
});

describe("order and bill operations", () => {
  const line = {
    id: "cart-1",
    table_id: "table-1",
    menu_item_id: DOSA.id,
    quantity: 2,
    request_note: "",
    allergy_note: "No peanuts",
    added_by: "Amit",
  };

  it("fires the cart through the runtime and reports one ticket", async () => {
    const { runtime, calls } = makeRuntime({ cart: [line] });
    const result = await executeTool("review_and_fire_order", {}, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(calls.fire, 1);
    assert.equal(result.response.data.item_count, 2);
    assert.equal(result.mutated, true);
  });

  it("refuses a second round while one is with the kitchen, and keeps the cart", async () => {
    const { runtime, calls } = makeRuntime({
      cart: [line],
      orders: [
        {
          id: "order-live",
          table_id: "table-1",
          table_code: "k7x2p",
          status: "preparing",
          created_at: "2026-10-29T11:00:00Z",
          updated_at: "2026-10-29T11:05:00Z",
          items: [],
        },
      ],
    });

    const result = await executeTool("review_and_fire_order", {}, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "ORDER_IN_PROGRESS");
    assert.match(result.response.error.message, /one order goes to the kitchen at a time/i);
    assert.match(result.response.error.message, /safe in the table cart/i);
    assert.equal(result.response.error.active_order.status, "preparing");
    assert.equal(result.response.error.cart_lines, 1);
    assert.equal(calls.fire, 0);
    assert.equal(runtime.cart.length, 1);
    assert.equal(result.mutated, false);
  });

  it("fires again once the previous round is closed", async () => {
    const { runtime, calls } = makeRuntime({
      cart: [line],
      orders: [
        {
          id: "order-done",
          table_id: "table-1",
          table_code: "k7x2p",
          status: "served",
          created_at: "2026-10-29T10:00:00Z",
          updated_at: "2026-10-29T10:30:00Z",
          items: [],
        },
      ],
    });

    const result = await executeTool("review_and_fire_order", {}, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(calls.fire, 1);
    assert.equal(result.mutated, true);
  });

  it("turns a duplicate order from the server into the one-round rule, with no mutation", async () => {
    const { runtime } = makeRuntime({
      cart: [line],
      fireOrder: async () => {
        throw Object.assign(new Error("Order already sent"), {
          error: "DUPLICATE_ORDER",
          status: 409,
        });
      },
    });
    const result = await executeTool("review_and_fire_order", {}, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "ORDER_IN_PROGRESS");
    assert.match(result.response.error.message, /safe in the table cart/i);
    assert.equal(result.response.error.cart_lines, 1);
    assert.equal(result.mutated, false);
  });

  it("tells the guest that an open round blocks the next fire", async () => {
    const { runtime } = makeRuntime({
      cart: [line],
      orders: [
        {
          id: "order-ready",
          table_id: "table-1",
          table_code: "k7x2p",
          status: "ready",
          created_at: "2026-10-29T11:00:00Z",
          updated_at: "2026-10-29T11:10:00Z",
          items: [],
        },
      ],
    });

    const result = await executeTool("get_order_status", {}, runtime);

    assert.equal(result.response.ok, true);
    assert.match(result.response.data.next_round_note, /stay in the cart/i);
  });

  it("treats an inventory failure as a mutation (the server purged sold-out lines)", async () => {
    const { runtime } = makeRuntime({
      cart: [line],
      fireOrder: async () => {
        throw Object.assign(new Error("Paneer Butter Masala has sold out. Cart updated."), {
          error: "INVENTORY_FAILURE",
          soldOut: ["Paneer Butter Masala"],
        });
      },
    });
    const result = await executeTool("review_and_fire_order", {}, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "INVENTORY_FAILURE");
    assert.deepEqual(result.response.error.sold_out, ["Paneer Butter Masala"]);
    assert.equal(result.mutated, true);
  });

  it("refuses to fire an empty cart", async () => {
    const { runtime, calls } = makeRuntime();
    const result = await executeTool("review_and_fire_order", {}, runtime);

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "EMPTY_CART");
    assert.equal(calls.fire, 0);
  });

  it("requests the bill once and returns the split by guest", async () => {
    const { runtime, calls } = makeRuntime({ cart: [line] });
    const result = await executeTool("request_bill", {}, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(calls.bill, 1);
    assert.deepEqual(result.response.data.splits, { Amit: 360 });
  });

  it("does not re-request a bill that is already requested", async () => {
    const { runtime, calls } = makeRuntime({ cart: [line], billStatus: "requested" });
    const result = await executeTool("request_bill", {}, runtime);

    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.already_requested, true);
    assert.equal(calls.bill, 0);
  });

  it("returns the latest ticket with elapsed minutes and denial reason", async () => {
    const { runtime } = makeRuntime({
      orders: [
        {
          id: "order-denied",
          table_id: "table-1",
          table_code: "k7x2p",
          status: "denied",
          created_at: "2026-10-29T11:00:00Z",
          updated_at: "2026-10-29T11:05:00Z",
          denial_reason: "Item Masala Dosa went out of stock",
          items: [],
        },
        {
          id: "order-live",
          table_id: "table-1",
          table_code: "k7x2p",
          status: "preparing",
          created_at: "2026-10-29T12:05:00Z",
          updated_at: "2026-10-29T12:06:00Z",
          items: [
            {
              id: "item-1",
              order_id: "order-live",
              menu_item_id: DOSA.id,
              name: "Masala Dosa",
              price: 180,
              quantity: 2,
              request_note: "",
              allergy_note: "No peanuts",
              added_by: "Amit",
            },
          ],
        },
      ],
    });

    const result = await executeTool("get_order_status", {}, runtime);
    assert.equal(result.response.data.order.order_id, "order-live");
    assert.equal(result.response.data.order.status, "preparing");
    assert.equal(result.response.data.order.elapsed_minutes, 5);
    assert.equal(result.response.data.order.items[0].allergy_note, "No peanuts");
  });
});

describe("check_allergy_safety tool", () => {
  it("returns warnings, never a clearance", async () => {
    const { runtime } = makeRuntime();
    const result = await executeTool(
      "check_allergy_safety",
      { dishes: ["paneer butter masala", "tandoori roti"], reported_allergies: ["nuts"] },
      runtime,
    );

    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.can_confirm_safe, false);
    assert.match(result.response.data.caveat, /not a medical guarantee/i);

    const [paneer, roti] = result.response.data.results;
    assert.equal(paneer.status, "contains");
    assert.equal(roti.status, "not_listed");
  });

  it("requires the guest's allergy list", async () => {
    const { runtime } = makeRuntime();
    const result = await executeTool(
      "check_allergy_safety",
      { dishes: ["masala dosa"], reported_allergies: [] },
      runtime,
    );

    assert.equal(result.response.ok, false);
    assert.equal(result.response.error.code, "VALIDATION_ERROR");
  });
});

describe("dish details and comparison", () => {
  it("exposes metadata and flags an unrecorded recipe", async () => {
    const { runtime } = makeRuntime();

    const dosa = await executeTool("get_dish_details", { dish: "masala dosa" }, runtime);
    assert.equal(dosa.response.data.dish.portion, "1 dosa with chutney");
    assert.equal(dosa.response.data.dish.metadata_recorded, true);

    const mystery = await executeTool("get_dish_details", { dish: "mystery curry" }, runtime);
    assert.equal(mystery.response.data.dish.metadata_recorded, false);
    assert.match(mystery.response.data.metadata_note, /has not recorded/i);
  });

  it("compares prices and keeps missing dishes out", async () => {
    const { runtime } = makeRuntime();
    const result = await executeTool(
      "compare_dishes",
      { dishes: ["masala dosa", "paneer butter masala", "butter naan"] },
      runtime,
    );

    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.cheapest, "Masala Dosa");
    assert.equal(result.response.data.priciest, "Paneer Butter Masala");
    assert.deepEqual(result.response.data.not_found, ["butter naan"]);
  });
});

describe("wait time", () => {
  it("estimates from open tickets and staged cart, and says it is an estimate", () => {
    const cartLine = {
      id: "cart-1",
      table_id: "table-1",
      menu_item_id: DOSA.id,
      quantity: 2,
      request_note: "",
      allergy_note: "",
      added_by: "Amit",
    };
    const estimate = estimateWaitTime([], [cartLine], MENU);

    assert.equal(estimate.items_in_cart, 2);
    assert.ok(estimate.minutes > 0);
    assert.match(estimate.basis, /estimate, not a promise/i);
  });
});

