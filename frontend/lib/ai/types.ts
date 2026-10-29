/* Shared types for Chhotu AI — the browser-side waiter.

   The tools run in the DINER'S BROWSER, not on the server. Gemini is called
   directly with the public key, and every mutation still goes through the
   existing REST API (add/update/remove cart, fire, bill) or, for reads, the
   live snapshot `useLiveTable` already holds. That keeps the DB invariants
   exactly where they were: `fire_order()` is still the only way an order is
   created, cart lines are still server-scoped to the table token, and the
   kitchen still owns availability.

   NOTHING here trusts a model-supplied table token: the table, the guest's
   name and the API calls are bound in `ChhotuRuntime`, so a prompt cannot
   retarget another table. */

import type { BillRequest, BillStatus, CartLineWithTotal, CartRemovalResult, FiredOrder } from "@/lib/api-client";
import type { CartLine, MenuItem, Order } from "@/lib/api/types";

/** A user-visible result of a tool run ("Added 2 Masala Dosa"). */
export interface ChhotuAction {
  kind: "cart" | "order" | "bill" | "info";
  label: string;
  ok: boolean;
}

/** The API surface a tool may use. Built by the sheet from `useLiveTable` +
 *  the api-client; a test passes a fake. */
export interface ChhotuRuntime {
  /** The guest at this device. Attribution is never model-supplied. */
  userName: string;
  menu: MenuItem[];
  cart: CartLine[];
  orders: Order[];
  billStatus: BillStatus;
  addCartItem(input: {
    menu_item_id: string;
    quantity: number;
    added_by: string;
    allergy_note?: string;
    request_note?: string;
  }): Promise<CartLineWithTotal>;
  updateCartItem(
    cartItemId: string,
    patch: {
      quantity?: number;
      quantity_delta?: number;
      request_note?: string;
      allergy_note?: string;
    },
  ): Promise<CartLineWithTotal>;
  removeCartItem(cartItemId: string): Promise<CartRemovalResult>;
  fireOrder(): Promise<FiredOrder>;
  requestBill(): Promise<BillRequest>;
  /** Re-read menu/cart/orders after a mutation (requirement #4). */
  refresh(): Promise<void>;
  /** Injectable clock so wait-time maths is testable. */
  now?: () => number;
}

/** One executed function call, ready to feed back to Gemini. */
export interface ToolExecution {
  /** Always a plain object: Gemini's functionResponse.response must be JSON. */
  response: Record<string, unknown>;
  /** What the sheet shows the guest as the tool runs/finishes. */
  actions: ChhotuAction[];
  /** True when a write happened, so the caller can refresh live state. */
  mutated: boolean;
}

/** The normalised error a tool reports instead of throwing. */
export interface ToolError {
  code: string;
  message: string;
  [key: string]: unknown;
}

/** One turn of the on-screen transcript (not the model history). */
export interface ChhotuMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  actions?: ChhotuAction[];
}
