export function formatChf(n: number, opts: { decimals?: number } = {}): string {
  if (!Number.isFinite(n)) return "CHF –";
  const formatted = n.toLocaleString("de-CH", {
    minimumFractionDigits: opts.decimals ?? 0,
    maximumFractionDigits: opts.decimals ?? 0,
  });
  return `CHF ${formatted}`;
}

export function formatChfCompact(n: number): string {
  if (!Number.isFinite(n)) return "CHF –";
  if (Math.abs(n) >= 1_000_000) return `CHF ${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `CHF ${(n / 1_000).toFixed(1)}k`;
  return formatChf(n);
}
