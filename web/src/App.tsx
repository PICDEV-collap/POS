import { useMemo, useState } from "react";
import type {
  CartLine,
  CategoryId,
  CompletedOrder,
  MenuItem,
  PaymentMethod,
} from "./types";
import { CATEGORIES, MENU } from "./data/menu";
import Header from "./components/Header";
import CategoryTabs from "./components/CategoryTabs";
import ProductCard from "./components/ProductCard";
import CartPanel from "./components/CartPanel";
import PaymentModal from "./components/PaymentModal";
import ReceiptModal from "./components/ReceiptModal";

export default function App() {
  const [category, setCategory] = useState<CategoryId>("all");
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discountPct, setDiscountPct] = useState(0);
  const [orderNumber, setOrderNumber] = useState(1);
  const [paying, setPaying] = useState(false);
  const [completed, setCompleted] = useState<CompletedOrder | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: MENU.length };
    for (const item of MENU) {
      c[item.category] = (c[item.category] ?? 0) + 1;
    }
    return c;
  }, []);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return MENU.filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (q && !`${item.name} ${item.description}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [category, search]);

  const qtyById = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of lines) m[l.item.id] = l.qty;
    return m;
  }, [lines]);

  const subtotal = lines.reduce((sum, l) => sum + l.item.price * l.qty, 0);
  const discount = Math.round(subtotal * (discountPct / 100) * 100) / 100;
  const total = subtotal - discount;

  function addItem(item: MenuItem) {
    setLines((prev) => {
      const existing = prev.find((l) => l.item.id === item.id);
      if (existing) {
        return prev.map((l) =>
          l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l,
        );
      }
      return [...prev, { item, qty: 1 }];
    });
  }

  function changeQty(itemId: string, delta: number) {
    setLines((prev) =>
      prev
        .map((l) => (l.item.id === itemId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    );
  }

  function removeLine(itemId: string) {
    setLines((prev) => prev.filter((l) => l.item.id !== itemId));
  }

  function clearCart() {
    setLines([]);
    setDiscountPct(0);
  }

  function confirmPayment(method: PaymentMethod, tendered?: number) {
    setCompleted({
      number: orderNumber,
      lines,
      subtotal,
      discount,
      total,
      method,
      tendered,
      change: tendered !== undefined ? tendered - total : undefined,
      timestamp: new Date(),
    });
    setPaying(false);
  }

  function startNewOrder() {
    setCompleted(null);
    clearCart();
    setOrderNumber((n) => n + 1);
    setSearch("");
    setCategory("all");
  }

  return (
    <div className="flex h-full flex-col bg-ink-50">
      <Header search={search} onSearchChange={setSearch} orderNumber={orderNumber} />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <CategoryTabs
            categories={CATEGORIES}
            active={category}
            counts={counts}
            onSelect={setCategory}
          />

          {visibleItems.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <div className="mb-3 text-4xl">🔍</div>
              <p className="text-sm font-semibold text-ink-500">
                No menu items match “{search}”
              </p>
              <button
                onClick={() => setSearch("")}
                className="mt-2 text-sm font-bold text-brand-600 hover:underline"
              >
                Clear search
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
              {visibleItems.map((item) => (
                <ProductCard
                  key={item.id}
                  item={item}
                  qtyInCart={qtyById[item.id] ?? 0}
                  onAdd={addItem}
                />
              ))}
            </div>
          )}
        </main>

        <CartPanel
          lines={lines}
          subtotal={subtotal}
          discountPct={discountPct}
          discount={discount}
          total={total}
          onChangeQty={changeQty}
          onRemove={removeLine}
          onClear={clearCart}
          onSetDiscountPct={setDiscountPct}
          onCharge={() => setPaying(true)}
        />
      </div>

      {paying && (
        <PaymentModal
          lines={lines}
          total={total}
          orderNumber={orderNumber}
          onCancel={() => setPaying(false)}
          onConfirm={confirmPayment}
        />
      )}

      {completed && <ReceiptModal order={completed} onNewOrder={startNewOrder} />}
    </div>
  );
}
