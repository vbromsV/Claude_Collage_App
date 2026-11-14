// GIF helpers: decoding (omggif) and encoding (gifenc).
// Libraries are loaded on demand and cached by the service worker for offline use.

let libsPromise = null;

export function loadGifLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([
      import('../lib/gifenc.esm.js'),
      import('../lib/omggif.js'),
    ]).then(([enc, dec]) => ({
      GIFEncoder: enc.GIFEncoder,
      quantize: enc.quantize,
      applyPalette: enc.applyPalette,
      GifReader: dec.GifReader,
    })).catch((err) => {
      libsPromise = null;
      throw err;
    });
  }
  return libsPromise;
}

/**
 * Plays through the frames of a GIF in order, compositing each frame
 * (honouring disposal methods) into a full-size canvas.
 */
export class GifFramePlayer {
  constructor(libs, buffer) {
    this.reader = new libs.GifReader(new Uint8Array(buffer));
    this.width = this.reader.width;
    this.height = this.reader.height;
    this.count = this.reader.numFrames();
    if (!this.count || !this.width || !this.height) throw new Error('Empty GIF');
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
    this.imageData = this.ctx.createImageData(this.width, this.height);
    this.index = 0;
    this.pending = null; // disposal to apply before next frame
  }

  /** Returns { canvas, delayMs } for the next frame, or null when done. */
  next() {
    if (this.index >= this.count) return null;
    this.applyPendingDisposal();
    const info = this.reader.frameInfo(this.index);
    let snapshot = null;
    if (info.disposal === 3) snapshot = this.pixels.slice();
    this.reader.decodeAndBlitFrameRGBA(this.index, this.pixels);
    this.imageData.data.set(this.pixels);
    this.ctx.putImageData(this.imageData, 0, 0);
    this.pending = { info, snapshot };
    this.index++;
    const cs = info.delay < 2 ? 10 : info.delay; // browsers treat 0/1 as 100 ms
    return { canvas: this.canvas, delayMs: cs * 10 };
  }

  applyPendingDisposal() {
    const p = this.pending;
    if (!p) return;
    const { info, snapshot } = p;
    if (info.disposal === 2) {
      const w = this.width;
      for (let y = info.y; y < Math.min(info.y + info.height, this.height); y++) {
        const start = (y * w + info.x) * 4;
        const end = (y * w + Math.min(info.x + info.width, w)) * 4;
        this.pixels.fill(0, start, end);
      }
    } else if (info.disposal === 3 && snapshot) {
      this.pixels.set(snapshot);
    }
    this.pending = null;
  }
}

/** Decodes the first frame of a GIF into a standalone canvas. */
export async function decodeGifFirstFrame(buffer) {
  const libs = await loadGifLibs();
  const player = new GifFramePlayer(libs, buffer);
  const frame = player.next();
  const c = document.createElement('canvas');
  c.width = player.width;
  c.height = player.height;
  c.getContext('2d').drawImage(frame.canvas, 0, 0);
  return { canvas: c, width: player.width, height: player.height, frames: player.count };
}
