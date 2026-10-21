import { signal } from "@preact/signals";

/** Colour theme: the OS setting (default), or forced to light or dark. */
export type Theme = "system" | "light" | "dark";

const THEME_KEY = "memory-theme";

export const THEME_LABEL: Record<Theme, string> = { system: "OS setting", light: "light", dark: "dark" };
/** Text glyphs; U+FE0E keeps the sun from being drawn as a colour emoji. */
export const THEME_GLYPH: Record<Theme, string> = { system: "◐", light: "☀︎", dark: "☾" };

/** The choice is remembered in this browser (localStorage); OS setting stores nothing. */
function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export const theme = signal<Theme>(loadTheme());

/** Order of the toggle: OS setting → light → dark → OS setting. */
export function nextTheme(t: Theme): Theme {
  return t === "system" ? "light" : t === "light" ? "dark" : "system";
}

/** Sets <html data-theme>, which the style sheet reads to override the OS setting. */
export function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  theme.value = t;
  applyTheme(t);
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    // storage unavailable: the choice lasts until the page is reloaded
  }
}
