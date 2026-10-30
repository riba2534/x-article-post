// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { bytesToBase64, extensionFor, fitWithin, sniffMime, svgIntrinsicSize } from '../../src/pipeline/image';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe('sniffMime', () => {
  it('detects raster formats by magic bytes', () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(text('GIF89a....'))).toBe('image/gif');
    expect(sniffMime(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(text('\0\0\0\x1cftypavif'))).toBe('image/avif');
  });

  it('detects SVG with prolog, comments and doctype', () => {
    expect(sniffMime(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffMime(text('\n<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "x">\n<svg>'))).toBe('image/svg+xml');
  });

  it('rejects other content', () => {
    expect(sniffMime(text('<html><body>login</body></html>'))).toBeNull();
    expect(sniffMime(text('<svgfoo>'))).toBeNull();
    expect(sniffMime(bytes())).toBeNull();
  });
});

describe('fitWithin', () => {
  it('scales the longest side down and never up', () => {
    expect(fitWithin(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(fitWithin(1000, 9000, 4096)).toEqual({ width: 455, height: 4096 });
    expect(fitWithin(4096, 10, 4096)).toEqual({ width: 4096, height: 10 });
    expect(fitWithin(100000, 1, 4096)).toEqual({ width: 4096, height: 1 });
  });
});

describe('bytesToBase64', () => {
  it('matches Buffer for large inputs', () => {
    const data = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(bytesToBase64(data)).toBe(Buffer.from(data).toString('base64'));
  });
});

describe('extensionFor', () => {
  it('maps mime to file extension', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/gif')).toBe('gif');
    expect(extensionFor('image/png')).toBe('png');
  });
});

describe('svgIntrinsicSize', () => {
  it('uses width/height, then viewBox', () => {
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40px"/>')).toEqual({ width: 120, height: 40 });
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 300 150"/>')).toEqual({ width: 300, height: 150 });
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" width="600" viewBox="0 0 300 150"/>')).toEqual({ width: 600, height: 300 });
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg"/>')).toEqual({ width: 800, height: 600 });
  });
});
