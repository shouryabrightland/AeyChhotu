/* Normalizers — map contract (docs/7 v2) payloads onto the UI domain types
   in lib/api/types.ts so screen components keep their existing markup and
   Tailwind classes untouched.

   There is deliberately NO demo-fallback predicate here any more. The app is
   a real product: an unreachable backend is an error state a guest can retry,
   not an invitation to render seeded dishes as if they were the menu. */

import { ApiError } from "./errors";
import type {
  CartLine as ApiCartLine,
  FloorTable as FloorTableResponse,
  KdsTicket,
  OrderHistoryItem,
  OrderItemLine,
  TableSession,
} from "./types";
import type {
  CartLine,
  FloorTableSummary,
  MenuItem,
  Order,
  OrderItem,
  OrderStatus,
  RestaurantTable,
} from "../api/types";
import type { MenuItem as ApiMenuItem } from "./types";

/** True when the request never reached the backend (down / timeout / unconfigured).
    Used for COPY only ("the serving line is starting up") — never to decide
    whether stale demo data may stand in for the live API. */
export function isOfflineError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

export function toTable(session: TableSession): RestaurantTable {
  return { id: session.table_id, code: session.code, name: session.name };
}

export function toMenuItem(item: ApiMenuItem): MenuItem {
  return {
    id: item.menu_item_id,
    name: item.name,
    price: item.price,
    category: item.category,
    is_available: item.is_available,
    description: item.description,
    vegetarian: item.vegetarian,
  };
}

export function toCartLine(line: ApiCartLine): CartLine {
  return {
    id: line.id,
    table_id: line.table_id,
    menu_item_id: line.menu_item_id,
    quantity: line.quantity,
    request_note: line.request_note,
    allergy_note: line.allergy_note,
    added_by: line.added_by,
  };
}

function toOrderItems(orderId: string, items: OrderItemLine[]): OrderItem[] {
  return items.map((item, index) => ({
    id: `${orderId}-item-${index}`,
    order_id: orderId,
    menu_item_id: item.menu_item_id,
    name: item.name,
    // The price CHARGED at fire time (sql/004_hardening.sql), not today's
    // menu price. Falls back to 0 for any payload that predates the column.
    price: item.unit_price ?? 0,
    quantity: item.quantity,
    request_note: item.request_note,
    allergy_note: item.allergy_note,
    added_by: "",
  }));
}

export function toOrder(
  row: OrderHistoryItem,
  tableCode: string,
): Order {
  return {
    id: row.order_id,
    table_id: row.table_id,
    table_code: tableCode,
    status: row.status as OrderStatus,
    created_at: row.created_at,
    updated_at: row.created_at,
    items: toOrderItems(row.order_id, row.items),
  };
}

/** E17 floor row → the UI's FloorTableSummary, so the floor screen keeps its
    existing markup while reading live data. Mirrors toOrder/toKdsOrder: items
    carry the fire-time `unit_price`, though the floor card itself shows pacing
    and allergies, never money. */
export function toFloorSummary(row: FloorTableResponse): FloorTableSummary {
  return {
    table: {
      id: row.table_id,
      code: row.code,
      name: row.name,
      bill_status: row.bill_status,
    },
    active_order: row.active_order
      ? {
          id: row.active_order.order_id,
          table_id: row.table_id,
          table_code: row.code,
          status: row.active_order.status,
          created_at: row.active_order.created_at,
          updated_at: row.active_order.created_at,
          items: toOrderItems(row.active_order.order_id, row.active_order.items ?? []),
        }
      : null,
    cart_line_count: row.cart_line_count,
    active_devices: row.active_devices,
    needs_attention: row.needs_attention,
    clear_requested_at: row.clear_requested_at,
  };
}

export function toKdsOrder(ticket: KdsTicket): Order {
  return {
    id: ticket.order_id,
    table_id: ticket.table.id,
    table_code: ticket.table.code,
    status: ticket.status as OrderStatus,
    created_at: ticket.created_at,
    updated_at: ticket.created_at,
    items: toOrderItems(ticket.order_id, ticket.items),
  };
}
