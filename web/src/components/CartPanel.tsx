import type { CartLine } from "../types";
import { formatTHB } from "../data/menu";

interface CartPanelProps {
  lines: CartLine[];
  subtotal: number;
  discountPct: number;
  discount: number;
  total: number;
  onChangeQty: (itemId: string, delta: number) => void;
  onRemove: (itemId: string) => void;
  onClear: () => void;
  onSetDiscountPct: (pct: number) => void;
  onCharge: () => void;
}

const DISCOUNTS = [0, 5, 10, 20];

export default function CartPanel({
  lines,
  subtotal,
  discountPct,
  discount,
  total,
  onChangeQty,
  onRemove,
  onClear,
  onSetDiscountPct,
  onCharge,
}: CartPanelProps) {
  const itemCount = lines.reduce((sum, l) => sum + l.qty, 0);
  const empty = lines.length === 0;

  return (
    <aside className="flex w-[370px] shrink-0 flex-col border-l border-ink-100 bg-white">
      <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
        <div>
          <h2 className="text-base font-extrabold text-ink-900">Current order</h2>
          <p className="text-xs text-ink-400">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </p>
        </div>
        <button
          onClick={onClear}
          disabled={empty}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-400"
        >
          Clear all
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-ink-50 text-3xl">
              🛒
            </div>
            <p className="text-sm font-semibold text-ink-500">Cart is empty</p>
            <p className="mt-1 max-w-[200px] text-xs text-ink-300">
              Tap a menu item on the left to start a new order
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {lines.map((line) => (
              <li
                key={line.item.id}
                className="flex items-center gap-3 rounded-xl border border-ink-100 p-3"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-xl">
                  {line.item.emoji}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink-800">
                    {line.item.name}
                  </p>
                  <p className="text-xs text-ink-400">
                    {formatTHB(line.item.price)} each
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label={`Decrease ${line.item.name}`}
                    onClick={() =>
                      line.qty === 1
                        ? onRemove(line.item.id)
                        : onChangeQty(line.item.id, -1)
                    }
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-ink-200 text-sm font-bold text-ink-600 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm font-bold text-ink-900">
                    {line.qty}
                  </span>
                  <button
                    aria-label={`Increase ${line.item.name}`}
                    onClick={() => onChangeQty(line.item.id, 1)}
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-ink-200 text-sm font-bold text-ink-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600"
                  >
                    +
                  </button>
                </div>
                <span className="w-14 text-right text-sm font-extrabold text-ink-900">
                  {formatTHB(line.item.price * line.qty)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-ink-100 px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs font-semibold text-ink-500">Discount</span>
          <div className="ml-auto flex gap-1.5">
            {DISCOUNTS.map((pct) => (
              <button
                key={pct}
                onClick={() => onSetDiscountPct(pct)}
                className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors ${
                  discountPct === pct
                    ? "bg-ink-900 text-white"
                    : "bg-ink-50 text-ink-500 hover:bg-ink-100"
                }`}
              >
                {pct === 0 ? "None" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>

        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between text-ink-500">
            <dt>Subtotal</dt>
            <dd className="font-semibold">{formatTHB(subtotal)}</dd>
          </div>
          <div className="flex justify-between text-ink-500">
            <dt>Discount{discountPct > 0 ? ` (${discountPct}%)` : ""}</dt>
            <dd className="font-semibold text-red-500">
              {discount > 0 ? `−${formatTHB(discount)}` : formatTHB(0)}
            </dd>
          </div>
          <div className="flex justify-between border-t border-dashed border-ink-200 pt-2 text-base font-extrabold text-ink-900">
            <dt>Total</dt>
            <dd>{formatTHB(total)}</dd>
          </div>
        </dl>

        <button
          onClick={onCharge}
          disabled={empty}
          className="mt-4 flex w-full items-center justify-between rounded-2xl bg-brand-500 px-5 py-4 text-white shadow-lg shadow-brand-200 transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:shadow-none"
        >
          <span className="text-base font-extrabold">Charge</span>
          <span className="text-base font-extrabold">{formatTHB(total)}</span>
        </button>
      </div>
    </aside>
  );
}
