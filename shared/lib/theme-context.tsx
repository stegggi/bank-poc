// shared/lib/theme-context.tsx
//
// Global light/dark theme for the whole concept bank. The actual paint is driven by a
// `data-theme` attribute on <html> (set pre-paint by the no-flash script in _document, and
// flipped here on toggle) — so CSS-variable styling never flashes. This context only mirrors
// that attribute into React state for the few places that branch on the theme in JS
// (the NavBar toggle icon, UC8's token objects).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export const THEME_STORAGE_KEY = "cb-theme";

type ThemeContextValue = { dark: boolean; toggle: () => void };

const ThemeContext = createContext<ThemeContextValue>({ dark: true, toggle: () => {} });

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function applyTheme(dark: boolean) {
  const v = dark ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", v);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, v);
  } catch {
    /* private mode / storage disabled — the attribute still drives the paint */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // SSR-stable default; the real value is read from the pre-paint <html data-theme> on mount.
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync React state to the attribute the no-flash script already set (avoids an SSR hydration mismatch)
    setDark(t !== "light");
  }, []);

  const toggle = useCallback(() => {
    setDark((d) => {
      const next = !d;
      applyTheme(next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ dark, toggle }}>{children}</ThemeContext.Provider>;
}
