import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { dropImages, loadImage, stashImages } from '../src/shared/image-store';
import type { PreparedImage } from '../src/shared/types';

const img = (id: string, base64: string): PreparedImage => ({ id, base64, mime: 'image/png', fileName: `${id}.png` });

describe('image store', () => {
  it('moves data out of the request and restores it per run', async () => {
    const stashed = await stashImages('run-a', { 'img-1': img('img-1', 'AAAA'), cover: img('cover', 'BBBB') });
    expect(stashed['img-1'].base64).toBe('');
    expect(stashed.cover.base64).toBe('');
    expect((await loadImage('run-a', stashed['img-1']))?.base64).toBe('AAAA');
    expect((await loadImage('run-a', stashed.cover))?.base64).toBe('BBBB');
    expect(await loadImage('run-b', stashed.cover)).toBeUndefined();
  });

  it('drops only the given run', async () => {
    const a = await stashImages('run-c', { x: img('x', 'CCCC') });
    const b = await stashImages('run-d', { x: img('x', 'DDDD') });
    await dropImages('run-c');
    expect(await loadImage('run-c', a.x)).toBeUndefined();
    expect((await loadImage('run-d', b.x))?.base64).toBe('DDDD');
  });

  it('passes inline images through', async () => {
    expect((await loadImage('any', img('y', 'EEEE')))?.base64).toBe('EEEE');
  });
});
