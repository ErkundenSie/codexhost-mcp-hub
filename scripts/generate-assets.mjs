/**
 * Pure-Node PNG generator for `assets/icon.png` (256x256) and `assets/preview.png` (960x540).
 * Generates clean, valid PNG images with proper PNG magic bytes and CRC32 checksums.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idat),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createCanvas(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  const setPx = (x, y, r, g, b, a = 255) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
    const i = (iy * w + ix) * 4;
    if (a >= 255 || buf[i + 3] === 0) {
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    } else {
      const alpha = a / 255;
      buf[i] = Math.round(r * alpha + buf[i] * (1 - alpha));
      buf[i + 1] = Math.round(g * alpha + buf[i + 1] * (1 - alpha));
      buf[i + 2] = Math.round(b * alpha + buf[i + 2] * (1 - alpha));
      buf[i + 3] = 255;
    }
  };
  const fillRoundRect = (x, y, rw, rh, rad, color) => {
    const [r, g, b, a = 255] = color;
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(h, Math.ceil(y + rh)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(w, Math.ceil(x + rw)); px++) {
        const dx = Math.max(x + rad - px, 0, px - (x + rw - rad));
        const dy = Math.max(y + rad - py, 0, py - (y + rh - rad));
        if (dx * dx + dy * dy <= rad * rad) setPx(px, py, r, g, b, a);
      }
    }
  };
  const fillCircle = (cx, cy, rad, color) => {
    const [r, g, b, a = 255] = color;
    for (let py = Math.max(0, Math.floor(cy - rad)); py <= Math.min(h - 1, Math.ceil(cy + rad)); py++) {
      for (let px = Math.max(0, Math.floor(cx - rad)); px <= Math.min(w - 1, Math.ceil(cx + rad)); px++) {
        const d2 = (px - cx) ** 2 + (py - cy) ** 2;
        if (d2 <= rad * rad) setPx(px, py, r, g, b, a);
      }
    }
  };
  const drawLine = (x1, y1, x2, y2, thickness, color) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1) * 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      fillCircle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, thickness / 2, color);
    }
  };
  return { buf, setPx, fillRoundRect, fillCircle, drawLine };
}

function generateIcon() {
  const w = 256;
  const h = 256;
  const c = createCanvas(w, h);
  // Deep indigo-blue rounded background with subtle vertical gradient
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rad = 52;
      const dx = Math.max(rad - x, 0, x - (w - 1 - rad));
      const dy = Math.max(rad - y, 0, y - (h - 1 - rad));
      if (dx * dx + dy * dy <= rad * rad) {
        const t = y / h;
        c.setPx(
          x,
          y,
          Math.round(18 + 16 * t),
          Math.round(38 + 48 * t),
          Math.round(92 + 78 * t),
          255,
        );
      }
    }
  }
  // Hub & spoke network representing unified MCP distribution
  const cx = 128;
  const cy = 128;
  const nodes = [
    [64, 74, [96, 165, 250]],
    [192, 74, [52, 211, 153]],
    [60, 178, [251, 191, 36]],
    [196, 178, [167, 139, 250]],
  ];
  for (const [nx, ny] of nodes) {
    c.drawLine(cx, cy, nx, ny, 9, [226, 232, 240, 210]);
  }
  for (const [nx, ny, col] of nodes) {
    c.fillCircle(nx, ny, 24, [255, 255, 255]);
    c.fillCircle(nx, ny, 16, col);
  }
  c.fillCircle(cx, cy, 42, [255, 255, 255]);
  c.fillCircle(cx, cy, 32, [37, 99, 235]);
  c.fillCircle(cx, cy, 13, [255, 255, 255]);
  return encodePng(w, h, c.buf);
}

function generatePreview() {
  const w = 960;
  const h = 540;
  const c = createCanvas(w, h);
  // Slate dark UI canvas
  c.fillRoundRect(0, 0, w, h, 0, [15, 23, 42]);
  // Window frame
  c.fillRoundRect(24, 24, w - 48, h - 48, 16, [22, 31, 51]);
  // Top header bar
  c.fillRoundRect(48, 48, 220, 24, 6, [241, 245, 249]);
  c.fillRoundRect(48, 82, 420, 12, 4, [100, 116, 139]);
  c.fillRoundRect(680, 50, 108, 32, 8, [51, 65, 85]);
  c.fillRoundRect(800, 50, 112, 32, 8, [37, 99, 235]);

  // 3 stat cards
  const statColors = [
    [37, 99, 235],
    [16, 185, 129],
    [245, 158, 11],
  ];
  for (let i = 0; i < 3; i++) {
    const sx = 48 + i * 294;
    c.fillRoundRect(sx, 118, 276, 74, 10, [30, 41, 59]);
    c.fillRoundRect(sx + 16, 134, 100, 10, 4, [148, 163, 184]);
    c.fillRoundRect(sx + 16, 156, 72, 20, 6, statColors[i]);
  }

  // Tab bar
  c.fillRoundRect(48, 212, 864, 2, 1, [51, 65, 85]);
  c.fillRoundRect(48, 210, 110, 4, 2, [59, 130, 246]);

  // 2 MCP server cards with AI pills
  for (let i = 0; i < 2; i++) {
    const cy = 234 + i * 124;
    c.fillRoundRect(48, cy, 864, 108, 10, [30, 41, 59]);
    c.fillCircle(72, cy + 28, 8, [59, 130, 246]);
    c.fillRoundRect(92, cy + 20, 160, 16, 5, [241, 245, 249]);
    c.fillRoundRect(264, cy + 20, 54, 16, 8, [37, 99, 235]);
    c.fillRoundRect(68, cy + 48, 520, 18, 5, [15, 23, 42]);
    // AI target pills
    const pillPalette = [
      [37, 99, 235],
      [37, 99, 235],
      [37, 99, 235],
      [37, 99, 235],
      [51, 65, 85],
      [37, 99, 235],
    ];
    for (let p = 0; p < pillPalette.length; p++) {
      c.fillRoundRect(68 + p * 98, cy + 76, 88, 20, 10, pillPalette[p]);
    }
  }

  // Floating widget pill in bottom-right
  c.fillRoundRect(748, 464, 156, 34, 17, [30, 41, 59]);
  c.fillCircle(768, 481, 6, [52, 211, 153]);
  c.fillRoundRect(784, 475, 102, 12, 4, [226, 232, 240]);

  return encodePng(w, h, c.buf);
}

const assetsDir = path.join(rootDir, "assets");
await mkdir(assetsDir, { recursive: true });
const iconPng = generateIcon();
const previewPng = generatePreview();
await writeFile(path.join(assetsDir, "icon.png"), iconPng);
await writeFile(path.join(assetsDir, "preview.png"), previewPng);
console.log(`Generated icon.png (${iconPng.length} B) and preview.png (${previewPng.length} B)`);
