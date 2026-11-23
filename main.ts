// THE WORLD TODAY — Monday 23 November 2026
// A one-image broadsheet of the day's world news, drawn entirely in code.
// Node standard library only: own rasterizer, own 5x7 bitmap font, own PNG
// encoder (zlib). Writes entry.png into $MAKEFUN_OUTPUT_DIR (or /output).

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1024;
const H = 1024;
const img = new Uint8Array(W * H * 3);

const PAPER = [248, 243, 233];
const INK = [24, 21, 16];
const BODY = [54, 49, 41];
const ACCENT = [198, 74, 22];
const SKY_TOP = [38, 52, 74];
const SKY_LOW = [96, 110, 138];
const GLOBE_BLUE = [58, 110, 160];
const GLOBE_GREEN = [96, 140, 84];
const MERCURY = [198, 40, 20];

let clip = { x0: 0, y0: 0, x1: W, y1: H };

function px(x, y, c, a = 1) {
  x = Math.round(x); y = Math.round(y);
  if (x < clip.x0 || y < clip.y0 || x >= clip.x1 || y >= clip.y1) return;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = img[i] * (1 - a) + c[0] * a;
  img[i + 1] = img[i + 1] * (1 - a) + c[1] * a;
  img[i + 2] = img[i + 2] * (1 - a) + c[2] * a;
}

function rect(x, y, w, h, c, a = 1) {
  for (let yy = Math.round(y); yy < Math.round(y + h); yy++)
    for (let xx = Math.round(x); xx < Math.round(x + w); xx++) px(xx, yy, c, a);
}

function circle(cx, cy, r, c, a = 1) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const cov = Math.min(1, Math.max(0, r + 0.5 - d));
      if (cov > 0) px(x, y, c, a * cov);
    }
}

function line(x0, y0, x1, y1, wdt, c, a = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const pad = wdt / 2 + 1;
  for (let y = Math.floor(Math.min(y0, y1) - pad); y <= Math.max(y0, y1) + pad; y++)
    for (let x = Math.floor(Math.min(x0, x1) - pad); x <= Math.max(x0, x1) + pad; x++) {
      const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (len * len)));
      const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
      const cov = Math.min(1, Math.max(0, wdt / 2 + 0.5 - d));
      if (cov > 0) px(x, y, c, a * cov);
    }
}

function poly(pts, c, a = 1) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) px(x, y, c, a);
  }
}

function lerp(c1, c2, t) {
  return [0, 1, 2].map(i => Math.round(c1[i] * (1 - t) + c2[i] * t));
}

// Deterministic 2D hash in [0,1): the same on every run and machine, so
// the print grain below never breaks the two-runs-identical rule.
function hash(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Print grain: jitter every pixel's brightness by a hash of its position
// (optionally in blocks, which compress better and read as halftone).
function grain(x0, y0, x1, y1, amt, block = 1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 3;
    const n = (hash(Math.floor(x / block), Math.floor(y / block)) - 0.5) * 2 * amt;
    img[i] = Math.max(0, Math.min(255, img[i] + n));
    img[i + 1] = Math.max(0, Math.min(255, img[i + 1] + n));
    img[i + 2] = Math.max(0, Math.min(255, img[i + 2] + n * 0.92));
  }
}

function ellipse(cx, cy, rx, ry, c, a = 1) {
  const k = Math.max(4, Math.min(30, Math.min(rx, ry) * 1.2));
  for (let y = Math.floor(cy - ry - 2); y <= cy + ry + 2; y++)
    for (let x = Math.floor(cx - rx - 2); x <= cx + rx + 2; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const cov = Math.min(1, Math.max(0, (1 - d) * k));
      if (cov > 0) px(x, y, c, a * cov);
    }
}

// Spherical shading over a disc already painted in img: diffuse light
// from the upper left plus a soft specular glint, so a flat circle
// reads as a lit ball. Writes img directly; the disc must be painted.
function shadeDisc(cx, cy, r, darkAmt, specAmt) {
  const LX = -0.52, LY = -0.58, LZ = 0.63;
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const nx = (x - cx) / r, ny = (y - cy) / r, d2 = nx * nx + ny * ny;
      if (d2 > 1 || x < 0 || y < 0 || x >= W || y >= H) continue;
      const nz = Math.sqrt(1 - d2);
      const diff = Math.max(0, nx * LX + ny * LY + nz * LZ);
      const f = (1 - darkAmt) + (darkAmt + 0.10) * diff;
      const spec = specAmt * Math.pow(diff, 18) * 255;
      const i = (y * W + x) * 3;
      img[i] = Math.min(255, img[i] * f + spec);
      img[i + 1] = Math.min(255, img[i + 1] * f + spec);
      img[i + 2] = Math.min(255, img[i + 2] * f + spec * 0.95);
    }
}

// ---- 5x7 bitmap font (rows top to bottom, 5 bits per row, LSB = left) ----
// Bit order verified against the 22 November edition: glyphs render upright,
// S and the apostrophe use the corrected (bit-reversed) rows.
const FONT = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  'A': [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], 'B': [0x0F, 0x11, 0x11, 0x0F, 0x11, 0x11, 0x0F],
  'C': [0x0E, 0x11, 0x01, 0x01, 0x01, 0x11, 0x0E], 'D': [0x0F, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0F],
  'E': [0x1F, 0x01, 0x01, 0x0F, 0x01, 0x01, 0x1F], 'F': [0x1F, 0x01, 0x01, 0x0F, 0x01, 0x01, 0x01],
  'G': [0x0E, 0x11, 0x01, 0x1D, 0x11, 0x11, 0x1E], 'H': [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  'I': [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], 'J': [0x1C, 0x08, 0x08, 0x08, 0x08, 0x09, 0x06],
  'K': [0x11, 0x09, 0x05, 0x03, 0x05, 0x09, 0x11], 'L': [0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x1F],
  'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], 'N': [0x11, 0x13, 0x15, 0x19, 0x11, 0x11, 0x11],
  'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], 'P': [0x1E, 0x11, 0x11, 0x1E, 0x01, 0x01, 0x01],
  'Q': [0x0E, 0x11, 0x11, 0x11, 0x15, 0x09, 0x16], 'R': [0x1E, 0x11, 0x11, 0x1E, 0x05, 0x09, 0x11],
  'S': [0x1E, 0x01, 0x01, 0x0E, 0x10, 0x10, 0x0F], 'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], 'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11], 'X': [0x11, 0x0A, 0x04, 0x04, 0x04, 0x0A, 0x11],
  'Y': [0x11, 0x0A, 0x04, 0x04, 0x04, 0x04, 0x04], 'Z': [0x1F, 0x10, 0x08, 0x04, 0x02, 0x01, 0x1F],
  '0': [0x0E, 0x11, 0x19, 0x15, 0x13, 0x11, 0x0E], '1': [0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x0E],
  '2': [0x0E, 0x11, 0x10, 0x08, 0x04, 0x02, 0x1F], '3': [0x0E, 0x11, 0x10, 0x0C, 0x10, 0x11, 0x0E],
  '4': [0x08, 0x0C, 0x0A, 0x09, 0x1F, 0x08, 0x08], '5': [0x1F, 0x01, 0x0F, 0x10, 0x10, 0x11, 0x0E],
  '6': [0x0C, 0x02, 0x01, 0x0F, 0x11, 0x11, 0x0E], '7': [0x1F, 0x10, 0x08, 0x04, 0x02, 0x02, 0x02],
  '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E], '9': [0x0E, 0x11, 0x11, 0x1E, 0x10, 0x08, 0x06],
  '.': [0, 0, 0, 0, 0, 0x0C, 0x0C], ',': [0, 0, 0, 0, 0x0C, 0x04, 0x08],
  "'": [0x04, 0x04, 0x02, 0, 0, 0, 0], '-': [0, 0, 0, 0x1F, 0, 0, 0],
  ':': [0, 0x0C, 0x0C, 0, 0x0C, 0x0C, 0], ';': [0, 0x0C, 0x0C, 0, 0x0C, 0x04, 0x08],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04], '?': [0x0E, 0x11, 0x10, 0x08, 0x04, 0, 0x04],
  '"': [0x0A, 0x0A, 0x0A, 0, 0, 0, 0], '(': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  ')': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], '$': [0x04, 0x0F, 0x05, 0x0E, 0x14, 0x0F, 0x04],
  '%': [0x03, 0x13, 0x08, 0x04, 0x02, 0x19, 0x18], '&': [0x06, 0x09, 0x05, 0x02, 0x15, 0x09, 0x16],
  '/': [0x10, 0x08, 0x08, 0x04, 0x02, 0x02, 0x01], '+': [0, 0x04, 0x04, 0x1F, 0x04, 0x04, 0],
  '=': [0, 0x1F, 0, 0x1F, 0, 0, 0], '@': [0x0E, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0E],
};

function drawChar(x, y, ch, scale, c, bold) {
  if (ch === '—' || ch === '–') { rect(x, y + 3 * scale, 5 * scale, scale, c); return; }
  const g = FONT[ch] || FONT['?'];
  const off = bold ? Math.max(1, Math.round(scale / 3)) : 0;
  for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) {
    if (g[r] & (1 << col)) {
      rect(x + col * scale, y + r * scale, scale, scale, c);
      if (off) rect(x + col * scale + off, y + r * scale, scale, scale, c);
    }
  }
}

function textWidth(s, scale, tracking = 0) { return s.length * (6 * scale + tracking) - scale - tracking; }

function drawText(x, y, s, scale, c, opts = {}) {
  s = s.toUpperCase();
  const tracking = opts.tracking || 0;
  let cx = x;
  if (opts.align === 'center') cx = Math.round((W - textWidth(s, scale, tracking)) / 2);
  if (opts.align === 'right') cx = x - textWidth(s, scale, tracking);
  for (const ch of s) { drawChar(cx, y, ch, scale, c, opts.bold); cx += 6 * scale + tracking; }
  return 7 * scale;
}

function wrap(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawBlock(x, y, text, scale, c, maxChars, lineH, opts = {}) {
  const lines = wrap(text, maxChars);
  lines.forEach((ln, i) => drawText(x, y + i * lineH, ln, scale, c, opts));
  return lines.length * lineH;
}

// ---- background ----
rect(0, 0, W, H, PAPER);
// newsprint stock: a faint vignette, coarse block grain and sparse fibre
// flecks, so the sheet reads as printed paper rather than a flat fill
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
  const vig = 1 - 0.055 * Math.min(1, (dx * dx + dy * dy) / 2);
  const i = (y * W + x) * 3;
  const n = (hash(x >> 2, y >> 2) - 0.5) * 5;
  img[i] = img[i] * vig + n; img[i + 1] = img[i + 1] * vig + n; img[i + 2] = img[i + 2] * vig + n * 0.9;
  const f = hash(x * 3 + 11, y * 5 + 7);
  if (f > 0.99965) { img[i] -= 26; img[i + 1] -= 24; img[i + 2] -= 20; }       // dark fibre fleck
  else if (f < 0.0003) { img[i] += 15; img[i + 1] += 14; img[i + 2] += 11; }   // light fleck
}
const M = 44;                 // page margin
const IW = W - 2 * M;         // inner width = 936

// ---- masthead ----
drawText(0, 30, 'THE WORLD TODAY', 10, INK, { align: 'center', bold: true, tracking: 3 });
rect(M, 110, IW, 5, ACCENT);
rect(M, 119, IW, 2, INK);
drawText(0, 130, 'MONDAY 23 NOVEMBER 2026', 3, INK, { align: 'center', bold: true });
drawText(M, 132, 'ONE DAY, ONE IMAGE', 2, BODY);
drawText(W - M, 132, 'EST. 2026', 2, BODY, { align: 'right' });
rect(M, 160, IW, 1, INK);

// ---- lead story: COP31 collapses ----
drawText(M, 174, 'CLIMATE — COP31, ANTALYA', 3, ACCENT, { bold: true });
drawText(M, 202, 'COP31 TALKS COLLAPSE', 7, INK, { bold: true });
drawText(M, 260, 'IN ANTALYA', 7, INK, { bold: true });

// lead illustration: a cracked Earth under a dusk sky, a thermometer
// running hot, and the empty chairs of a summit hall that found no deal
const IX = M, IY = 330, IWd = IW, IH = 196;
clip = { x0: IX, y0: IY, x1: IX + IWd, y1: IY + IH };
// dusk sky, printed: the gradient is stepped and ordered-dithered so it
// carries a halftone grain instead of a flat digital ramp, and a warm
// glow sits low over the horizon where the talks burned out
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const GLOW = [216, 138, 74];
for (let yy = 0; yy < IH; yy++) for (let xx = 0; xx < IWd; xx++) {
  const t = Math.min(1, yy / (IH * 0.8));
  const steps = 26, v = t * (steps - 1), base = Math.floor(v);
  const idx = base + ((v - base) > (BAYER4[yy & 3][xx & 3] + 0.5) / 16 ? 1 : 0);
  let c = lerp(SKY_TOP, SKY_LOW, idx / (steps - 1));
  const gd = Math.hypot(xx - 660, (yy - 168) * 1.7);           // horizon glow
  const ga = Math.max(0, 1 - gd / 430) * 0.5;
  if (ga > 0) c = lerp(c, GLOW, ga);
  px(IX + xx, IY + yy, c);
}
// soft cloud banks: stacked translucent ellipses with feathered edges
for (const [cx, cy, rx, ry, a] of [[150, 52, 120, 9, 0.10], [430, 34, 150, 8, 0.08], [760, 58, 130, 10, 0.12], [250, 84, 170, 8, 0.07], [620, 92, 150, 7, 0.09]]) {
  for (let k = 4; k >= 1; k--) ellipse(IX + cx, IY + cy, rx * k / 4, ry * k / 4, [226, 222, 214], a);
}
// faint stars in the upper sky
for (const [sx, sy] of [[90, 22], [180, 44], [330, 16], [520, 30], [700, 18], [860, 40], [60, 70], [780, 66]]) {
  rect(IX + sx, IY + sy, 3, 3, PAPER, 0.8); rect(IX + sx + 1, IY + sy - 2, 1, 7, PAPER, 0.5);
}
const gx = IX + 250, gy = IY + 96, gr = 76;   // cracked globe
circle(gx, gy, gr + 6, [150, 186, 224], 0.45);   // atmosphere halo
circle(gx, gy, gr + 3, INK);                    // outline ring
clip = { x0: gx - gr, y0: gy - gr, x1: gx + gr, y1: gy + gr };
circle(gx, gy, gr, GLOBE_BLUE);
// ocean depth: deeper water toward the lower right, lit from upper left
for (let y = gy - gr; y <= gy + gr; y++) for (let x = gx - gr; x <= gx + gr; x++) {
  const nx = (x - gx) / gr, ny = (y - gy) / gr;
  if (nx * nx + ny * ny > 1) continue;
  const i = (y * W + x) * 3;
  const f = 1 - 0.16 * Math.max(0, nx * 0.6 + ny * 0.8) + 0.10 * Math.max(0, -(nx * 0.6 + ny * 0.8));
  img[i] *= f; img[i + 1] *= f; img[i + 2] *= f;
}
// continents in two tones: the land, its shadow side, a lit highland
for (const [lx, ly, lr] of [[-38, -28, 22], [-6, -40, 16], [30, -18, 20], [-30, 22, 24], [22, 30, 18], [44, 8, 12], [-52, 4, 13], [8, -2, 11]]) {
  circle(gx + lx + 3, gy + ly + 4, lr, [70, 112, 62]);
  circle(gx + lx, gy + ly, lr, GLOBE_GREEN);
  circle(gx + lx - lr * 0.3, gy + ly - lr * 0.3, lr * 0.45, [118, 158, 100]);
}
circle(gx + 34, gy - 34, 10, [172, 154, 98]);   // an arid belt
circle(gx - 30, gy - 52, 26, [236, 239, 240], 0.95);   // polar cap
shadeDisc(gx, gy, gr, 0.34, 0.45);              // sphere light + glint
// the crack: a pale split edge first, then the dark fault over it
const crack = [[-52, -58], [-30, -34], [-44, -12], [-14, 6], [-30, 26], [-2, 44], [-16, 62], [8, 76]];
for (let i = 0; i + 1 < crack.length; i++) line(gx + crack[i][0] + 3, gy + crack[i][1], gx + crack[i + 1][0] + 3, gy + crack[i + 1][1], 5, [212, 222, 230], 0.5);
for (let i = 0; i + 1 < crack.length; i++) line(gx + crack[i][0], gy + crack[i][1], gx + crack[i + 1][0], gy + crack[i + 1][1], 5, INK);
for (const [ox, oy] of [[-46, -44], [-24, -2], [-10, 34]]) {  // crack splinters
  line(gx + ox, gy + oy, gx + ox + 18, gy + oy - 12, 3, INK);
  line(gx + ox, gy + oy, gx + ox + 16, gy + oy + 10, 3, INK);
}
clip = { x0: IX, y0: IY, x1: IX + IWd, y1: IY + IH };
// thermometer: a soft shadow, a glass tube with a lit edge, and mercury
// graded from a hot bright head down to deep red at the bulb
const tx = IX + 560, ty = IY + 22, tw = 26, th = 118;
rect(tx + 4, ty + 4, tw, th, INK, 0.16);                       // shadow
circle(tx + tw / 2 + 4, ty + th + 17, 24, INK, 0.16);          // bulb shadow
rect(tx, ty, tw, th, [243, 241, 237]);                         // glass tube
for (let yy = 0; yy < th; yy++) rect(tx + 5, ty + yy, tw - 10, 1, lerp([240, 98, 44], [168, 30, 14], yy / th), yy > th * 0.22 ? 1 : 0);
rect(tx + 3, ty + 2, 4, th - 4, [255, 255, 255], 0.55);        // glass highlight
rect(tx + tw - 6, ty + 2, 3, th - 4, INK, 0.10);               // glass shade
circle(tx + tw / 2, ty + th + 14, 24, [243, 241, 237]);        // bulb glass
circle(tx + tw / 2, ty + th + 14, 19, [198, 42, 20]);          // bulb mercury
shadeDisc(tx + tw / 2, ty + th + 14, 19, 0.30, 0.5);           // bulb light + glint
rect(tx, ty, 2, th, INK); rect(tx + tw - 2, ty, 2, th, INK); rect(tx, ty, tw, 2, INK);
for (let k = 0; k < 5; k++) line(tx + tw + 2, ty + 10 + k * 26, tx + tw + 12, ty + 10 + k * 26, 2, INK);
drawText(tx + tw + 18, ty + 4, '40C', 3, INK, { bold: true });
// empty summit hall: a graded floor, a long table and vacant chairs
const base = IY + IH * 0.86;
for (let yy = 0; yy < IY + IH - base; yy++) rect(IX, base + yy, IWd, 1, lerp([54, 49, 42], [18, 16, 14], yy / (IY + IH - base)));
rect(IX + 40, base - 14, IWd - 80, 6, [233, 227, 215]);          // the long table, lit top
rect(IX + 40, base - 8, IWd - 80, 2, [122, 114, 102]);           // table front edge
for (let f = 0; f < 7; f++) {                           // empty chairs
  const cx0 = IX + 80 + f * 118;
  ellipse(cx0 + 17, base - 1, 24, 4, [0, 0, 0], 0.35);           // chair shadow
  rect(cx0, base - 34, 34, 4, [230, 224, 212]);                   // seat back
  rect(cx0 + 4, base - 30, 4, 16, [152, 145, 132]);               // legs
  rect(cx0 + 26, base - 30, 4, 16, [152, 145, 132]);
  rect(cx0, base - 14, 34, 4, [208, 200, 186]);                   // seat
  line(cx0 + 15, base - 14, cx0 + 18, base - 23, 2, [214, 208, 196], 0.9);   // gooseneck mic
  circle(cx0 + 18, base - 24, 2, [214, 208, 196], 0.9);
  rect(cx0 + 8, base - 10, 18, 3, ACCENT);              // name plate, no name
}
clip = { x0: 0, y0: 0, x1: W, y1: H };
rect(IX, IY, IWd, 2, INK); rect(IX, IY + IH - 2, IWd, 2, INK);
rect(IX, IY, 2, IH, INK); rect(IX + IWd - 2, IY, 2, IH, INK);
grain(IX, IY, IX + IWd, IY + IH, 6, 2);   // print grain over the picture

// lead summary
drawBlock(M, 542,
  "TALKS IN ANTALYA ENDED WITHOUT A DEAL AFTER THE EU AND OTHER COUNTRIES REFUSED ANY TEXT WITHOUT LANGUAGE ON A FOSSIL-FUEL PHASE-OUT. TURKIYE'S FINAL DRAFT OMITTED THE WORDS 'FOSSIL FUELS'. AUSTRALIAN PM ANTHONY ALBANESE CALLED THE FAILURE A SIGN OF 'DIFFICULT GEOPOLITICAL TIMES'.",
  2, BODY, 76, 17);
rect(M, 618, IW, 2, INK);

// ---- story boxes ----
function icon(kind, x, y) {
  if (kind === 'missile') {
    poly([[x, y + 16], [x + 10, y + 6], [x + 26, y + 6], [x + 32, y + 10], [x + 26, y + 14], [x + 10, y + 14]], ACCENT);
    poly([[x + 2, y + 14], [x + 10, y + 20], [x + 10, y + 14]], ACCENT);
    poly([[x + 2, y + 6], [x + 10, y], [x + 10, y + 6]], ACCENT);
  } else if (kind === 'drone') {
    rect(x + 9, y + 8, 14, 6, INK);
    circle(x + 6, y + 6, 5, ACCENT); circle(x + 26, y + 6, 5, ACCENT);
    line(x + 1, y + 6, x + 11, y + 6, 2, INK); line(x + 21, y + 6, x + 31, y + 6, 2, INK);
    circle(x + 16, y + 17, 3, ACCENT);
  } else if (kind === 'king') {
    rect(x + 14, y, 4, 6, ACCENT);
    rect(x + 11, y + 5, 10, 3, ACCENT);
    circle(x + 16, y + 12, 7, INK);
    rect(x + 9, y + 18, 14, 3, INK);
  } else if (kind === 'cap') {
    poly([[x + 16, y + 2], [x + 32, y + 9], [x + 16, y + 16], [x, y + 9]], INK);
    rect(x + 9, y + 12, 14, 6, INK);
    line(x + 29, y + 10, x + 29, y + 19, 2, ACCENT);
    circle(x + 29, y + 20, 2, ACCENT);
  } else if (kind === 'flame') {
    poly([[x + 16, y], [x + 24, y + 10], [x + 28, y + 6], [x + 30, y + 16], [x + 22, y + 22], [x + 10, y + 22], [x + 4, y + 15], [x + 8, y + 12], [x + 6, y + 6]], ACCENT);
    poly([[x + 16, y + 12], [x + 21, y + 17], [x + 17, y + 21], [x + 12, y + 19]], PAPER);
  }
}

function box(x, y, w, h, label, headline, summary, kind) {
  rect(x, y, w, 2, INK); rect(x, y + h - 2, w, 2, INK);
  rect(x, y, 2, h, INK); rect(x + w - 2, y, 2, h, INK);
  drawText(x + 12, y + 11, label, 2, ACCENT, { bold: true });
  icon(kind, x + w - 46, y + 8);
  const headLines = drawBlock(x + 12, y + 30, headline, 3, INK, Math.floor((w - 24) / 18), 26, { bold: true });
  drawBlock(x + 12, y + 30 + headLines + 4, summary, 2, BODY, Math.floor((w - 24) / 12), 16);
}

const row1Y = 632, row1H = 170;
box(M, row1Y, 460, row1H, 'WAR — US-IRAN', 'US-IRAN WAR WIDENS',
  "HOUTHIS CLAIM STRIKES ON A SAUDI OIL REFINERY AND RADAR, AT LEAST 6 INJURED; AN IRAN STRIKE WOUNDS TWO IN BAHRAIN. THE COALITION SAYS IT INTERCEPTED A HOUTHI MISSILE.", 'missile');
box(M + 476, row1Y, 460, row1H, 'WAR — UKRAINE', '14 MISSING AFTER DRONE STRIKE IN KYIV REGION',
  "AT LEAST 14 PEOPLE ARE MISSING AFTER A RUSSIAN DRONE HIT A BUILDING IN THE KYIV REGION, PRESIDENT ZELENSKYY SAYS. A RUSSIAN CARGO SHIP IS STILL ON FIRE OFF FINLAND AFTER AN ATTACK.", 'drone');

const row2Y = 814, row2H = 164, bw2 = 302;
box(M, row2Y, bw2, row2H, 'SPORT — CHESS', 'SINDAROV TAKES WHITE IN GAME 1',
  'THE 2026 FIDE WORLD CHAMPIONSHIP OPENS.', 'king');
box(M + 317, row2Y, bw2, row2H, 'ASIA — SOUTH KOREA', 'MINISTER QUITS IN AI CHEATING SCANDAL',
  "SOUTH KOREA'S EDUCATION MINISTER RESIGNS.", 'cap');
box(M + 634, row2Y, bw2, row2H, 'ASIA — INDONESIA', 'FACTORY FIRE: 7 DEAD, 50 MISSING',
  'SEVEN BODY BAGS RECOVERED; 50 MISSING AFTER A FACTORY FIRE.', 'flame');

// ---- footer ----
rect(M, 990, IW, 1, INK);
drawText(0, 998, 'DRAWN BY AN AI AGENT FROM THE DAILY WIRES', 2, BODY, { align: 'center' });

// one last whisper of grain over the whole sheet, text included, the
// way ink sits unevenly on real newsprint (kept faint: legibility first)
grain(0, 0, W, H, 2, 2);

// ---- PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
console.log('wrote', join(outDir, 'entry.png'), png.length, 'bytes');
