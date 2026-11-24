// Crisp zero-dependency inline SVG icons for AGY Market Sidebar UI (`src/ui/icons.mjs`).
// Keeps all iconography sharp at every DPI across Dark, Light, and Wallpaper Prism glass surfaces.

export const BRAND_LOGO_SVG = `<svg viewBox="0 0 256 256" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="agym-bg" x1="24" y1="24" x2="232" y2="232" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#4F46E5"/>
      <stop offset="52%" stop-color="#7C3AED"/>
      <stop offset="100%" stop-color="#06B6D4"/>
    </linearGradient>
    <linearGradient id="agym-gem" x1="72" y1="68" x2="188" y2="192" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#E0E7FF"/>
    </linearGradient>
  </defs>
  <rect x="20" y="20" width="216" height="216" rx="54" fill="url(#agym-bg)"/>
  <rect x="23" y="23" width="210" height="210" rx="51" stroke="#FFFFFF" stroke-opacity="0.32" stroke-width="4"/>
  <path d="M74 96L90 68H166L182 96C182 106 174 114 164 114C154 114 146 106 146 96C146 106 138 114 128 114C118 114 110 106 110 96C110 106 102 114 92 114C82 114 74 106 74 96Z" fill="url(#agym-gem)"/>
  <path d="M84 126H172V178C172 186.837 164.837 194 156 194H100C91.163 194 84 186.837 84 178V126Z" fill="#FFFFFF" fill-opacity="0.2" stroke="#FFFFFF" stroke-width="8" stroke-linejoin="round"/>
  <path d="M128 136L146 158L128 180L110 158L128 136Z" fill="#38BDF8" stroke="#FFFFFF" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/>',
  update: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/><path d="M5 21h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  shield: '<path d="M12 3 5 6v6c0 5 3.5 8.5 7 9.5 3.5-1 7-4.5 7-9.5V6l-7-3Z"/>',
  shieldCheck: '<path d="M12 3 5 6v6c0 5 3.5 8.5 7 9.5 3.5-1 7-4.5 7-9.5V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  shieldAlert: '<path d="M12 3 5 6v6c0 5 3.5 8.5 7 9.5 3.5-1 7-4.5 7-9.5V6l-7-3Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5" opacity="0.55"/><path d="M12 12 18.4 5.6"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
  star: '<path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3 6.2 20.4l1.1-6.5-4.7-4.6 6.5-.9L12 2.5Z"/>',
  starFilled: '<path fill="currentColor" d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3 6.2 20.4l1.1-6.5-4.7-4.6 6.5-.9L12 2.5Z"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/>',
  alertTriangle: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  message: '<path d="M21 14a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.4 5.6L8 16l2.4-5.6L16 8Z"/>',
  package: '<path d="m12 2 8.5 4.9v9.8L12 21.6l-8.5-4.9V6.9L12 2Z"/><path d="M12 21.6V12"/><path d="m20.5 6.9-8.5 5.1-8.5-5.1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v5.5L4.8 18A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-3L14 8.5V3"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  hook: '<path d="M17.5 19H9a5 5 0 0 1-5-5V5"/><path d="M15 5h4v4"/><path d="m14 10 5-5"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v4"/><path d="M15 1v4"/><path d="M9 19v4"/><path d="M15 19v4"/><path d="M1 9h4"/><path d="M1 15h4"/><path d="M19 9h4"/><path d="M19 15h4"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 4 13C4 7 11 3 20 3c0 9-4 17-9 17Z"/><path d="M4 20c2-3 5-6 10-8"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m16 7 3 3"/><path d="m18.5 4.5 2 2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

export function icon(name, size = 14, extraClass = '') {
  const body = PATHS[name] || PATHS.sparkle;
  const cls = extraClass ? ` class="ui-ico ${extraClass}"` : ' class="ui-ico"';
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const BADGE_ICON_MAP = Object.freeze({
  'declarative-only': 'leaf',
  'global-rules': 'fileText',
  'sidecar-ui': 'panel',
  'mcp-stdio': 'cpu',
  'mcp-remote': 'globe',
  'lifecycle-hooks': 'hook',
  'host-enhancement': 'sparkle',
});

export function badgeIcon(badgeId, size = 11) {
  return icon(BADGE_ICON_MAP[badgeId] || 'layers', size, 'badge-ico');
}
