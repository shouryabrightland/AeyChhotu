/* Domain contracts. Field names mirror the documented Supabase tables
   (docs/2-mvp-ideation.md → Database Tables) so the mock service layer can be
   replaced by the real backend without touching UI code. */

/** `denied` is a refused round: closed, never cooked, never billed. */
export type OrderStatus = "pending" | "preparing" | "ready" | "served" | "denied";

export type BillStatus = "unrequested" | "requested" | "paid";

export interface RestaurantTable {
  id: string;
  /** Random, unguessable code used in the QR link: /table/{code} */
  code: string;
  name: string;
  /** Live bill state from E17. Absent on seeded/demo rows. */
  bill_status?: BillStatus;
}

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  category: string;
  category_id?: string | null;
  is_available: boolean;
  description: string;
  vegetarian: boolean;
  /** Uploaded photo URLs + the inline 50px blur; absent = curated photo. */
  image_url?: string | null;
  image_small_url?: string | null;
  blur_data_url?: string | null;
  /* Kitchen-maintained dish metadata (sql/015). An EMPTY list means "not
     recorded", never "contains none". */
  ingredients?: string[];
  /** 0 mild · 1 medium · 2 hot · 3 very hot. */
  spice_level?: number;
  allergens?: string[];
  /** Best-effort diet tags: jain, vegan, halal, eggitarian. */
  diet_tags?: string[];
  portion_description?: string;
}

export interface CartLine {
  id: string;
  table_id: string;
  menu_item_id: string;
  quantity: number;
  /** Normal kitchen instructions: "extra sauce, etc." */
  request_note: string;
  /** Medical allergies only — rendered in bold red on the KDS */
  allergy_note: string;
  added_by: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string;
  name: string;
  price: number;
  quantity: number;
  request_note: string;
  allergy_note: string;
  added_by: string;
}

export interface Order {
  id: string;
  table_id: string;
  table_code: string;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
  /** Why the kitchen refused it (only meaningful when status = 'denied'). */
  denial_reason?: string;
  items: OrderItem[];
}

export interface TableSession {
  table_token: string;
  table: RestaurantTable;
  device_id: string;
  display_name: string;
}

export interface ServiceFailure {
  ok: false;
  code:
    | "table_not_found"
    | "inventory_conflict"
    | "duplicate_order"
    | "empty_cart"
    | "invalid_pin"
    | "unauthorized";
  message: string;
  /** Menu item names that sold out between adding and firing. */
  sold_out?: string[];
}

export type ServiceResult<T> = { ok: true; data: T } | ServiceFailure;

export interface FloorTableSummary {
  table: RestaurantTable;
  active_order: Order | null;
  cart_line_count: number;
  /** Devices with a fresh heartbeat; absent on older/demo payloads. */
  active_devices?: number;
  /** Active session with no device, no open order and no bill request. */
  needs_attention?: boolean;
  /** Set when a staff clear was refused for an unpaid bill. */
  clear_requested_at?: string | null;
  /** True when this seating owes money; only a manager may clear it. */
  bill_unpaid?: boolean;
}
