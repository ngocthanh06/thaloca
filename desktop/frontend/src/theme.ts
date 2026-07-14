// Light/dark theme — a single `data-theme` attribute on <html>, read by
// every color in style.css via CSS custom properties, so switching it is
// enough to re-theme the whole app with no per-view re-render. The choice
// is a frontend-only preference (like Source Control's pinned-repos set in
// views/sourceControl.ts), so it's kept in localStorage rather than a new
// Go-backed setting.
export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'thaloca-theme'

export function getTheme(): Theme {
  return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme)
  document.documentElement.dataset.theme = theme
}

// Applies whatever theme is already stored (or the 'dark' default) — call
// once at startup. index.html also runs an inline copy of this same read
// before main.ts loads, so the correct theme is set before first paint;
// this call just keeps the two in sync as the app's own source of truth.
export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = getTheme()
}
