/* global qrcode */

/** Returns an inline SVG QR code for `text` (uses vendor/qrcode.js). */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const pad = 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
    }
  }
  const size = n + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** Pulls a box code out of whatever a QR code contained (a label URL or a bare code). */
export function parseCode(text) {
  const t = String(text || '').trim();
  const m = t.match(/#\/box\/([^/?#\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (/^[A-Z]+-\d+$/i.test(t)) return t.toUpperCase();
  return null;
}
