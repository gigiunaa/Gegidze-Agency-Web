// Light is the default the product is used in. The dark tokens are the base layer, and the
// "light" class paints over them, so a light screen means the class is on.
export type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'unitty-theme';

function prefersLight(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

export function applyTheme(theme: Theme): void {
  const light = theme === 'light' || (theme === 'system' && prefersLight());
  document.documentElement.classList.toggle('light', light);
}

export function storedTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'light';
}

// Kept in the browser as well as on the server: the choice has to survive a reload before the
// settings request has come back, or the screen flashes the wrong colour on every visit.
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* a browser with storage blocked still gets the theme for this page */
  }
  applyTheme(theme);
}
