import { useMemo, useState } from "react";
import type { CartLine, PaymentMethod } from "../types";
import { formatTHB } from "../data/menu";

interface PaymentModalProps {
  lines: CartLine[];
  total: number;
  orderNumber: number;
  onCancel: () => void;
  onConfirm: (method: PaymentMethod, tendered?: number) => void;
}

const METHODS: { id: PaymentMethod; label: string; icon: string; hint: string }[] = [
  { id: "cash", label: "Cash", icon: "💵", hint: "Enter amount received" },
  { id: "qr", label: "QR / PromptPay", icon: "📱", hint: "Customer scans to pay" },
  { id: "card", label: "Card", icon: "💳", hint: "Tap, insert, or swipe" },
];

const QUICK_NOTES = [20, 50, 100, 500, 1000];

export default function PaymentModal({
  lines,
  total,
  orderNumber,
  onCancel,
  onConfirm,
}: PaymentModalProps) {
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [tendered, setTendered] = useState<string>("");

  const tenderedNum = Number(tendered) || 0;
  const change = tenderedNum - total;
  const cashReady = method !== "cash" || tenderedNum >= total;

  const quickAmounts = useMemo(() => {
    const exact = total;
    const rounded = QUICK_NOTES.filter((n) => n > exact).slice(0, 3);
    return [exact, ...rounded];
  }, [total]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/50 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="flex w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hidden w-64 shrink-0 flex-col border-r border-ink-100 bg-ink-50 p-5 sm:flex">
          <p className="text-xs font-bold tracking-wide text-ink-400 uppercase">
            Order #{String(orderNumber).padStart(4, "0")}
          </p>
          <ul className="mt-3 flex-1 space-y-2 overflow-y-auto text-sm">
            {lines.map((l) => (
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
          <div className="mt-4 flex justify-between border-t border-ink-200 pt-3 text-base font-extrabold text-ink-900">
            <span>Total</span>
            <span>{formatTHB(total)}</span>
          </div>
        </div>

        <div className="flex-1 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-extrabold text-ink-900">Take payment</h2>
              <p className="text-sm text-ink-400">
                Amount due:{" "}
                <span className="font-bold text-ink-800">{formatTHB(total)}</span>
              </p>
            </div>
            <button
              onClick={onCancel}
              aria-label="Close payment"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700"
            >
              ✕
            </button>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            {METHODS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMethod(m.id)}
                className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-sm font-semibold transition-colors ${
                  method === m.id
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-ink-100 text-ink-500 hover:border-ink-200"
                }`}
              >
                <span className="text-2xl">{m.icon}</span>
                {m.label}
              </button>
            ))}
          </div>

          {method === "cash" ? (
            <div className="mt-5">
              <label className="text-xs font-bold tracking-wide text-ink-400 uppercase">
                Cash received
              </label>
              <input
                type="number"
                min={0}
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder="0"
                autoFocus
                className="mt-1.5 w-full rounded-xl border border-ink-200 px-4 py-3 text-xl font-extrabold text-ink-900 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 focus:outline-none"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {quickAmounts.map((amt, i) => (
                  <button
                    key={amt}
                    onClick={() => setTendered(String(amt))}
                    className="rounded-lg bg-ink-50 px-3 py-1.5 text-sm font-bold text-ink-600 transition-colors hover:bg-brand-100 hover:text-brand-700"
                  >
                    {i === 0 ? `Exact ${formatTHB(amt)}` : formatTHB(amt)}
                  </button>
                ))}
              </div>
              <div
                className={`mt-4 flex items-center justify-between rounded-xl px-4 py-3 ${
                  change >= 0 && tenderedNum > 0
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-ink-50 text-ink-400"
                }`}
              >
                <span className="text-sm font-semibold">Change due</span>
                <span className="text-lg font-extrabold">
                  {tenderedNum > 0 && change >= 0 ? formatTHB(change) : "—"}
                </span>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex items-center gap-3 rounded-xl bg-ink-50 px-4 py-4 text-sm text-ink-500">
              <span className="text-2xl">
                {METHODS.find((m) => m.id === method)?.icon}
              </span>
              {METHODS.find((m) => m.id === method)?.hint} — confirm once the
              terminal approves.
            </div>
          )}

          <button
            onClick={() =>
              onConfirm(method, method === "cash" ? tenderedNum : undefined)
            }
            disabled={!cashReady}
            className="mt-6 w-full rounded-2xl bg-ink-900 py-3.5 text-base font-extrabold text-white transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-200"
          >
            Confirm payment · {formatTHB(total)}
          </button>
        </div>
      </div>
    </div>
  );
}
