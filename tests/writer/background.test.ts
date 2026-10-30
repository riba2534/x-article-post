import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WriteBlock, WriteRequest } from '../../src/shared/types';

const dropImages = vi.fn(async (_runId: string) => {});
vi.mock('../../src/shared/image-store', () => ({ dropImages, loadImage: vi.fn() }));

// The first run stays inside prepareTab until the test lets it fail.
let failPrepare: (e: Error) => void = () => {};
vi.mock('../../src/background/writer/tabs', () => ({
  prepareTab: () => new Promise((_resolve, reject) => (failPrepare = reject)),
  findStatusTab: vi.fn(),
  sendToTab: vi.fn(),
}));

const block: WriteBlock = { kind: 'text', type: 'unstyled', text: 'a', styles: [], links: [] };
const request = (runId: string, blocks = 1): WriteRequest => ({
  runId,
  title: 't',
  blocks: Array(blocks).fill(block),
  images: {},
  target: { type: 'new' },
});

beforeEach(() => {
  dropImages.mockClear();
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => undefined), lastError: undefined } });
});
afterEach(() => vi.unstubAllGlobals());

describe('background runWrite image cleanup', () => {
  it('drops stashed images of a request refused for the block limit', async () => {
    const { runWrite } = await import('../../src/background/writer');
    const r = await runWrite(request('big', 1001), () => {});
    expect(r).toMatchObject({ ok: false, runId: 'big', error: '内容超过 X 的 1000 块上限' });
    expect(dropImages).toHaveBeenCalledWith('big');
  });

  it('busy: drops the refused run images but never those of the active run', async () => {
    const { runWrite, isBusy } = await import('../../src/background/writer');
    const first = runWrite(request('active'), () => {});
    expect(isBusy()).toBe(true);

    const other = await runWrite(request('second'), () => {});
    expect(other).toMatchObject({ ok: false, runId: 'second', error: 'busy' });
    // A duplicate submit of the running request must not delete its images.
    const dup = await runWrite(request('active'), () => {});
    expect(dup.error).toBe('busy');
    expect(dropImages.mock.calls).toEqual([['second']]);

    failPrepare(new Error('tab gone'));
    expect((await first).error).toBe('tab gone');
    expect(dropImages.mock.calls).toEqual([['second'], ['active']]);
    expect(isBusy()).toBe(false);
  });
});
