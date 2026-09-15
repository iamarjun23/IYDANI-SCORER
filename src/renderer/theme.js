// Light / dark theme toggle. Driven by the `data-theme` attribute on <html>
// — CSS variables in index.html flip on this attribute.

const root = document.documentElement;

export function setThemeIcon() {
  const dark = root.getAttribute('data-theme') === 'dark';
  document.getElementById('themeIcon').innerHTML = dark
    ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
}

export function toggleTheme() {
  root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  setThemeIcon();
}
