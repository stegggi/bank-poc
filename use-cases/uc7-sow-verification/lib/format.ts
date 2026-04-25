export type Currency = "CHF" | "USD";

export function formatMoney(
  n: number,
  currency: Currency = "CHF",
  opts: { decimals?: number } = {}
): string {
  if (!Number.isFinite(n)) return currency === "USD" ? "$ –" : "CHF –";
  const decimals = opts.decimals ?? 0;
  if (currency === "USD") {
    const formatted = n.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return `$${formatted}`;
  }
  const formatted = n.toLocaleString("de-CH", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `CHF ${formatted}`;
}

export function formatChf(n: number, opts: { decimals?: number } = {}): string {
  return formatMoney(n, "CHF", opts);
}

export function formatChfCompact(n: number): string {
  if (!Number.isFinite(n)) return "CHF –";
  if (Math.abs(n) >= 1_000_000) return `CHF ${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `CHF ${(n / 1_000).toFixed(1)}k`;
  return formatChf(n);
}
