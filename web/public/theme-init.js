/**
 * Applies the persisted theme before the app bundle loads, preventing a flash
 * of the wrong theme on startup.
 *
 * Loaded as a blocking <script src> in index.html (not inline) so it satisfies
 * the production Content-Security-Policy, which allows script-src 'self' but
 * not 'unsafe-inline'.
 *
 * The localStorage key and resolution logic are mirrored in
 * src/contexts/ThemeContext.tsx — keep them in sync.
 */
(function () {
  try {
    var stored = localStorage.getItem('runbooks-theme');
    var theme =
      stored === 'light' || stored === 'dark' || stored === 'system'
        ? stored
        : 'system';
    var isDark =
      theme === 'dark' ||
      (theme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
  } catch {
    /* localStorage unavailable (e.g. private mode) — fall back to light */
  }
})();
