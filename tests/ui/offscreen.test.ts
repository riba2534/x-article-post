import { describe, expect, it, vi } from 'vitest';

const prepareWrite = vi.hoisted(() => vi.fn(async () => ({ request: { runId: 'r' }, doc: { title: 't' } })));
vi.mock('../../src/pipeline/prepare', () => ({ prepareWrite }));

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
const listeners: Listener[] = [];
vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (fn: Listener) => listeners.push(fn) } } });
await import('../../src/offscreen/main');

function send(msg: unknown) {
  const sendResponse = vi.fn();
  const keepOpen = listeners[0](msg, {}, sendResponse);
  return { keepOpen, sendResponse };
}

describe('offscreen message handler', () => {
  it('runs prepareWrite for xap:prepare and answers asynchronously', async () => {
    const target = { type: 'new' };
    const { keepOpen, sendResponse } = send({ type: 'xap:prepare', requestId: '1', markdown: '# a', options: {}, target, title: 'T' });
    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(prepareWrite).toHaveBeenCalledWith('# a', {}, target, undefined, 'T');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, request: { runId: 'r' }, doc: { title: 't' } });
  });

  it('reports pipeline errors', async () => {
    prepareWrite.mockRejectedValueOnce(new Error('boom'));
    const { sendResponse } = send({ type: 'xap:prepare', requestId: '2', markdown: '', options: {}, target: { type: 'new' } });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'boom' }));
  });

  it('ignores every other message, including the removed xap:convert', () => {
    for (const type of ['xap:convert', 'xap:write', 'xap:status']) {
      const { keepOpen, sendResponse } = send({ type, requestId: '3', markdown: '', options: {} });
      expect(keepOpen).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    }
  });
});
