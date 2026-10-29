import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Dish metadata (sql/015) is what Chhotu's allergy screening and portion
   answers rely on, so the admin contract that writes it is validated here.
   The assistant's own tool tests live in frontend/test/ai-tools.test.mjs —
   those tools execute in the browser. */

import {
  adminCreateMenuItemSchema,
  adminUpdateMenuItemSchema,
} from "../src/validation/schemas.js";

describe("adminCreateMenuItemSchema metadata (sql/015)", () => {
  const base = {
    name: "Paneer Butter Masala",
    price: 320,
    description: "Paneer in tomato-cashew gravy.",
  };

  it("defaults every new field so older admin clients keep working", () => {
    const parsed = adminCreateMenuItemSchema.parse(base);
    assert.deepEqual(parsed.ingredients, []);
    assert.equal(parsed.spice_level, 0);
    assert.deepEqual(parsed.allergens, []);
    assert.deepEqual(parsed.diet_tags, []);
    assert.equal(parsed.portion_description, "");
  });

  it("accepts a full record and lower-cases allergen families", () => {
    const parsed = adminCreateMenuItemSchema.parse({
      ...base,
      ingredients: ["paneer", "cashew", "cream"],
      spice_level: 2,
      allergens: ["Dairy", "NUTS"],
      diet_tags: ["jain"],
      portion_description: "serves 1–2",
    });

    assert.deepEqual(parsed.allergens, ["dairy", "nuts"]);
    assert.equal(parsed.spice_level, 2);
    assert.deepEqual(parsed.ingredients, ["paneer", "cashew", "cream"]);
  });

  it("rejects a spice level outside 0–3 and an unknown diet tag", () => {
    assert.equal(adminCreateMenuItemSchema.safeParse({ ...base, spice_level: 4 }).success, false);
    assert.equal(adminCreateMenuItemSchema.safeParse({ ...base, spice_level: -1 }).success, false);
    assert.equal(adminCreateMenuItemSchema.safeParse({ ...base, spice_level: 1.5 }).success, false);
    assert.equal(
      adminCreateMenuItemSchema.safeParse({ ...base, diet_tags: ["gluten-free"] }).success,
      false,
    );
  });

  it("caps ingredient and portion lengths", () => {
    assert.equal(
      adminCreateMenuItemSchema.safeParse({ ...base, ingredients: ["x".repeat(81)] }).success,
      false,
    );
    assert.equal(
      adminCreateMenuItemSchema.safeParse({ ...base, portion_description: "x".repeat(81) }).success,
      false,
    );
  });
});

describe("adminUpdateMenuItemSchema metadata", () => {
  it("accepts a metadata-only patch", () => {
    const parsed = adminUpdateMenuItemSchema.parse({ ingredients: ["paneer"] });
    assert.deepEqual(parsed.ingredients, ["paneer"]);
    assert.equal(parsed.spice_level, undefined);
  });

  it("still refuses an empty patch", () => {
    assert.equal(adminUpdateMenuItemSchema.safeParse({}).success, false);
  });
});
