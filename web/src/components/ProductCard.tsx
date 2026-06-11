import type { MenuItem } from "../types";
import { formatTHB } from "../data/menu";

interface ProductCardProps {
  item: MenuItem;
  qtyInCart: number;
  onAdd: (item: MenuItem) => void;
}

export default function ProductCard({ item, qtyInCart, onAdd }: ProductCardProps) {
  const disabled = !!item.soldOut;
  return (
    <button
      onClick={() => onAdd(item)}
      disabled={disabled}
      className={`group relative flex flex-col rounded-2xl border bg-white p-4 text-left transition-all ${
        disabled
          ? "cursor-not-allowed border-ink-100 opacity-50"
          : "border-ink-100 hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md active:translate-y-0"
      }`}
    >
      {item.popular && !disabled && (
        <span className="absolute top-3 right-3 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-brand-700 uppercase">
          Popular
        </span>
      )}
      {disabled && (
        <span className="absolute top-3 right-3 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-ink-500 uppercase">
          Sold out
        </span>
      )}
      {qtyInCart > 0 && (
        <span className="absolute -top-2 -left-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-ink-900 px-1.5 text-xs font-bold text-white shadow">
          {qtyInCart}
        </span>
      )}

      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-brand-50 text-3xl">
        {item.emoji}
      </div>
      <h3 className="text-sm leading-snug font-bold text-ink-900">{item.name}</h3>
      <p className="mt-1 line-clamp-2 text-xs text-ink-400">{item.description}</p>
      <div className="mt-auto flex items-center justify-between pt-3">
        <span className="text-base font-extrabold text-ink-900">
          {formatTHB(item.price)}
        </span>
        {!disabled && (
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500 text-lg leading-none font-bold text-white opacity-0 transition-opacity group-hover:opacity-100">
            +
          </span>
        )}
      </div>
    </button>
  );
}
