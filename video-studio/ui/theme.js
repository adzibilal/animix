// Theme: auto (follows the system) → light → dark, remembered per browser. Loaded in <head> so the page never flashes the wrong theme.
(() => {
  const KEY = 'vs.theme', ORDER = ['auto', 'light', 'dark'], ICON = { auto: '◐', light: '☀', dark: '☾' };
  const NAME = { auto: 'Theme: follows your system', light: 'Theme: light', dark: 'Theme: dark' };
  let t = 'auto'; try { t = ORDER.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'auto'; } catch {}
  const apply = () => {
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    const b = document.getElementById('themeBtn');
    if (b) { b.textContent = ICON[t]; b.title = NAME[t] + ' · click to change'; b.setAttribute('aria-label', NAME[t]); }
  };
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('themeBtn'); if (!b) return;
    apply();
    b.onclick = () => { t = ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]; try { localStorage.setItem(KEY, t); } catch {} apply(); };
  });
})();
