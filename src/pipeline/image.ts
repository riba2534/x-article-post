// Image normalization: decode, enforce X's limits (5 MB, 4096 px), rasterize SVG to PNG.
// Needs a DOM (Image + canvas), so it runs in the side panel or the offscreen document.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif';

export interface NormalizedImage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

const PASS_THROUGH = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Detects the image type from magic bytes; SVG is recognised by its root element. */
export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Scales (width, height) down so the longest side is at most `max`. Never upscales. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const k = max / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function extensionFor(mime: string): string {
  return { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] ?? 'png';
}

function sizeOf(root: Element): { width: number; height: number } {
  const num = (v: string | null) => (v && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? parseFloat(v) : NaN);
  let width = num(root.getAttribute('width'));
  let height = num(root.getAttribute('height'));
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (!(width > 0) && !(height > 0)) [width, height] = [vb[2], vb[3]];
    else if (!(width > 0)) width = (height * vb[2]) / vb[3];
    else if (!(height > 0)) height = (width * vb[3]) / vb[2];
  }
  if (!(width > 0) || !(height > 0)) return { width: 800, height: 600 };
  return { width, height };
}

/** Reads width/height (or the viewBox) from an SVG root. */
export function svgIntrinsicSize(svg: string): { width: number; height: number } {
  return sizeOf(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法解码'));
    img.src = src;
  });
}

type Drawable = CanvasImageSource & { width: number; height: number };

function drawCanvas(source: Drawable, width: number, height: number, background?: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function asImage(blob: Blob, size: { width: number; height: number }): Promise<NormalizedImage> {
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, ...size };
}

/**
 * Re-encodes within the limits: PNG first when transparency matters, then JPEG on white with
 * decreasing quality, shrinking the canvas if nothing fits.
 */
async function encodeWithinLimits(source: Drawable, width: number, height: number, preferPng: boolean, background?: string): Promise<NormalizedImage> {
  let size = fitWithin(width, height, MAX_IMAGE_SIDE);
  for (let attempt = 0; attempt < 6; attempt++) {
    if (preferPng) {
      const png = await drawCanvas(source, size.width, size.height, background).convertToBlob({ type: 'image/png' });
      if (png.size <= MAX_IMAGE_BYTES) return asImage(png, size);
    }
    const flat = drawCanvas(source, size.width, size.height, background ?? '#fff');
    let smallest = Infinity;
    for (const quality of [0.92, 0.85, 0.75]) {
      const jpeg = await flat.convertToBlob({ type: 'image/jpeg', quality });
      if (jpeg.size <= MAX_IMAGE_BYTES) return asImage(jpeg, size);
      smallest = Math.min(smallest, jpeg.size);
    }
    const k = Math.min(0.9, Math.sqrt(MAX_IMAGE_BYTES / smallest));
    size = { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
  }
  throw new Error('图片压缩后仍超过 5 MB');
}

export interface SvgRasterOptions {
  scale?: number;
  background?: string;
}

export async function svgToPng(svg: string, opts: SvgRasterOptions = {}): Promise<NormalizedImage> {
  const scale = opts.scale ?? 1;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const base = sizeOf(root);
  const target = fitWithin(Math.round(base.width * scale), Math.round(base.height * scale), MAX_IMAGE_SIDE);
  // Pin the pixel size so the browser rasterizes at exactly the target resolution.
  if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  root.setAttribute('width', String(target.width));
  root.setAttribute('height', String(target.height));
  root.removeAttribute('style');
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // A data: URL (not a blob: URL) keeps Chrome from tainting the canvas when the SVG has foreignObject.
  const img = await loadImage(`data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(new XMLSerializer().serializeToString(doc)))}`);
  return encodeWithinLimits(img, target.width, target.height, true, opts.background);
}

export async function normalizeImage(bytes: Uint8Array, contentType = ''): Promise<NormalizedImage> {
  const mime = sniffMime(bytes) ?? (contentType.includes('svg') ? 'image/svg+xml' : null);
  if (!mime) throw new Error('无法识别的图片格式');
  if (mime === 'image/svg+xml') return svgToPng(new TextDecoder().decode(bytes), { scale: 2 });
  const img = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const { width, height } = img;
    if (PASS_THROUGH.has(mime) && bytes.byteLength <= MAX_IMAGE_BYTES && Math.max(width, height) <= MAX_IMAGE_SIDE) {
      return { bytes, mime, width, height };
    }
    return await encodeWithinLimits(img, width, height, mime !== 'image/jpeg');
  } finally {
    img.close();
  }
}
