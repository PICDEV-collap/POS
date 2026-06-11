import type { Category, CategoryId } from "../types";

interface CategoryTabsProps {
  categories: Category[];
  active: CategoryId;
  counts: Record<string, number>;
  onSelect: (id: CategoryId) => void;
}

export default function CategoryTabs({
  categories,
  active,
  counts,
  onSelect,
}: CategoryTabsProps) {
  return (
    <nav className="flex gap-2 overflow-x-auto pb-1">
      {categories.map((cat) => {
        const isActive = cat.id === active;
        return (
          <button
            key={cat.id}
            onClick={() => onSelect(cat.id)}
            className={`flex shrink-0 items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${
              isActive
                ? "border-brand-500 bg-brand-500 text-white shadow-sm"
                : "border-ink-100 bg-white text-ink-600 hover:border-brand-300 hover:text-brand-600"
            }`}
          >
            <span className="text-base leading-none">{cat.icon}</span>
            {cat.label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                isActive ? "bg-white/25 text-white" : "bg-ink-50 text-ink-400"
              }`}
            >
              {counts[cat.id] ?? 0}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
