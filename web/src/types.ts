export type CategoryId =
  | "all"
  | "noodles"
  | "rice"
  | "sides"
  | "drinks"
  | "desserts";

export interface Category {
  id: CategoryId;
  label: string;
  icon: string;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: Exclude<CategoryId, "all">;
  emoji: string;
  popular?: boolean;
  soldOut?: boolean;
}

export interface CartLine {
  item: MenuItem;
  qty: number;
  note?: string;
}

export type PaymentMethod = "cash" | "qr" | "card";

export interface CompletedOrder {
  number: number;
  lines: CartLine[];
  subtotal: number;
  discount: number;
  total: number;
  method: PaymentMethod;
  tendered?: number;
  change?: number;
  timestamp: Date;
}
