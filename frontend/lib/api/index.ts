import { createId, getDeviceId } from "@/lib/api/session";
import { getSnapshot, mutate } from "@/lib/api/store";
import type {
  CartLine,
  FloorTableSummary,
  MenuItem,
  Order,
  OrderStatus,
  RestaurantTable,
  ServiceResult,
} from "@/lib/api/types";

/* Service layer. Every function mirrors an endpoint from
   docs/4-architectural-mapping.md, which is why they stay async and return
   ServiceResult envelopes even though the data currently resolves locally. */

const ACTIVE_STATUSES: OrderStatus[] = ["pending", "preparing", "ready"];

function findTable(tableToken: string): RestaurantTable | undefined {
  return getSnapshot().tables.find((table) => table.code === tableToken);
}

export async function initializeSession(
  tableToken: string,
): Promise<ServiceResult<RestaurantTable>> {
  const table = findTable(tableToken);

  if (!table) {
    return {
      ok: false,
      code: "table_not_found",
      message: "This QR link is not linked to an active table.",
    };
  }

  return { ok: true, data: table };
}

export async function fetchMenu(tableToken: string): Promise<ServiceResult<MenuItem[]>> {
  const table = findTable(tableToken);

  if (!table) {
    return {
      ok: false,
      code: "table_not_found",
      message: "This QR link is not linked to an active table.",
    };
  }

  return { ok: true, data: getSnapshot().menu };
}

export interface AddCartLineInput {
  table_token: string;
  menu_item_id: string;
  quantity?: number;
  request_note?: string;
  allergy_note?: string;
  added_by?: string;
}

export async function addCartLine(input: AddCartLineInput): Promise<ServiceResult<CartLine>> {
  const table = findTable(input.table_token);

  if (!table) {
    return {
      ok: false,
      code: "table_not_found",
      message: "This QR link is not linked to an active table.",
    };
  }

  const menuItem = getSnapshot().menu.find((item) => item.id === input.menu_item_id);
  if (!menuItem) {
    return { ok: false, code: "table_not_found", message: "That dish is no longer on the menu." };
  }

  if (!menuItem.is_available) {
    return {
      ok: false,
      code: "inventory_conflict",
      message: `${menuItem.name} just ran out.`,
      sold_out: [menuItem.name],
    };
  }

  // A dish added twice with different notes stays two lines: the kitchen
  // needs the allergy text on its own ticket line.
  const existing = getSnapshot().cart.find(
    (line) =>
      line.table_id === table.id &&
      line.menu_item_id === menuItem.id &&
      !line.allergy_note &&
      !line.request_note,
  );

  if (existing && (input.quantity ?? 1) === 1) {
    mutate((draft) => {
      const line = draft.cart.find((item) => item.id === existing.id);
      if (line) line.quantity += 1;
    });

    return { ok: true, data: { ...existing, quantity: existing.quantity + 1 } };
  }

  const line: CartLine = {
    id: createId("cart"),
    table_id: table.id,
    menu_item_id: menuItem.id,
    quantity: input.quantity ?? 1,
    request_note: input.request_note?.trim() ?? "",
    allergy_note: input.allergy_note?.trim() ?? "",
    added_by: input.added_by?.trim() || "Guest",
  };

  mutate((draft) => {
    draft.cart.push(line);
  });

  return { ok: true, data: line };
}

export interface UpdateCartLineInput {
  cart_item_id: string;
  quantity?: number;
  request_note?: string;
  allergy_note?: string;
}

export async function updateCartLine(
  input: UpdateCartLineInput,
): Promise<ServiceResult<CartLine>> {
  const line = getSnapshot().cart.find((item) => item.id === input.cart_item_id);

  if (!line) {
    return { ok: false, code: "table_not_found", message: "That cart line no longer exists." };
  }

  // Deleting a line is its own deliberate action in the cart view.
  const quantity = Math.max(1, input.quantity ?? line.quantity);

  mutate((draft) => {
    const target = draft.cart.find((item) => item.id === line.id);
    if (!target) return;
    target.quantity = quantity;
    if (input.request_note !== undefined) target.request_note = input.request_note;
    if (input.allergy_note !== undefined) target.allergy_note = input.allergy_note;
  });

  return {
    ok: true,
    data: {
      ...line,
      quantity,
      request_note: input.request_note ?? line.request_note,
      allergy_note: input.allergy_note ?? line.allergy_note,
    },
  };
}

export async function removeCartLine({
  cart_item_id,
}: {
  cart_item_id: string;
}): Promise<ServiceResult<{ cart_item_id: string }>> {
  mutate((draft) => {
    draft.cart = draft.cart.filter((item) => item.id !== cart_item_id);
  });

  return { ok: true, data: { cart_item_id } };
}

export async function clearCart(tableToken: string): Promise<ServiceResult<null>> {
  const table = findTable(tableToken);
  if (!table) {
    return { ok: false, code: "table_not_found", message: "Unknown table." };
  }

  mutate((draft) => {
    draft.cart = draft.cart.filter((item) => item.table_id !== table.id);
  });

  return { ok: true, data: null };
}

export function getCart(tableToken: string): CartLine[] {
  const table = findTable(tableToken);
  if (!table) return [];

  return getSnapshot().cart.filter((line) => line.table_id === table.id);
}

/** Settle a table: erase its session — every staged line and every order —
    so the next guests genuinely start from nothing. Demo-store only; the
    live API has no equivalent endpoint yet (docs/7 ends at E17). */
export function settleTable(tableToken: string): ServiceResult<null> {
  const table = findTable(tableToken);
  if (!table) {
    return { ok: false, code: "table_not_found", message: "Unknown table." };
  }

  mutate((draft) => {
    draft.cart = draft.cart.filter((line) => line.table_id !== table.id);
    draft.orders = draft.orders.filter((order) => order.table_id !== table.id);
  });

  return { ok: true, data: null };
}

export function getActiveOrder(tableToken: string): Order | null {
  const table = findTable(tableToken);
  if (!table) return null;

  return (
    getSnapshot()
      .orders.filter(
        (order) => order.table_id === table.id && ACTIVE_STATUSES.includes(order.status),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .at(0) ?? null
  );
}

export async function checkActiveOrder(
  tableToken: string,
): Promise<ServiceResult<{ active: boolean; order: Order | null }>> {
  const order = getActiveOrder(tableToken);
  return { ok: true, data: { active: Boolean(order), order } };
}

export async function fireOrder(tableToken: string): Promise<ServiceResult<Order>> {
  const table = findTable(tableToken);

  if (!table) {
    return {
      ok: false,
      code: "table_not_found",
      message: "This QR link is not linked to an active table.",
    };
  }

  const snapshot = getSnapshot();
  const lines = snapshot.cart.filter((line) => line.table_id === table.id);

  if (lines.length === 0) {
    return {
      ok: false,
      code: "empty_cart",
      message: "The table cart is empty — nothing to fire.",
    };
  }

  const active = getActiveOrder(tableToken);
  if (active) {
    return {
      ok: false,
      code: "duplicate_order",
      message: "Order already sent. The kitchen is working on it.",
    };
  }

  // Live inventory check: anything that sold out since it was added is
  // reported back and stays visible on the menu.
  const soldOut = lines
    .map((line) => snapshot.menu.find((item) => item.id === line.menu_item_id))
    .filter((item): item is MenuItem => item !== undefined && !item.is_available)
    .map((item) => item.name);

  if (soldOut.length > 0) {
    return {
      ok: false,
      code: "inventory_conflict",
      message: "Some items ran out while you were ordering.",
      sold_out: [...new Set(soldOut)],
    };
  }

  const now = new Date().toISOString();
  const orderId = createId("ord");

  const order: Order = {
    id: orderId,
    table_id: table.id,
    table_code: table.code,
    status: "pending",
    created_at: now,
    updated_at: now,
    items: lines.map((line) => {
      const menuItem = snapshot.menu.find((item) => item.id === line.menu_item_id);
      return {
        id: createId("oitem"),
        order_id: orderId,
        menu_item_id: line.menu_item_id,
        name: menuItem?.name ?? "Removed item",
        price: menuItem?.price ?? 0,
        quantity: line.quantity,
        request_note: line.request_note,
        allergy_note: line.allergy_note,
        added_by: line.added_by,
      };
    }),
  };

  mutate((draft) => {
    draft.orders.push(order);
    draft.cart = draft.cart.filter((line) => line.table_id !== table.id);
  });

  return { ok: true, data: order };
}

export function getOrdersForTable(tableToken: string): Order[] {
  const table = findTable(tableToken);
  if (!table) return [];

  return getSnapshot()
    .orders.filter((order) => order.table_id === table.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getKdsTickets(): Order[] {
  return getSnapshot()
    .orders.filter((order) => order.status !== "served")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function updateTicketStatus(
  orderId: string,
  status: OrderStatus,
): Promise<ServiceResult<Order>> {
  const order = getSnapshot().orders.find((item) => item.id === orderId);

  if (!order) {
    return { ok: false, code: "table_not_found", message: "That ticket no longer exists." };
  }

  mutate((draft) => {
    const target = draft.orders.find((item) => item.id === orderId);
    if (!target) return;
    target.status = status;
    target.updated_at = new Date().toISOString();
  });

  return { ok: true, data: { ...order, status } };
}

export function pruneTicket(orderId: string) {
  return updateTicketStatus(orderId, "served");
}

export async function setMenuItemAvailability(
  menuItemId: string,
  isAvailable: boolean,
): Promise<ServiceResult<MenuItem>> {
  const item = getSnapshot().menu.find((entry) => entry.id === menuItemId);

  if (!item) {
    return { ok: false, code: "table_not_found", message: "Unknown menu item." };
  }

  mutate((draft) => {
    const target = draft.menu.find((entry) => entry.id === menuItemId);
    if (target) target.is_available = isAvailable;
  });

  return { ok: true, data: { ...item, is_available: isAvailable } };
}

/** Synchronous floor summary. Exists because subscription callbacks cannot
    await, and duplicating the aggregation in two places is how the demo store
    and the service function drift apart. */
export function getFloorSummaries(): FloorTableSummary[] {
  const snapshot = getSnapshot();

  return snapshot.tables.map((table) => {
    const order =
      snapshot.orders
        .filter((entry) => entry.table_id === table.id && ACTIVE_STATUSES.includes(entry.status))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .at(0) ?? null;

    return {
      table,
      active_order: order,
      cart_line_count: snapshot.cart.filter((line) => line.table_id === table.id).length,
    };
  });
}

export async function fetchFloorSummaries(): Promise<ServiceResult<FloorTableSummary[]>> {
  return { ok: true, data: getFloorSummaries() };
}

export function getDeviceIdentity() {
  return { device_id: getDeviceId() };
}
