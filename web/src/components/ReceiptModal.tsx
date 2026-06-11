import type { CompletedOrder } from "../types";
import { formatTHB } from "../data/menu";

interface ReceiptModalProps {
  order: CompletedOrder;
  onNewOrder: () => void;
}

const METHOD_LABEL: Record<CompletedOrder["method"], string> = {
  cash: "Cash",
  qr: "QR / PromptPay",
  card: "Card",
};

export default function ReceiptModal({ order, onNewOrder }: ReceiptModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex flex-col items-center bg-emerald-500 px-6 py-6 text-white">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/20 text-3xl">
            ✓
          </div>
          <h2 className="mt-3 text-lg font-extrabold">Payment complete</h2>
          <p className="text-sm text-emerald-50">
            Order #{String(order.number).padStart(4, "0")} ·{" "}
            {order.timestamp.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>

        <div className="px-6 py-5">
          <ul className="space-y-1.5 text-sm">
            {order.lines.map((l) => (
              <li key={l.item.id} className="flex justify-between gap-2">
                <span className="truncate text-ink-600">
                  {l.qty}× {l.item.name}
                </span>
                <span className="shrink-0 font-semibold text-ink-800">
                  {formatTHB(l.item.price * l.qty)}
                </span>
              </li>
            ))}
          </ul>

          <dl className="mt-4 space-y-1.5 border-t border-dashed border-ink-200 pt-3 text-sm">
            <div className="flex justify-between text-ink-500">
              <dt>Subtotal</dt>
              <dd>{formatTHB(order.subtotal)}</dd>
            </div>
            {order.discount > 0 && (
              <div className="flex justify-between text-red-500">
                <dt>Discount</dt>
                <dd>−{formatTHB(order.discount)}</dd>
              </div>
            )}
            <div className="flex justify-between text-base font-extrabold text-ink-900">
              <dt>Total paid</dt>
              <dd>{formatTHB(order.total)}</dd>
            </div>
            <div className="flex justify-between text-ink-500">
              <dt>Method</dt>
              <dd className="font-semibold">{METHOD_LABEL[order.method]}</dd>
            </div>
            {order.method === "cash" && order.tendered !== undefined && (
              <>
                <div className="flex justify-between text-ink-500">
                  <dt>Cash received</dt>
                  <dd>{formatTHB(order.tendered)}</dd>
                </div>
                <div className="flex justify-between font-bold text-emerald-600">
                  <dt>Change</dt>
                  <dd>{formatTHB(order.change ?? 0)}</dd>
                </div>
              </>
            )}
          </dl>

          <div className="mt-6 grid grid-cols-2 gap-2">
            <button
              onClick={() => window.print()}
              className="rounded-xl border border-ink-200 py-3 text-sm font-bold text-ink-600 transition-colors hover:bg-ink-50"
            >
              Print receipt
            </button>
            <button
              onClick={onNewOrder}
              className="rounded-xl bg-brand-500 py-3 text-sm font-extrabold text-white transition-colors hover:bg-brand-600"
            >
              New order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
