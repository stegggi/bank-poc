// use-cases/uc8-tempo/lib/theme.ts
//
// Shared concept-bank theme tokens for the UC8 demo (light + dark). Neutral tokens, no Finalix
// brand colours. Used by the shell, Act 1, and Act 2 so the palette stays consistent.

export type Tokens = {
  bg: string; panel: string; panel2: string; border: string; text: string; heading: string;
  muted: string; faint: string; inputBg: string; accent: string; chipBg: string;
};

export const DARK: Tokens = {
  bg: "#07080f", panel: "rgba(255,255,255,0.035)", panel2: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.09)", text: "#e8e8f0", heading: "#ffffff",
  muted: "rgba(255,255,255,0.55)", faint: "rgba(255,255,255,0.38)", inputBg: "rgba(255,255,255,0.05)",
  accent: "#6366f1", chipBg: "rgba(255,255,255,0.06)",
};

export const LIGHT: Tokens = {
  bg: "#f4f5f8", panel: "#ffffff", panel2: "#fbfbfd",
  border: "rgba(15,17,26,0.10)", text: "#272b36", heading: "#0b0d16",
  muted: "rgba(15,17,26,0.58)", faint: "rgba(15,17,26,0.42)", inputBg: "#ffffff",
  accent: "#4f46e5", chipBg: "rgba(15,17,26,0.045)",
};

export type PillKind = "green" | "amber" | "red" | "info";

// Each entry: [background, foreground, border] for dark and light.
export const PILLS: Record<PillKind, { dark: [string, string, string]; light: [string, string, string] }> = {
  green: { dark: ["rgba(34,197,94,0.15)", "#4ade80", "rgba(34,197,94,0.35)"], light: ["rgba(22,163,74,0.12)", "#15803d", "rgba(22,163,74,0.30)"] },
  amber: { dark: ["rgba(245,158,11,0.15)", "#fbbf24", "rgba(245,158,11,0.35)"], light: ["rgba(217,119,6,0.12)", "#b45309", "rgba(217,119,6,0.30)"] },
  red: { dark: ["rgba(239,68,68,0.15)", "#f87171", "rgba(239,68,68,0.35)"], light: ["rgba(220,38,38,0.10)", "#b91c1c", "rgba(220,38,38,0.28)"] },
  info: { dark: ["rgba(59,130,246,0.15)", "#60a5fa", "rgba(59,130,246,0.35)"], light: ["rgba(37,99,235,0.10)", "#1d4ed8", "rgba(37,99,235,0.28)"] },
};

export const themeOf = (dark: boolean): Tokens => (dark ? DARK : LIGHT);
export const pill = (kind: PillKind, dark: boolean) => PILLS[kind][dark ? "dark" : "light"];
