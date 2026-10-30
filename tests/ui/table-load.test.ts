// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { imageLoaded } from '../../src/pipeline/table';

describe('imageLoaded', () => {
  it('settles on load even when decode() would never resolve (offscreen documents)', async () => {
    const img = document.createElement('img');
    img.decode = () => new Promise(() => {});
    const p = imageLoaded(img, 5_000);
    img.dispatchEvent(new Event('load'));
    await expect(p).resolves.toBeUndefined();
  });

  it('gives up after the timeout', async () => {
    const img = document.createElement('img');
    const t0 = Date.now();
    await imageLoaded(img, 50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });
});
