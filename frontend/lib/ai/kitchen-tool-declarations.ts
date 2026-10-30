/* Function declarations for the kitchen's voice assistant.

   This surface WANTS writes (unlike the manager console, which is read-only):
   the chef is standing and the whole point is cooking without touching the
   screen. Safety comes from three places instead of from withholding tools:

   1. The credential is a kitchen shift token bound by the api-client, never a
      model-supplied argument.
   2. Every write goes through the same board calls the UI uses, so the SQL
      state machine still decides what is legal (one lane at a time, Ready to
      serve, explicit refusal reason).
   3. `deny_ticket` and marking a dish unavailable do not execute directly:
      they park an action that only `confirm_action` can run, after the chef
      said yes out loud.

   Tickets are addressed by TABLE CODE, because that is what a cook says
   ("table four is ready") — an order uuid is not something anyone speaks. */

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

const table = (description: string): Schema => ({ type: Type.STRING, description });
const flag = (description: string): Schema => ({ type: Type.BOOLEAN, description });

export const KITCHEN_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  fn(
    "get_board_overview",
    "One-line state of the kitchen board: how many tickets are pending, preparing and ready, which tables are waiting, and the age of the oldest ticket. Use at the start of a shift, or when the chef asks 'what's on the board'.",
  ),
  fn(
    "list_tickets",
    "The actual tickets, with table code, age in minutes, every line with its quantity, special requests and ALLERGY notes. Use for 'what's pending', 'what am I cooking', 'read me table 4'.",
    {
      status: {
        type: Type.STRING,
        enum: ["pending", "preparing", "ready"],
        description: "Only this lane. Leave empty for every active ticket.",
      },
      table: table("Only this table's ticket, e.g. '4' or 'T04'. Leave empty for all."),
    },
  ),
  fn(
    "get_menu_status",
    "Look up the catalogue: whether a dish is available or 86, its category, allergens and ingredients, plus every dish currently marked 86. Use for 'is paneer tikka available', 'kya 86 hai', 'what's run out'.",
    {
      dish: table("The dish the cook named, e.g. 'masala dosa'. Leave empty to list the menu."),
      only_unavailable: flag("true to list only the dishes that are 86."),
    },
  ),
  fn(
    "get_waiter_requests",
    "Which READY tables have pinged a waiter ('I'll serve this' on the floor board), with how many minutes they have waited. Use for 'konsi table waiter maang rahi hai'.",
  ),
  fn(
    "refresh_board",
    "Re-read the kitchen board from the server. Use when the cook says the screen looks stale, or after a change that should have appeared.",
  ),
  fn(
    "move_ticket",
    "Move a table's ticket forward: pending → preparing, preparing → ready. Cannot skip a lane and cannot serve — use serve_ticket for that.",
    {
      table: table("The table code the chef said, e.g. '4', 'T04' or 'table 4'."),
      status: {
        type: Type.STRING,
        enum: ["preparing", "ready"],
        description: "The lane to move it to.",
      },
    },
    ["table", "status"],
  ),
  fn(
    "serve_ticket",
    "Hand the food over: closes a READY ticket as served (this is also what records the sale). Only valid from the Ready lane.",
    { table: table("The table code the chef said.") },
    ["table"],
  ),
  fn(
    "deny_ticket",
    "Refuse a ticket because the dish ran out or cannot be made. Needs a short reason the guest will read. Does NOT run immediately: it asks the chef to confirm out loud, then confirm_action performs it.",
    {
      table: table("The table code the chef said."),
      reason: table("Short reason the diner will see, e.g. 'paneer is over'."),
    },
    ["table", "reason"],
  ),
  fn(
    "set_dish_availability",
    "Mark a dish unavailable (86) or available again. Marking unavailable waits for the chef's spoken confirmation via confirm_action; putting a dish back in stock runs immediately.",
    {
      dish: table("The dish name the chef said, e.g. 'malai kofta'."),
      available: flag("false to 86 the dish, true to put it back on the menu."),
    },
    ["dish", "available"],
  ),
  fn(
    "confirm_action",
    "Run or cancel the destructive action that is waiting for confirmation. Call this ONLY after the chef answered the confirmation question. Pass true only for a clear yes.",
    { confirm: flag("true when the chef said yes; false for no, cancel or stop.") },
    ["confirm"],
  ),
  fn(
    "start_shift",
    "Arm this terminal's shift: enables the new-ticket chime and registers the device. Use when the chef says the shift is starting.",
  ),
];
