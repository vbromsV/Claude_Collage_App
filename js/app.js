import { loadGifLibs, GifFramePlayer, decodeGifFirstFrame } from './gif.js';

const APP_VERSION = '1.0.0';

/* ============================================================
   Constants
   ============================================================ */
const BASE = 1080;                 // logical long side of the composition
const JPEG_LONG = 2048;            // exported JPEG long side (px)
const GIF_LONG = 720;              // exported GIF long side (px)
const PREVIEW_MAX = 2560;          // max long side of decoded images kept in memory
const ZOOM_MIN = 0.5, ZOOM_MAX = 5;
const MIN_SLOT = 0.12;             // smallest slot as fraction of the collage
const DIVIDER_HIT_PX = 22;         // touch radius for dividers, in screen px
const TAP_MOVE_PX = 10;
const DOUBLE_TAP_MS = 350;

const RATIOS = [
  ['1:1', 1, 1], ['16:9', 16, 9], ['9:16', 9, 16], ['4:5', 4, 5], ['21:9', 21, 9],
  ['4:3', 4, 3], ['3:4', 3, 4], ['2:3', 2, 3], ['3:2', 3, 2], ['5:4', 5, 4],
];
const FONT_SIZES = [16, 24, 32, 40, 48, 64, 80, 120, 160, 200];
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const ACCEPT_MIME = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif'];
const ACCEPT_EXT = /\.(jpe?g|png|webp|gif)$/i;

const MSG = {
  unsupported: 'Unsupported file type.',
  tooMany: 'You can add up to 3 images.',
  gifUnavailable: 'GIF export is unavailable on this device. Exported as JPEG instead.',
  collectionEmpty: 'No images in this collection.',
  saveFailed: 'Could not save. Try again.',
};

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ============================================================
   State
   ============================================================ */
const newSlot = () => ({ img: null, collection: [], bag: [], lastPick: -1 });
const newTransform = () => ({ zoom: 1, px: 0, py: 0, rot: 0, flip: false });

const state = {
  orientation: 'h',
  ratio: '1:1',
  freeW: 1,
  freeH: 1,
  slots: [newSlot(), newSlot()],
  dividers: [0.5],
  texts: [],
  nextTextId: 1,
  sel: { type: 'slot', index: 0 },
  lastSlot: 0,
  rotateGesture: loadSetting('rotateGesture', true),
};

const ui = { hoverDivider: -1, dragDivider: -1, tab: 'images' };

function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem('collage.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function saveSetting(key, value) {
  try { localStorage.setItem('collage.' + key, JSON.stringify(value)); } catch { /* ignore */ }
}

/* ============================================================
   Helpers
   ============================================================ */
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapDeg = (d) => ((d % 360) + 360) % 360;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slotLabels(count = state.slots.length, orient = state.orientation) {
  if (orient === 'h') return count === 3 ? ['Left', 'Middle', 'Right'] : ['Left', 'Right'];
  return count === 3 ? ['Top', 'Middle', 'Bottom'] : ['Top', 'Bottom'];
}

function ratioValue() {
  if (state.ratio === 'free') return clamp(state.freeW / state.freeH, 0.1, 10);
  const r = RATIOS.find((x) => x[0] === state.ratio);
  return r[1] / r[2];
}

function compSize() {
  const r = ratioValue();
  return r >= 1 ? { W: BASE, H: Math.round(BASE / r) } : { W: Math.round(BASE * r), H: BASE };
}

function slotRects(W, H) {
  const edges = [0, ...state.dividers, 1];
  return state.slots.map((_, i) => state.orientation === 'h'
    ? { x: edges[i] * W, y: 0, w: (edges[i + 1] - edges[i]) * W, h: H }
    : { x: 0, y: edges[i] * H, w: W, h: (edges[i + 1] - edges[i]) * H });
}

function evenDividers(n) {
  return n === 3 ? [1 / 3, 2 / 3] : [0.5];
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function isSupportedFile(file) {
  const t = (file.type || '').toLowerCase();
  if (t && ACCEPT_MIME.includes(t)) return true;
  return ACCEPT_EXT.test(file.name || '');
}
function isGifFile(file) {
  return (file.type || '').toLowerCase() === 'image/gif' || /\.gif$/i.test(file.name || '');
}

function selectedSlotIndex() {
  return state.sel.type === 'slot' ? state.sel.index : clamp(state.lastSlot, 0, state.slots.length - 1);
}
function selectedText() {
  return state.sel.type === 'text' ? state.texts.find((t) => t.id === state.sel.id) || null : null;
}

/* ============================================================
   Image loading
   ============================================================ */
class UnsupportedError extends Error {}

function downscaleToCanvas(source, w, h) {
  const s = Math.min(1, PREVIEW_MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

function loadHtmlImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ img, url }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new UnsupportedError('decode')); };
    img.src = url;
  });
}

async function loadImageFile(file) {
  if (!isSupportedFile(file)) throw new UnsupportedError('type');
  if (isGifFile(file)) {
    const buffer = await file.arrayBuffer();
    try {
      const first = await decodeGifFirstFrame(buffer);
      return {
        name: file.name, isGif: true, gifBuffer: buffer, gifFrames: first.frames,
        natW: first.width, natH: first.height,
        preview: downscaleToCanvas(first.canvas, first.width, first.height),
        tf: newTransform(),
      };
    } catch (err) {
      // GIF decoder unavailable or file odd: fall back to the browser's decoder (first frame).
      console.warn('GIF decode fallback', err);
      const { img, url } = await loadHtmlImage(file);
      const out = {
        name: file.name, isGif: true, gifBuffer: buffer, gifFrames: 0,
        natW: img.naturalWidth, natH: img.naturalHeight,
        preview: downscaleToCanvas(img, img.naturalWidth, img.naturalHeight),
        tf: newTransform(),
      };
      URL.revokeObjectURL(url);
      return out;
    }
  }
  const { img, url } = await loadHtmlImage(file);
  try {
    if (!img.naturalWidth || !img.naturalHeight) throw new UnsupportedError('empty');
    return {
      name: file.name, isGif: false, gifBuffer: null,
      natW: img.naturalWidth, natH: img.naturalHeight,
      preview: downscaleToCanvas(img, img.naturalWidth, img.naturalHeight),
      tf: newTransform(),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ============================================================
   Drawing
   ============================================================ */
const measureCtx = document.createElement('canvas').getContext('2d');

function fontFor(size) { return `700 ${size}px ${FONT_STACK}`; }

function textLayout(t, W, H) {
  measureCtx.font = fontFor(t.size);
  const lines = (t.text && t.text.length ? t.text : ' ').split('\n');
  const lh = t.size * 1.2;
  const tw = Math.max(1, ...lines.map((l) => measureCtx.measureText(l).width));
  const th = lh * lines.length;
  const pad = t.size * 0.3;
  const cx = t.fullWidth ? W / 2 : t.x * W;
  const cy = t.y * H;
  const box = t.fullWidth
    ? { x: 0, y: cy - th / 2 - pad, w: W, h: th + pad * 2 }
    : { x: cx - tw / 2 - pad, y: cy - th / 2 - pad, w: tw + pad * 2, h: th + pad * 2 };
  return { lines, lh, cx, cy, th, box };
}

function drawText(ctx, t, W, H) {
  const L = textLayout(t, W, H);
  if (t.bg && t.bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(t.bgColor, t.bgOpacity / 100);
    ctx.fillRect(L.box.x, L.box.y, L.box.w, L.box.h);
  }
  ctx.font = fontFor(t.size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = t.color;
  if (!t.bg || t.bgOpacity < 30) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = t.size * 0.12;
  }
  L.lines.forEach((line, i) => {
    ctx.fillText(line, L.cx, L.cy - L.th / 2 + L.lh * (i + 0.5));
  });
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

function drawSlotImage(ctx, img, src, r) {
  const fit = Math.max(r.w / img.natW, r.h / img.natH);
  const s = fit * img.tf.zoom;
  ctx.translate(r.x + r.w / 2 + img.tf.px * r.w, r.y + r.h / 2 + img.tf.py * r.h);
  ctx.rotate(img.tf.rot * Math.PI / 180);
  ctx.scale(img.tf.flip ? -s : s, s);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -img.natW / 2, -img.natH / 2, img.natW, img.natH);
}

function drawPlaceholder(ctx, r, unit) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const m = Math.min(r.w, r.h);
  const rad = clamp(m * 0.12, 18 * unit, 60 * unit);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2 * unit;
  ctx.beginPath();
  ctx.arc(cx, cy - rad * 0.4, rad, 0, Math.PI * 2);
  ctx.moveTo(cx - rad * 0.45, cy - rad * 0.4);
  ctx.lineTo(cx + rad * 0.45, cy - rad * 0.4);
  ctx.moveTo(cx, cy - rad * 0.85);
  ctx.lineTo(cx, cy + rad * 0.05);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `600 ${13 * unit}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('Tap to add image', cx, cy + rad * 0.85);
}

/**
 * Draws the whole collage in logical coordinates (W x H).
 * opts.preview: draw editor chrome (borders, dividers, selection).
 * opts.override: { index, canvas } replaces one slot's source (GIF frames).
 * opts.unit: logical units per screen px (for chrome line widths).
 */
function drawComposition(ctx, W, H, opts = {}) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const rects = slotRects(W, H);
  const unit = opts.unit || 1;

  state.slots.forEach((slot, i) => {
    const r = rects[i];
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    if (opts.preview) {
      ctx.fillStyle = '#0b0b0d';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (slot.img) {
      const src = opts.override && opts.override.index === i ? opts.override.canvas : slot.img.preview;
      drawSlotImage(ctx, slot.img, src, r);
    } else if (opts.preview) {
      drawPlaceholder(ctx, r, unit);
    }
    ctx.restore();
  });

  for (const t of state.texts) if (t.visible) drawText(ctx, t, W, H);

  if (!opts.preview) return;

  // slot borders
  ctx.lineWidth = unit;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  rects.forEach((r) => ctx.strokeRect(r.x + unit / 2, r.y + unit / 2, r.w - unit, r.h - unit));

  // dividers
  const edges = state.dividers;
  edges.forEach((e, i) => {
    let color = 'rgba(255,255,255,0.45)', width = 2 * unit;
    if (ui.dragDivider === i) { color = getAccent(); width = 4 * unit; }
    else if (ui.hoverDivider === i) { color = 'rgba(255,255,255,0.9)'; width = 4 * unit; }
    ctx.fillStyle = color;
    if (state.orientation === 'h') {
      ctx.fillRect(e * W - width / 2, 0, width, H);
      drawDividerKnob(ctx, e * W, H / 2, unit, color, true);
    } else {
      ctx.fillRect(0, e * H - width / 2, W, width);
      drawDividerKnob(ctx, W / 2, e * H, unit, color, false);
    }
  });

  // active slot
  if (state.sel.type === 'slot' && rects[state.sel.index]) {
    const r = rects[state.sel.index];
    ctx.lineWidth = 2 * unit;
    ctx.strokeStyle = getAccent();
    ctx.strokeRect(r.x + unit, r.y + unit, r.w - 2 * unit, r.h - 2 * unit);
  }

  // active text
  const st = selectedText();
  if (st) {
    const b = textLayout(st, W, H).box;
    ctx.lineWidth = 2 * unit;
    ctx.strokeStyle = getAccent();
    ctx.setLineDash([6 * unit, 4 * unit]);
    ctx.strokeRect(b.x + unit, b.y, b.w - 2 * unit, b.h);
    ctx.setLineDash([]);
    if (!st.visible) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }
}

function drawDividerKnob(ctx, x, y, unit, color, vertical) {
  const long = 28 * unit, short = 8 * unit;
  const w = vertical ? short : long, h = vertical ? long : short;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, short / 2);
  else ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill();
}

let accentCache = null;
function getAccent() {
  if (!accentCache) accentCache = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3fa2ff';
  return accentCache;
}

/* ============================================================
   Preview canvas
   ============================================================ */
const stage = $('stage');
const stageCtx = stage.getContext('2d');
const pv = { scale: 1, W: BASE, H: BASE };
let renderQueued = false;

function layoutStage() {
  const area = $('canvasArea').getBoundingClientRect();
  const { W, H } = compSize();
  const pad = 12;
  const aw = Math.max(40, area.width - pad * 2);
  const ah = Math.max(40, area.height - pad * 2);
  const s = Math.min(aw / W, ah / H);
  const cssW = Math.max(1, Math.floor(W * s));
  const cssH = Math.max(1, Math.floor(H * s));
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  stage.style.width = cssW + 'px';
  stage.style.height = cssH + 'px';
  const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (stage.width !== bw) stage.width = bw;
  if (stage.height !== bh) stage.height = bh;
  pv.scale = cssW / W;
  pv.W = W;
  pv.H = H;
  renderNow(); // render in the same frame as the resize, so no blank frame is shown
}

function renderNow() {
  renderQueued = false;
  stageCtx.setTransform(stage.width / pv.W, 0, 0, stage.height / pv.H, 0, 0);
  drawComposition(stageCtx, pv.W, pv.H, { preview: true, unit: 1 / pv.scale });
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(renderNow);
}

new ResizeObserver(() => layoutStage()).observe($('canvasArea'));
window.addEventListener('orientationchange', () => setTimeout(layoutStage, 200));

/* ============================================================
   Hit testing
   ============================================================ */
function toLogical(e) {
  const r = stage.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * pv.W / r.width,
    y: (e.clientY - r.top) * pv.H / r.height,
  };
}

function hitText(p) {
  const pad = 8 / pv.scale;
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i];
    if (!t.visible) continue;
    const b = textLayout(t, pv.W, pv.H).box;
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return t;
  }
  return null;
}

function hitDivider(p) {
  const tol = DIVIDER_HIT_PX / pv.scale;
  let best = -1, bestD = Infinity;
  state.dividers.forEach((e, i) => {
    const d = state.orientation === 'h' ? Math.abs(p.x - e * pv.W) : Math.abs(p.y - e * pv.H);
    if (d <= tol && d < bestD) { best = i; bestD = d; }
  });
  return best;
}

function hitSlot(p) {
  const rects = slotRects(pv.W, pv.H);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return i;
  }
  return -1;
}

/* ============================================================
   Selection
   ============================================================ */
function selectSlot(i) {
  state.sel = { type: 'slot', index: i };
  state.lastSlot = i;
  if (ui.tab === 'text') setTab('images');
  syncUI();
  requestRender();
}

function selectText(id) {
  state.sel = { type: 'text', id };
  if (ui.tab === 'images') setTab('text');
  syncUI();
  requestRender();
}

/* ============================================================
   Transform operations
   ============================================================ */
function zoomRotateAround(index, m0, m1, k, dRad) {
  const slot = state.slots[index];
  if (!slot || !slot.img) return;
  const tf = slot.img.tf;
  const r = slotRects(pv.W, pv.H)[index];
  const newZoom = clamp(tf.zoom * k, ZOOM_MIN, ZOOM_MAX);
  k = newZoom / tf.zoom;
  const C = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const P = { x: tf.px * r.w, y: tf.py * r.h };
  const M0 = { x: m0.x - C.x, y: m0.y - C.y };
  const M1 = { x: m1.x - C.x, y: m1.y - C.y };
  const vx = P.x - M0.x, vy = P.y - M0.y;
  const cos = Math.cos(dRad), sin = Math.sin(dRad);
  tf.px = (M1.x + k * (vx * cos - vy * sin)) / r.w;
  tf.py = (M1.y + k * (vx * sin + vy * cos)) / r.h;
  tf.zoom = newZoom;
  tf.rot = wrapDeg(tf.rot + dRad * 180 / Math.PI);
}

function resetSlot(index) {
  const slot = state.slots[index];
  if (!slot || !slot.img) return;
  slot.img.tf = newTransform();
  syncUI();
  requestRender();
}

function moveDivider(i, p) {
  const f = state.orientation === 'h' ? p.x / pv.W : p.y / pv.H;
  const lo = (i === 0 ? 0 : state.dividers[i - 1]) + MIN_SLOT;
  const hi = (i === state.dividers.length - 1 ? 1 : state.dividers[i + 1]) - MIN_SLOT;
  state.dividers[i] = clamp(f, lo, hi);
}

/* ============================================================
   Pointer gestures on the canvas
   ============================================================ */
const pointers = new Map();
let gesture = null;
let tapInfo = null;
let lastTap = { time: 0, key: '' };

function twoPointerSnapshot() {
  const [a, b] = [...pointers.values()];
  return {
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    dist: Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y)),
    ang: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const p = toLogical(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 1) {
    tapInfo = { sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false, target: null };
    const t = hitText(p);
    if (t) {
      selectText(t.id);
      gesture = { kind: 'text', id: t.id };
      tapInfo.target = { type: 'text', id: t.id };
      return;
    }
    const d = hitDivider(p);
    if (d >= 0) {
      gesture = { kind: 'divider', index: d };
      ui.dragDivider = d;
      requestRender();
      return;
    }
    const si = hitSlot(p);
    if (si >= 0) {
      const wasSelected = state.sel.type === 'slot' && state.sel.index === si;
      selectSlot(si);
      gesture = { kind: 'pan', index: si };
      tapInfo.target = { type: 'slot', index: si, wasSelected };
    }
  } else if (pointers.size === 2) {
    tapInfo = null;
    if (!gesture || gesture.kind === 'divider') return;
    const snap = twoPointerSnapshot();
    if (gesture.kind === 'text' || gesture.kind === 'textpinch') {
      const t = state.texts.find((x) => x.id === gesture.id);
      if (t) gesture = { kind: 'textpinch', id: t.id, startSize: t.size, startDist: snap.dist };
      return;
    }
    const idx = gesture.index ?? selectedSlotIndex();
    gesture = { kind: 'pinch', index: idx, ...snap };
  }
});

stage.addEventListener('pointermove', (e) => {
  const p = toLogical(e);
  if (!pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse') {
      const d = hitDivider(p);
      if (d !== ui.hoverDivider) {
        ui.hoverDivider = d;
        requestRender();
      }
      stage.style.cursor = d >= 0 ? (state.orientation === 'h' ? 'col-resize' : 'row-resize')
        : (hitText(p) ? 'move' : 'default');
    }
    return;
  }
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, p);
  if (tapInfo && Math.hypot(e.clientX - tapInfo.sx, e.clientY - tapInfo.sy) > TAP_MOVE_PX) tapInfo.moved = true;
  if (!gesture) return;

  switch (gesture.kind) {
    case 'divider':
      moveDivider(gesture.index, p);
      break;
    case 'pan': {
      if (pointers.size !== 1) break;
      const slot = state.slots[gesture.index];
      if (!slot || !slot.img) break;
      const r = slotRects(pv.W, pv.H)[gesture.index];
      slot.img.tf.px += (p.x - prev.x) / r.w;
      slot.img.tf.py += (p.y - prev.y) / r.h;
      break;
    }
    case 'text': {
      if (pointers.size !== 1) break;
      const t = state.texts.find((x) => x.id === gesture.id);
      if (!t) break;
      if (!t.fullWidth) t.x = clamp(t.x + (p.x - prev.x) / pv.W, 0, 1);
      t.y = clamp(t.y + (p.y - prev.y) / pv.H, 0, 1);
      break;
    }
    case 'textpinch': {
      if (pointers.size !== 2) break;
      const t = state.texts.find((x) => x.id === gesture.id);
      if (!t) break;
      const snap = twoPointerSnapshot();
      t.size = Math.round(clamp(gesture.startSize * snap.dist / gesture.startDist, 8, 400));
      syncTextControls();
      break;
    }
    case 'pinch': {
      if (pointers.size !== 2) break;
      const snap = twoPointerSnapshot();
      let dA = snap.ang - gesture.ang;
      if (dA > Math.PI) dA -= Math.PI * 2;
      if (dA < -Math.PI) dA += Math.PI * 2;
      if (!state.rotateGesture) dA = 0;
      zoomRotateAround(gesture.index, gesture.mid, snap.mid, snap.dist / gesture.dist, dA);
      Object.assign(gesture, snap);
      syncRotation();
      break;
    }
  }
  requestRender();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (e.type === 'pointerup' && tapInfo && !tapInfo.moved && performance.now() - tapInfo.t < 600) {
      handleTap(tapInfo.target);
    }
    if (gesture && gesture.kind === 'divider') ui.dragDivider = -1;
    gesture = null;
    tapInfo = null;
    syncUI();
    requestRender();
  } else if (pointers.size === 1 && gesture) {
    if (gesture.kind === 'pinch') gesture = { kind: 'pan', index: gesture.index };
    else if (gesture.kind === 'textpinch') gesture = { kind: 'text', id: gesture.id };
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && ui.hoverDivider !== -1 && !pointers.has(e.pointerId)) {
    ui.hoverDivider = -1;
    requestRender();
  }
});

function handleTap(target) {
  if (!target) return;
  const now = performance.now();
  const key = target.type === 'text' ? 'text:' + target.id : 'slot:' + target.index;
  const isDouble = lastTap.key === key && now - lastTap.time < DOUBLE_TAP_MS;
  lastTap = { time: isDouble ? 0 : now, key };

  if (target.type === 'text') {
    if (isDouble) editText(target.id);
    return;
  }
  if (!state.slots[target.index].img) openChangePicker(target.index);
}

// Mouse wheel zoom (optional for devices with a mouse)
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = toLogical(e);
  const si = hitSlot(p);
  if (si < 0) return;
  if (!(state.sel.type === 'slot' && state.sel.index === si)) selectSlot(si);
  zoomRotateAround(si, p, p, Math.exp(-e.deltaY * 0.0015), 0);
  requestRender();
}, { passive: false });

// Stop iOS page pinch-zoom
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

/* ============================================================
   Adding / changing images
   ============================================================ */
let changeTarget = 0;

function openChangePicker(index) {
  changeTarget = index;
  const input = $('fileChange');
  input.value = '';
  input.click();
}

$('fileChange').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  await setSlotImageFromFile(changeTarget, file);
});

async function setSlotImageFromFile(index, file) {
  try {
    const img = await loadImageFile(file);
    const slot = state.slots[index];
    if (!slot) return false;
    slot.img = img;
    state.sel = { type: 'slot', index };
    state.lastSlot = index;
    syncUI();
    requestRender();
    return true;
  } catch (err) {
    console.warn(err);
    toast(MSG.unsupported, true);
    return false;
  }
}

$('btnAddImages').addEventListener('click', () => {
  const input = $('fileAdd');
  input.value = '';
  input.click();
});

$('fileAdd').addEventListener('change', async (e) => {
  let files = [...(e.target.files || [])];
  if (!files.length) return;
  const supported = files.filter(isSupportedFile);
  if (supported.length < files.length) toast(MSG.unsupported, true);
  files = supported;
  if (!files.length) return;

  const filledCount = state.slots.filter((s) => s.img).length;
  if (state.slots.length === 2 && filledCount + files.length > 2) setSlotCount(3, { silent: true });

  const empty = state.slots.map((s, i) => (s.img ? -1 : i)).filter((i) => i >= 0);
  if (files.length > empty.length) {
    toast(MSG.tooMany, true);
    files = files.slice(0, empty.length);
  }
  let first = -1;
  for (let k = 0; k < files.length; k++) {
    const ok = await setSlotImageFromFile(empty[k], files[k]);
    if (ok && first < 0) first = empty[k];
  }
  if (first >= 0) selectSlot(first);
});

/* ============================================================
   Layout changes
   ============================================================ */
async function setSlotCount(n, { silent = false } = {}) {
  if (n === state.slots.length) return;
  if (n === 3) {
    state.slots.splice(1, 0, newSlot());
    state.dividers = evenDividers(3);
    if (state.sel.type === 'slot' && state.sel.index >= 1) state.sel.index++;
  } else {
    const middle = state.slots[1];
    if (middle.img && !silent) {
      const labels = slotLabels(3);
      const left = state.slots[0], right = state.slots[2];
      const choice = await showDialog({
        title: 'Remove middle slot?',
        body: `<p>The middle slot has an image. What should happen to it?</p>`,
        buttons: [
          { label: 'Discard', value: 'discard', danger: true },
          { label: (left.img ? 'Replace ' : 'Move to ') + labels[0], value: 'left' },
          { label: (right.img ? 'Replace ' : 'Move to ') + labels[2], value: 'right' },
          { label: 'Cancel', value: 'cancel' },
        ],
      });
      if (choice === 'cancel' || choice == null) { syncUI(); return; }
      if (choice === 'left') { middle.img.tf = newTransform(); left.img = middle.img; }
      if (choice === 'right') { middle.img.tf = newTransform(); right.img = middle.img; }
    }
    state.slots.splice(1, 1);
    state.dividers = evenDividers(2);
    if (state.sel.type === 'slot') state.sel.index = Math.max(0, state.sel.index - (state.sel.index >= 1 ? 1 : 0));
  }
  state.lastSlot = clamp(state.lastSlot, 0, state.slots.length - 1);
  syncUI();
  layoutStage();
}

function setOrientation(o) {
  if (state.orientation === o) return;
  state.orientation = o;
  syncUI();
  layoutStage();
}

function setRatio(key) {
  state.ratio = key;
  syncUI();
  layoutStage();
}

/* ============================================================
   Text overlays
   ============================================================ */
function addText() {
  const t = {
    id: state.nextTextId++,
    text: 'Your text',
    x: 0.5, y: 0.5,
    size: 64,
    color: '#ffffff',
    bg: true, bgColor: '#000000', bgOpacity: 50,
    fullWidth: false,
    visible: true,
  };
  state.texts.push(t);
  selectText(t.id);
  editText(t.id, true);
}

function removeSelectedText() {
  const t = selectedText();
  if (!t) return;
  state.texts = state.texts.filter((x) => x.id !== t.id);
  const last = state.texts[state.texts.length - 1];
  if (last) state.sel = { type: 'text', id: last.id };
  else state.sel = { type: 'slot', index: clamp(state.lastSlot, 0, state.slots.length - 1) };
  syncUI();
  requestRender();
}

async function editText(id, isNew = false) {
  const t = state.texts.find((x) => x.id === id);
  if (!t) return;
  const ta = document.createElement('textarea');
  ta.value = t.text;
  ta.rows = 3;
  ta.setAttribute('aria-label', 'Text');
  const res = await showDialog({
    title: isNew ? 'Add text' : 'Edit text',
    bodyEl: ta,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Done', value: 'ok', primary: true }],
    onOpen: () => { ta.focus(); if (isNew) ta.select(); },
  });
  if (res === 'ok') {
    t.text = ta.value.replace(/\r/g, '');
    if (!t.text.trim()) t.text = isNew ? 'Your text' : t.text;
  }
  syncUI();
  requestRender();
}

/* ============================================================
   Collections and randomize
   ============================================================ */
let collectionTarget = 0;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function refillBag(slot) {
  slot.bag = shuffle(slot.collection.map((_, i) => i));
  // avoid showing the same image twice in a row across cycles
  if (slot.bag.length > 1 && slot.bag[slot.bag.length - 1] === slot.lastPick) {
    const last = slot.bag.length - 1;
    [slot.bag[last], slot.bag[0]] = [slot.bag[0], slot.bag[last]];
  }
}

async function randomizeSlot(index, { quiet = false } = {}) {
  const slot = state.slots[index];
  if (!slot || !slot.collection.length) {
    if (!quiet) toast(MSG.collectionEmpty, true);
    return false;
  }
  // try a few times in case a file can't be read anymore
  for (let attempt = 0; attempt < Math.min(5, slot.collection.length); attempt++) {
    if (!slot.bag.length) refillBag(slot);
    const pick = slot.bag.pop();
    slot.lastPick = pick;
    const file = slot.collection[pick];
    try {
      const img = await loadImageFile(file);
      if (state.slots[index] !== slot) return false; // layout changed meanwhile
      slot.img = img;
      return true;
    } catch (err) {
      console.warn('randomize failed for', file && file.name, err);
    }
  }
  toast(MSG.unsupported, true);
  return false;
}

async function randomizeAll() {
  const targets = state.slots.map((s, i) => (s.collection.length ? i : -1)).filter((i) => i >= 0);
  if (!targets.length) { toast(MSG.collectionEmpty, true); return; }
  const results = await Promise.all(targets.map((i) => randomizeSlot(i, { quiet: true })));
  syncUI();
  requestRender();
  if (results.some(Boolean)) toast('Randomized');
}

$('fileCollection').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  const ok = files.filter(isSupportedFile);
  if (ok.length < files.length) toast(MSG.unsupported, true);
  const slot = state.slots[collectionTarget];
  if (!slot) return;
  slot.collection = ok;
  slot.bag = [];
  slot.lastPick = -1;
  if (!ok.length) toast(MSG.collectionEmpty, true);
  syncUI();
});

/* ============================================================
   Export
   ============================================================ */
class CancelledError extends Error {}

function hasGif() { return state.slots.some((s) => s.img && s.img.isGif); }

function timestampName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `collage-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

function sanitizeName(name, ext) {
  let n = (name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\.(jpe?g|gif|png|webp)$/i, '');
  if (!n) n = timestampName(ext).replace(/\.\w+$/, '');
  return `${n.slice(0, 80)}.${ext}`;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality);
  });
}

async function exportJpeg() {
  const { W, H } = compSize();
  const e = JPEG_LONG / Math.max(W, H);
  const c = document.createElement('canvas');
  c.width = Math.round(W * e);
  c.height = Math.round(H * e);
  const ctx = c.getContext('2d');
  ctx.setTransform(c.width / W, 0, 0, c.height / H, 0, 0);
  drawComposition(ctx, W, H);
  const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
  c.width = c.height = 0;
  return blob;
}

const progress = {
  cancelled: false,
  show() {
    this.cancelled = false;
    $('progressFill').style.width = '0%';
    $('progressText').textContent = 'Preparing…';
    $('progress').hidden = false;
  },
  update(f, text) {
    $('progressFill').style.width = Math.round(f * 100) + '%';
    $('progressText').textContent = text || Math.round(f * 100) + '%';
  },
  hide() { $('progress').hidden = true; },
};
$('btnCancelExport').addEventListener('click', () => { progress.cancelled = true; });

async function exportGif() {
  const libs = await loadGifLibs(); // throws if unavailable
  const gi = state.slots.findIndex((s) => s.img && s.img.isGif);
  const img = state.slots[gi].img;
  const player = new GifFramePlayer(libs, img.gifBuffer);
  // keep the decoded frame dimensions consistent with the editor's transform
  if (player.width !== img.natW || player.height !== img.natH) throw new Error('GIF size mismatch');

  const { W, H } = compSize();
  const e = GIF_LONG / Math.max(W, H);
  const ow = Math.round(W * e), oh = Math.round(H * e);
  const out = document.createElement('canvas');
  out.width = ow;
  out.height = oh;
  const octx = out.getContext('2d', { willReadFrequently: true });
  const enc = libs.GIFEncoder();
  const n = player.count;

  for (let i = 0; i < n; i++) {
    if (progress.cancelled) throw new CancelledError();
    const frame = player.next();
    if (!frame) break;
    octx.setTransform(ow / W, 0, 0, oh / H, 0, 0);
    drawComposition(octx, W, H, { override: { index: gi, canvas: frame.canvas } });
    const data = octx.getImageData(0, 0, ow, oh).data;
    const palette = libs.quantize(data, 256);
    const indexed = libs.applyPalette(data, palette);
    enc.writeFrame(indexed, ow, oh, { palette, delay: frame.delayMs });
    progress.update((i + 1) / n, `Frame ${i + 1} of ${n}`);
    await sleep(0);
  }
  if (progress.cancelled) throw new CancelledError();
  enc.finish();
  return new Blob([enc.bytes()], { type: 'image/gif' });
}

let exporting = false;

async function doExport(mode) {
  if (exporting) return;
  if (!state.slots.some((s) => s.img) && !state.texts.length) {
    toast('Add images first.', true);
    return;
  }
  exporting = true;
  try {
    const wantGif = hasGif();
    let ext = wantGif ? 'gif' : 'jpg';
    let name = timestampName(ext);
    let handle = null;

    if (mode === 'saveas') {
      if (window.showSaveFilePicker && !IS_IOS) {
        try {
          handle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [wantGif
              ? { description: 'GIF image', accept: { 'image/gif': ['.gif'] } }
              : { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }],
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          handle = null;
        }
      }
      if (!handle) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = name.replace(/\.\w+$/, '');
        input.setAttribute('aria-label', 'File name');
        input.autocapitalize = 'off';
        const res = await showDialog({
          title: 'Save as',
          body: `<p>File name (.${ext} is added automatically)</p>`,
          bodyEl: input,
          buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', primary: true }],
          onOpen: () => { input.focus(); input.select(); },
        });
        if (res !== 'ok') return;
        name = sanitizeName(input.value, ext);
      }
    }

    let blob;
    if (wantGif) {
      progress.show();
      try {
        blob = await exportGif();
      } catch (err) {
        progress.hide();
        if (err instanceof CancelledError) { toast('Export cancelled'); return; }
        console.warn('GIF export failed', err);
        toast(MSG.gifUnavailable, true);
        await sleep(400);
        blob = await exportJpeg();
        ext = 'jpg';
        name = name.replace(/\.gif$/i, '.jpg');
        if (handle) handle = null; // the picked file expects a GIF
      }
      progress.hide();
    } else {
      blob = await exportJpeg();
    }
    await deliver(blob, name, handle);
  } catch (err) {
    console.error(err);
    progress.hide();
    toast(MSG.saveFailed, true);
  } finally {
    exporting = false;
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function deliver(blob, name, handle) {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    toast('Saved');
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  const canShareFile = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));

  if (IS_IOS && canShareFile) {
    try {
      await navigator.share({ files: [file] });
      return; // the system share sheet handles completion
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (err && err.name === 'NotAllowedError') {
        // too much time passed since the tap (e.g. long GIF export): ask for one more tap
        await readyToShareDialog(file, blob, name);
        return;
      }
      console.warn('share failed, falling back to download', err);
    }
  }
  downloadBlob(blob, name);
  toast('Saved');
}

function readyToShareDialog(file, blob, name) {
  return showDialog({
    title: 'Your collage is ready',
    body: '<p>Tap Save to open the share menu, then choose “Save Image” or “Save to Files”.</p>',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      {
        label: 'Save', value: 'share', primary: true,
        onClick: () => {
          navigator.share({ files: [file] }).catch((err) => {
            if (err && err.name === 'AbortError') return;
            downloadBlob(blob, name);
            toast('Saved');
          });
        },
      },
    ],
  });
}

/* ============================================================
   Dialogs and toasts
   ============================================================ */
let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 3600 : 2000);
}

let dialogResolve = null;
function showDialog({ title, body = '', bodyEl = null, buttons, onOpen }) {
  if (dialogResolve) dialogResolve(null);
  const modal = $('modal');
  $('modalTitle').textContent = title;
  const bodyBox = $('modalBody');
  bodyBox.innerHTML = body;
  if (bodyEl) bodyBox.appendChild(bodyEl);
  const actions = $('modalActions');
  actions.innerHTML = '';
  return new Promise((resolve) => {
    dialogResolve = resolve;
    const close = (value) => {
      modal.hidden = true;
      dialogResolve = null;
      resolve(value);
    };
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        if (b.onClick) b.onClick();
        close(b.value);
      });
      actions.appendChild(btn);
    });
    if (bodyEl && bodyEl.tagName === 'INPUT') {
      bodyEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const p = buttons.find((b) => b.primary); if (p) close(p.value); }
      });
    }
    modal.hidden = false;
    modal.onclick = (e) => { if (e.target === modal) close('cancel'); };
    if (onOpen) setTimeout(onOpen, 50);
  });
}

window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  toast('Something went wrong. Please try again.', true);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast('Something went wrong. Please try again.', true);
});

/* ============================================================
   Bottom sheet and tabs
   ============================================================ */
const sheet = $('sheet');

function setSheet(expanded) {
  sheet.classList.toggle('collapsed', !expanded);
  $('btnToggleSheet').setAttribute('aria-label', expanded ? 'Hide controls' : 'Show more controls');
}

function setTab(name) {
  ui.tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  const active = document.querySelector(`.tab[data-tab="${name}"]`);
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$('btnToggleSheet').addEventListener('click', () => setSheet(sheet.classList.contains('collapsed')));

(function sheetDrag() {
  const handle = $('sheetHandle');
  let startY = null;
  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  handle.addEventListener('pointerup', (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    if (dy < -24) setSheet(true);
    else if (dy > 24) setSheet(false);
    else setSheet(sheet.classList.contains('collapsed'));
  });
  handle.addEventListener('pointercancel', () => { startY = null; });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(sheet.classList.contains('collapsed')); }
  });
})();

/* ============================================================
   UI binding
   ============================================================ */
// Images tab
$('btnChangeImage').addEventListener('click', () => openChangePicker(selectedSlotIndex()));
$('btnFlip').addEventListener('click', () => {
  const s = state.slots[selectedSlotIndex()];
  if (!s || !s.img) return;
  s.img.tf.flip = !s.img.tf.flip;
  syncUI();
  requestRender();
});
$('btnResetSlot').addEventListener('click', () => resetSlot(selectedSlotIndex()));
$('rotSlider').addEventListener('input', (e) => {
  const s = state.slots[selectedSlotIndex()];
  if (!s || !s.img) return;
  s.img.tf.rot = wrapDeg(Number(e.target.value));
  $('rotValue').textContent = Math.round(Number(e.target.value)) + '°';
  requestRender();
});

$('btnTopReset').addEventListener('click', async () => {
  const i = selectedSlotIndex();
  const s = state.slots[i];
  if (!s || !s.img) { toast('Select a slot with an image first.'); return; }
  const label = slotLabels()[i];
  const res = await showDialog({
    title: 'Reset image?',
    body: `<p>Reset position, zoom, rotation and flip for the ${label.toLowerCase()} image?</p>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Reset', value: 'ok', primary: true }],
  });
  if (res === 'ok') resetSlot(i);
});
$('btnMore').addEventListener('click', () => {
  setSheet(true);
  setTab('help');
});

// Text tab
$('btnAddText').addEventListener('click', addText);
$('btnRemoveText').addEventListener('click', removeSelectedText);
$('btnEditText').addEventListener('click', () => { const t = selectedText(); if (t) editText(t.id); });

(function initFontSelect() {
  const sel = $('fontSize');
  FONT_SIZES.forEach((s) => sel.add(new Option(String(s), String(s))));
  sel.add(new Option('Custom…', 'custom'));
})();

$('fontSize').addEventListener('change', (e) => {
  const t = selectedText();
  if (!t) return;
  if (e.target.value === 'custom') {
    $('customSizeField').hidden = false;
    $('customSize').value = t.size;
    $('customSize').focus();
    return;
  }
  t.size = Number(e.target.value);
  syncTextControls();
  requestRender();
});
$('customSize').addEventListener('input', (e) => {
  const t = selectedText();
  const v = Math.round(Number(e.target.value));
  if (!t || !Number.isFinite(v) || v < 8) return;
  t.size = Math.min(400, v);
  requestRender();
});
$('customSize').addEventListener('change', () => syncTextControls(true));
$('textColor').addEventListener('input', (e) => { const t = selectedText(); if (t) { t.color = e.target.value; requestRender(); } });
$('bgToggle').addEventListener('change', (e) => { const t = selectedText(); if (t) { t.bg = e.target.checked; syncTextControls(); requestRender(); } });
$('bgColor').addEventListener('input', (e) => { const t = selectedText(); if (t) { t.bgColor = e.target.value; requestRender(); } });
$('bgOpacity').addEventListener('input', (e) => {
  const t = selectedText();
  if (!t) return;
  t.bgOpacity = Number(e.target.value);
  $('bgOpacityValue').textContent = t.bgOpacity;
  requestRender();
});
$('fullWidthToggle').addEventListener('change', (e) => {
  const t = selectedText();
  if (!t) return;
  t.fullWidth = e.target.checked;
  if (t.fullWidth) t.x = 0.5;
  requestRender();
});

// Layout tab
document.querySelectorAll('#orientSeg .seg-btn').forEach((b) => b.addEventListener('click', () => setOrientation(b.dataset.orient)));
document.querySelectorAll('#countSeg .seg-btn').forEach((b) => b.addEventListener('click', () => setSlotCount(Number(b.dataset.count))));

(function initRatioChips() {
  const box = $('ratioChips');
  [...RATIOS.map((r) => r[0]), 'free'].forEach((key) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.ratio = key;
    b.textContent = key === 'free' ? 'Free' : key;
    b.addEventListener('click', () => setRatio(key));
    box.appendChild(b);
  });
})();

function onFreeInput(e) {
  const el = e.target;
  const v = Number(el.value);
  const valid = Number.isInteger(v) && v > 0;
  el.setCustomValidity(valid ? '' : 'Must be a positive whole number');
  el.style.borderColor = valid ? '' : 'var(--danger)';
  if (!valid) return;
  if (el.id === 'freeW') state.freeW = v; else state.freeH = v;
  layoutStage();
}
$('freeW').addEventListener('input', onFreeInput);
$('freeH').addEventListener('input', onFreeInput);
['freeW', 'freeH'].forEach((id) => $(id).addEventListener('blur', (e) => {
  const v = Number(e.target.value);
  if (!(Number.isInteger(v) && v > 0)) {
    toast('Width and height must be positive whole numbers.', true);
    e.target.value = id === 'freeW' ? state.freeW : state.freeH;
    e.target.style.borderColor = '';
  }
}));

// Collections tab
$('btnRandomizeAll').addEventListener('click', randomizeAll);

// Export
$('btnQuickSave').addEventListener('click', () => doExport('quick'));
$('btnQuickSave2').addEventListener('click', () => doExport('quick'));
$('btnSaveAs').addEventListener('click', () => doExport('saveas'));

// Settings
$('rotateGestureToggle').addEventListener('change', (e) => {
  state.rotateGesture = e.target.checked;
  saveSetting('rotateGesture', state.rotateGesture);
});

/* ============================================================
   Sync UI from state
   ============================================================ */
function syncRotation() {
  const s = state.slots[selectedSlotIndex()];
  const rot = s && s.img ? Math.round(s.img.tf.rot) % 360 : 0;
  $('rotSlider').value = rot;
  $('rotValue').textContent = rot + '°';
}

function syncTextControls(forceSelect) {
  const t = selectedText();
  $('textControls').classList.toggle('disabled', !t);
  $('btnRemoveText').disabled = !t;
  $('btnEditText').disabled = !t;
  if (!t) return;
  const preset = FONT_SIZES.includes(t.size);
  const sel = $('fontSize');
  const customOpt = sel.querySelector('option[value="custom"]');
  customOpt.textContent = preset ? 'Custom…' : `Custom (${t.size})`;
  sel.value = preset ? String(t.size) : 'custom';
  if (preset && !forceSelect) $('customSizeField').hidden = true;
  if (!preset) {
    $('customSizeField').hidden = false;
    if (document.activeElement !== $('customSize')) $('customSize').value = t.size;
  }
  $('textColor').value = t.color;
  $('bgToggle').checked = t.bg;
  $('bgColor').value = t.bgColor;
  $('bgOpacity').value = t.bgOpacity;
  $('bgOpacityValue').textContent = t.bgOpacity;
  $('bgFields').style.opacity = t.bg ? '' : '0.4';
  $('bgFields').style.pointerEvents = t.bg ? '' : 'none';
  $('fullWidthToggle').checked = t.fullWidth;
}

function syncTextList() {
  const list = $('textList');
  list.innerHTML = '';
  if (!state.texts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No text yet';
    list.appendChild(li);
    return;
  }
  const st = selectedText();
  state.texts.forEach((t) => {
    const li = document.createElement('li');
    li.className = (st && st.id === t.id ? 'active' : '') + (t.visible ? '' : ' hidden-item');
    const span = document.createElement('span');
    span.className = 't';
    const preview = t.text.replace(/\s+/g, ' ').trim();
    span.textContent = preview.length > 28 ? preview.slice(0, 28) + '…' : (preview || '(empty)');
    const eye = document.createElement('button');
    eye.className = 'icon-btn';
    eye.setAttribute('aria-label', t.visible ? 'Hide text' : 'Show text');
    eye.innerHTML = t.visible
      ? '<svg viewBox="0 0 24 24"><path d="M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 4.3 4.3 3 21 19.7 19.7 21l-3.2-3.2A10.6 10.6 0 0 1 12 19C6 19 2 12 2 12a18 18 0 0 1 4.3-5L3 4.3zM12 5c6 0 10 7 10 7a18 18 0 0 1-2.8 3.6L8.4 4.8C9.5 4.3 10.7 5 12 5z"/></svg>';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      t.visible = !t.visible;
      syncUI();
      requestRender();
    });
    li.appendChild(span);
    li.appendChild(eye);
    li.addEventListener('click', () => selectText(t.id));
    list.appendChild(li);
  });
}

function syncCollections() {
  const box = $('collectionList');
  box.innerHTML = '';
  const labels = slotLabels();
  state.slots.forEach((slot, i) => {
    const n = slot.collection.length;
    const div = document.createElement('div');
    div.className = 'coll';
    div.innerHTML = `
      <div class="coll-head"><b>${labels[i]}</b><span class="coll-status">${n ? `${labels[i]}: ${n} item${n === 1 ? '' : 's'}` : 'No collection'}</span></div>
      <div class="row">
        <button class="btn" data-act="pick">Select images for ${labels[i]}</button>
        <button class="btn" data-act="rand"${n ? '' : ' disabled'}>Randomize ${labels[i]}</button>
      </div>`;
    div.querySelector('[data-act="pick"]').addEventListener('click', () => {
      collectionTarget = i;
      const input = $('fileCollection');
      input.value = '';
      input.click();
    });
    div.querySelector('[data-act="rand"]').addEventListener('click', async () => {
      const ok = await randomizeSlot(i);
      if (ok) { state.sel = { type: 'slot', index: i }; state.lastSlot = i; }
      syncUI();
      requestRender();
    });
    box.appendChild(div);
  });
  $('btnRandomizeAll').disabled = !state.slots.some((s) => s.collection.length);
}

function syncUI() {
  const labels = slotLabels();
  const si = selectedSlotIndex();
  const slot = state.slots[si];

  // Images tab
  const row = $('slotRow');
  row.innerHTML = '';
  labels.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (state.sel.type === 'slot' && i === si ? ' active' : '');
    b.innerHTML = label + (state.slots[i].img ? '<span class="dot"></span>' : '');
    b.addEventListener('click', () => selectSlot(i));
    row.appendChild(b);
  });
  const hasImg = !!(slot && slot.img);
  $('btnChangeImage').textContent = hasImg ? 'Change Image' : 'Add Image';
  $('btnFlip').disabled = !hasImg;
  $('btnFlip').classList.toggle('on', hasImg && slot.img.tf.flip);
  $('btnResetSlot').disabled = !hasImg;
  $('rotSlider').disabled = !hasImg;
  syncRotation();

  // Text tab
  syncTextList();
  syncTextControls();

  // Layout tab
  document.querySelectorAll('#orientSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.orient === state.orientation));
  document.querySelectorAll('#countSeg .seg-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.count) === state.slots.length));
  document.querySelectorAll('#ratioChips .chip').forEach((b) => b.classList.toggle('active', b.dataset.ratio === state.ratio));
  $('freeFields').hidden = state.ratio !== 'free';

  // Collections
  syncCollections();

  // Export
  const gif = hasGif();
  $('exportHint').textContent = gif ? 'Export as GIF' : 'Export as JPEG';
  $('exportDetail').textContent = gif
    ? `Animated GIF, ${GIF_LONG} px on the long side. The first GIF sets the animation; other images are still.`
    : `JPEG, ${JPEG_LONG} px on the long side.`;
}

/* ============================================================
   Install (PWA) and service worker
   ============================================================ */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $('installBox').hidden = false;
});
$('btnInstall').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch { /* ignore */ }
  deferredInstall = null;
  $('installBox').hidden = true;
});
window.addEventListener('appinstalled', () => { $('installBox').hidden = true; toast('Installed'); });
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (IS_IOS && !standalone) $('iosInstallHint').hidden = false;

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}

/* ============================================================
   Start
   ============================================================ */
$('appVersion').textContent = APP_VERSION;
$('rotateGestureToggle').checked = state.rotateGesture;
syncUI();
layoutStage();
// Warm up the GIF libraries so they are cached for offline use.
loadGifLibs().catch(() => {});

// exposed for automated testing
window.__collage = { state, drawComposition, compSize, exportJpeg, exportGif, loadImageFile, syncUI, layoutStage };
