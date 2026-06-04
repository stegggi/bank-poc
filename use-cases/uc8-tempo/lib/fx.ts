// use-cases/uc8-tempo/lib/fx.ts
//
// UC8 — FX accounting (pure function, no chain).
//
// priceConversion(from, to, amount) → { rate, limmatEarns, liquidity, ... }
//   - Liquid corridors (CHF↔EUR, CHF↔USD): Limmat does the FX and earns the full spread.
//   - Hard corridor (CHF↔NGN): thin NGN liquidity, so Limmat keeps only a thin correspondent
//     margin (it still does the conversion itself — there is no separate liquidity partner).
//
// ALL rates and spreads below are // VERIFY placeholders — we have NOT sourced real figures.

export type Ccy = "CHF" | "EUR" | "USD" | "NGN";

// Illustrative mid rates: 1 CHF = X units of the target currency. // VERIFY (not sourced)
const PER_CHF: Record<Ccy, number> = { CHF: 1, EUR: 1.05, USD: 1.1, NGN: 1400 };

// Spread assumptions in basis points (1 bps = 0.01%). // VERIFY (not sourced)
const LIQUID_SPREAD_BPS = 25; // Limmat's full spread on a liquid corridor // VERIFY
const HARD_SPREAD_BPS = 15; // Limmat's thin correspondent margin on the hard NGN corridor // VERIFY

// In this demo NGN is the "hard" corridor (thin liquidity).
const HARD_CCY: Ccy = "NGN";

export type ConversionQuote = {
  fromCcy: Ccy;
  toCcy: Ccy;
  amount: number; // in fromCcy
  rate: number; // 1 fromCcy = `rate` toCcy
  converted: number; // amount * rate (mid)
  liquidity: "liquid" | "hard";
  limmatEarns: number; // in fromCcy
  limmatBps: number;
};

export function priceConversion(fromCcy: Ccy, toCcy: Ccy, amount: number): ConversionQuote {
  const rate = PER_CHF[toCcy] / PER_CHF[fromCcy];
  const converted = amount * rate;
  const hard = fromCcy === HARD_CCY || toCcy === HARD_CCY;
  const bps = hard ? HARD_SPREAD_BPS : LIQUID_SPREAD_BPS;
  return {
    fromCcy, toCcy, amount, rate, converted,
    liquidity: hard ? "hard" : "liquid",
    limmatEarns: (amount * bps) / 10000,
    limmatBps: bps,
  };
}

// Illustrative trailing-30-day corridor volumes (in the FROM currency). // VERIFY (not sourced)
export const FLOWS_30D: { fromCcy: Ccy; toCcy: Ccy; amount: number }[] = [
  { fromCcy: "CHF", toCcy: "EUR", amount: 4_200_000 },
  { fromCcy: "CHF", toCcy: "USD", amount: 2_800_000 },
  { fromCcy: "CHF", toCcy: "NGN", amount: 900_000 },
];

/** Aggregate the 30d FX revenue Limmat earns from priceConversion. */
export function fxRevenue30d(): { limmat: number; byCorridor: ConversionQuote[] } {
  const byCorridor = FLOWS_30D.map((f) => priceConversion(f.fromCcy, f.toCcy, f.amount));
  return { limmat: byCorridor.reduce((a, q) => a + q.limmatEarns, 0), byCorridor };
}
