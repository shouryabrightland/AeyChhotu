/* Tracker copy — the presentational layer of the live order tracker.

   None of this talks to the backend and none of it changes the order's real
   status, which always comes from the kitchen. The arrival estimate is a
   demo-only guess built from data the screen already holds (this table's open
   tickets and the lines on them). Everything here is read-only, minimal
   copy. */

import type { Order, OrderStatus } from "@/lib/api/types";

/* Quiet micro-status lines, one pool per real status so the copy can never
   contradict the kitchen. Rotated by the tracker every few seconds. */
export const ACTIVITY_LINES: Record<OrderStatus, string[]> = {
  pending: ["Queued at the pass", "Waiting for the line", "Next at the pass"],
  preparing: ["Cooking on the line", "Plating at the pass", "Final items on the line"],
  ready: ["Ready at the pass", "Runner inbound", "Leaving the pass"],
  served: ["Served", "Round complete"],
  // Refused, not cooked: the tracker shows a real explanation and the three
  // recovery actions, so this line is deliberately neutral rather than scary.
  denied: ["The kitchen could not take this round", "This round was not cooked"],
};

export interface ArrivalEstimate {
  /** Predicted minutes until the food reaches the table. */
  minutes: number;
  /** Active tickets the estimate is "based on" (this table + a mock ambient). */
  tickets: number;
  /** Quantity of dishes still in flight. */
  items: number;
}

const BASE_MINUTES = 2;
const MIN_MINUTES = 4;
const MAX_MINUTES = 40;

/* Small deterministic hash so the demo's ambient ticket count is stable for a
   given order instead of flickering on every render. */
function hash(value: string) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/* Demo-only: base preparation time + one minute per dish + two minutes per
   open ticket. A diner can only see this table's tickets, so a small ambient
   count stands in for the rest of the room. It is not a real kitchen
   algorithm — it only has to feel intelligent and move with the order. */
export function estimateArrival(orders: Order[]): ArrivalEstimate {
  // Neither a served nor a denied round is food still in flight.
  const active = orders.filter(
    (order) => order.status !== "served" && order.status !== "denied",
  );
  const items = active.reduce(
    (total, order) => total + order.items.reduce((sum, item) => sum + item.quantity, 0),
    0,
  );
  const ambient = hash(active[0]?.id ?? "") % 2;
  const tickets = active.length + ambient;

  return {
    minutes: clamp(BASE_MINUTES + items + tickets * 2, MIN_MINUTES, MAX_MINUTES),
    tickets,
    items,
  };
}
