/* Function declarations for the manager console's assistant.
 *
 * Every one is a READ. There is deliberately no "clear table", "archive dish"
 * or "change price" tool: the console's writes stay behind buttons a human
 * presses, and the admin JWT is the strongest credential in the product.
 *
 * No tool takes a token or a scope — the credential is attached by the
 * api-client inside `AdminRuntime`. */

import { Type, type FunctionDeclaration, type Schema } from "@google/genai";

function fn(
  name: string,
  description: string,
  properties: Record<string, Schema> = {},
  required: string[] = [],
): FunctionDeclaration {
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

const whole = (description: string): Schema => ({ type: Type.INTEGER, description });
const flag = (description: string): Schema => ({ type: Type.BOOLEAN, description });

export const ADMIN_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  fn(
    "get_daily_sales_summary",
    "Today's revenue, orders served, items sold and average ticket, with yesterday and the last 7 days for comparison. Revenue counts served tickets only.",
  ),
  fn(
    "get_best_selling_dishes",
    "Rank dishes by units sold and revenue over a window. Use for 'what sold best', 'top three today', 'what is popular this week'.",
    {
      limit: whole("How many dishes to return, 1–20. Defaults to 5."),
      days: whole("Window in days, 1–90. 1 = today, 7 = this week. Defaults to 1."),
    },
  ),
  fn(
    "get_pending_orders",
    "Every ticket the kitchen still owns (pending, preparing, ready), with table, total and how many minutes old it is.",
  ),
  fn(
    "get_table_occupancy",
    "How many tables are seated vs free right now, plus per-table devices, guests and open tickets. Use for 'which tables are free'.",
    {
      only_free: flag("When true, return only tables with no open session."),
      only_occupied: flag("When true, return only tables with an open session."),
    },
  ),
  fn(
    "get_inventory_status",
    "Stock state for every live dish: count, threshold and out / low / ok / untracked. `untracked` means no count is kept — never read it as zero.",
    { low_only: flag("When true, return only dishes that are out or at/below threshold.") },
  ),
  fn(
    "get_low_stock_items",
    "Only the dishes that are out of stock or at/below their low-stock threshold, worst first.",
  ),
  fn(
    "get_guest_feedback",
    "The most recent guest ratings (1–5) and comments, with the average. Empty means nobody has rated yet — do not invent themes.",
    { limit: whole("How many recent ratings to read, 1–50. Defaults to 10.") },
  ),
];
