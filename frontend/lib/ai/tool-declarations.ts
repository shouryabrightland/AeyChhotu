/* Gemini function declarations for Chhotu.

   IMPORTANT: no tool takes a `table_token`. The table is bound in
   `ChhotuRuntime` from the URL the diner is already on, so neither the model
   nor a prompt-injected message can point a cart write at another table.

   `user_name` is accepted on `add_to_cart` only for schema compatibility with
   the product brief; the executor always attributes the line to the guest on
   this device. */

import { Type, type FunctionDeclaration, type Schema } from "@google/genai";

const dietEnum = ["any", "vegetarian", "non_vegetarian", "jain", "vegan"];

function fn(
  name: string,
  description: string,
  properties: Record<string, Schema> = {},
  required: string[] = [],
): FunctionDeclaration {
  /* A no-arg tool omits `parameters` entirely, and `required` is only sent
     when non-empty: some Gemini schema validators reject empty arrays. */
  const hasProperties = Object.keys(properties).length > 0;
  return {
    name,
    description,
    ...(hasProperties
      ? {
          parameters: {
            type: Type.OBJECT,
            properties,
            ...(required.length > 0 ? { required } : {}),
          },
        }
      : {}),
  };
}

const dish = (description: string): Schema => ({ type: Type.STRING, description });
const dishList = (description: string): Schema => ({
  type: Type.ARRAY,
  items: { type: Type.STRING },
  description,
});
const money = (description: string): Schema => ({ type: Type.NUMBER, description });
const quantity: Schema = {
  type: Type.INTEGER,
  description: "Whole number of portions, 1–99. Defaults to 1.",
};

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  fn(
    "get_menu",
    "List dishes from the live menu this table can see. Use for browsing or when the guest asks what is available.",
    {
      category: dish("Optional category filter, e.g. 'Starters', 'Main Course', 'Drinks'."),
      query: dish("Optional free-text search over dish name, description and category."),
      vegetarian: { type: Type.BOOLEAN, description: "When true, return vegetarian dishes only." },
      max_price: money("Optional maximum price per dish, in rupees."),
    },
  ),
  fn(
    "get_dish_details",
    "Get the full record for one dish: price, description, availability, ingredients, spice level, portion, diet tags and declared allergens. Use before answering any allergen question or comparing dishes.",
    { dish: dish("Dish name as the guest said it, or an exact menu item id.") },
    ["dish"],
  ),
  fn(
    "recommend_dishes",
    "Return 2–4 live dishes matching the guest's mood, diet, spice tolerance, budget or party size. The tool filters the real menu; you write the explanation.",
    {
      query: dish("What the guest wants, e.g. 'light and creamy', 'something for four'."),
      diet: { type: Type.STRING, enum: dietEnum, description: "Dietary preference. Defaults to 'any'." },
      spice_level: {
        type: Type.INTEGER,
        description: "Maximum heat tolerated: 0 mild, 1 medium, 2 hot, 3 very hot.",
      },
      max_price_per_person: money("Optional budget per person, in rupees."),
      party_size: { type: Type.INTEGER, description: "Optional number of guests sharing." },
    },
  ),
  fn(
    "compare_dishes",
    "Compare two or more dishes side by side: price, portion, ingredients, spice, diet tags and allergens.",
    { dishes: dishList("Dish names or ids, at least two.") },
    ["dishes"],
  ),
  fn("get_cart", "Read the shared table cart: every line, who added it, notes, allergy notes and totals."),
  fn(
    "add_to_cart",
    "Add a dish to the shared table cart. The line is attributed automatically to the guest on this device. Include any medical allergy the guest stated in allergy_note, word for word.",
    {
      item: dish("Dish name as the guest said it, or its exact id."),
      quantity,
      allergy_note: dish("Medical allergy to print in red on the kitchen ticket, e.g. 'No peanuts'. Omit if none."),
      request_note: dish("Normal kitchen request, e.g. 'extra chutney'. Omit if none."),
      user_name: dish("Ignored for attribution; the guest's own name is used."),
    },
    ["item"],
  ),
  fn(
    "update_cart_item",
    "Change the quantity or notes of a dish already in the shared cart. The guest's own line is preferred when a dish has several note variants.",
    {
      item: dish("Dish name or exact id."),
      quantity: { type: Type.INTEGER, description: "Set the line to this quantity (1–99)." },
      quantity_delta: { type: Type.INTEGER, description: "Relative change, e.g. +2 or -1. Never 0." },
      request_note: dish("New kitchen request."),
      allergy_note: dish("New medical allergy note."),
    },
    ["item"],
  ),
  fn(
    "remove_from_cart",
    "Remove a dish from the shared cart entirely.",
    { item: dish("Dish name or exact id.") },
    ["item"],
  ),
  fn(
    "clear_cart",
    "Empty the shared table cart. Destructive: only call after the guest explicitly confirms in a previous message.",
  ),
  fn(
    "review_and_fire_order",
    "Send the whole cart to the kitchen as ONE ticket. Irreversible and it starts cooking: only call after the guest explicitly confirms the summary in a previous message.",
  ),
  fn("get_order_status", "Current kitchen state for this table: latest ticket, status, denial reason and elapsed time."),
  fn("get_estimated_wait_time", "Estimate how long the food will take, based on this table's open tickets and staged cart."),
  fn(
    "request_bill",
    "Ask the floor for the bill and return the split by who added each dish. Only call after the guest explicitly confirms in a previous message.",
  ),
  fn(
    "check_allergy_safety",
    "Screen dishes against a guest's reported allergies using the kitchen's metadata. This NEVER certifies a dish as safe; it reports contains / may contain / not listed / not recorded plus a staff-confirmation caveat.",
    {
      dishes: dishList("Dish names or ids to screen."),
      reported_allergies: dishList("The guest's allergies in their own words, e.g. ['peanuts', 'dairy']."),
    },
    ["dishes", "reported_allergies"],
  ),
];
