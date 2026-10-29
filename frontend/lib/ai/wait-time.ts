/* Kitchen wait estimate for Chhotu.

   The database has no serving timestamps and no kitchen-capacity signal, so
   this is explicitly an ESTIMATE built from what the diner's own screen can
   see: the table's active tickets, their dish counts, and anything staged in
   the cart. The copy handed back to the model says so, so it never promises a
   time the kitchen did not give. */

import { estimateArrival } from "@/lib/diner/tracker";
import type { CartLine, MenuItem, Order } from "@/lib/api/types";

export interface WaitEstimate {
  minutes: number;
  /** Open tickets counted in the estimate (this table's only). */
  tickets: number;
  items_in_kitchen: number;
  items_in_cart: number;
  basis: string;
}

export function estimateWaitTime(
  orders: Order[],
  cart: CartLine[],
  _menu: MenuItem[],
): WaitEstimate {
  const arrival = estimateArrival(orders);
  const cartItems = cart.reduce((total, line) => total + line.quantity, 0);

  /* Nothing is cooking yet: the honest answer is a prep window for what is in
     the cart, not "0 minutes". A served round with no new ticket means the
     next round has not started either. */
  const hasActive = arrival.items > 0;
  const minutes = hasActive
    ? arrival.minutes + (cartItems > 0 ? 2 : 0)
    : cartItems > 0
      ? 8 + cartItems
      : 6;

  const basis = hasActive
    ? `${arrival.tickets} open ${arrival.tickets === 1 ? "ticket" : "tickets"} with ${arrival.items} ${arrival.items === 1 ? "dish" : "dishes"} in the kitchen${cartItems > 0 ? `, plus ${cartItems} staged in the cart` : ""}.`
    : cartItems > 0
      ? `Nothing is cooking yet; ${cartItems} ${cartItems === 1 ? "item is" : "items are"} staged in the cart.`
      : "Nothing is in the kitchen for this table right now.";

  return {
    minutes,
    tickets: arrival.tickets,
    items_in_kitchen: arrival.items,
    items_in_cart: cartItems,
    basis: `${basis} This is a kitchen-pace estimate, not a promise.`,
  };
}
