interface HeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  orderNumber: number;
}

function Clock() {
  const now = new Date();
  return (
    <div className="hidden text-right md:block">
      <p className="text-sm font-semibold text-ink-800">
        {now.toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
        })}
      </p>
      <p className="text-xs text-ink-400">Cashier · Front counter</p>
    </div>
  );
}

export default function Header({ search, onSearchChange, orderNumber }: HeaderProps) {
  return (
    <header className="flex items-center gap-4 border-b border-ink-100 bg-white px-5 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-500 text-2xl shadow-sm">
          🍜
        </div>
        <div>
          <h1 className="text-base font-extrabold tracking-tight text-ink-900">
            Krutom Noodle
          </h1>
          <p className="text-xs font-medium text-ink-400">
            Point of Sale · Order #{String(orderNumber).padStart(4, "0")}
          </p>
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-md">
        <svg
          className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink-300"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
          />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search menu…"
          className="w-full rounded-xl border border-ink-100 bg-ink-50 py-2.5 pr-4 pl-10 text-sm text-ink-800 placeholder:text-ink-300 focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 focus:outline-none"
        />
      </div>

      <Clock />
    </header>
  );
}
