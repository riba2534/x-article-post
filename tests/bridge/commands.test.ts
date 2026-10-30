import { describe, expect, it, vi } from 'vitest';
import { createCommandHandler, type CommandDeps } from '../../src/background/bridge/commands';
import type { ArticleDoc, BridgeMessage, WriteRequest, WriteResult } from '../../src/shared/types';

const doc: ArticleDoc = {
  title: 'T',
  blocks: [],
  warnings: [],
  stats: { blocks: 0, images: 0, mermaid: 0, codeBlocks: 0, tables: 0, latex: 0, tweets: 0, characters: 0 },
};
const request: WriteRequest = { runId: 'run1', title: 'T', blocks: [], images: {}, target: { type: 'new' } };
const okResult: WriteResult = { ok: true, runId: 'run1', articleId: '7', url: 'https://x.com/compose/articles/edit/7', blocksWritten: 0, imagesOk: 0, imagesFailed: [], titleSet: true, coverSet: false, warnings: [] };

function setup(overrides: Partial<CommandDeps> = {}) {
  const deps: CommandDeps = {
    version: '1.0.0',
    bridgeStatus: () => ({ enabled: true, connected: true, url: 'ws://127.0.0.1:17345/ext' }),
    isBusy: () => false,
    getXTabStatus: async () => ({ tabId: 3, url: 'https://x.com/compose/articles/edit/7', articleId: '7', editorReady: true }),
    ensureOffscreen: vi.fn(async () => {}),
    prepare: vi.fn(async () => ({ ok: true as const, request, doc })),
    runWrite: vi.fn(async (_req, onProgress) => {
      onProgress({ runId: 'run1', phase: 'text', message: 'writing' });
      return okResult;
    }),
    ...overrides,
  };
  const sent: BridgeMessage[] = [];
  const handle = createCommandHandler(deps);
  return { deps, sent, run: (method: string, params: Record<string, unknown> = {}) => handle({ id: 'c1', method: method as never, params }, (m) => sent.push(m)) };
}

const lastResponse = (sent: BridgeMessage[]) => sent.filter((m) => m.type === 'response').at(-1);

describe('bridge command handler', () => {
  it('answers status with an ExtensionStatus', async () => {
    const { run, sent } = setup();
    await run('status');
    expect(lastResponse(sent)).toEqual({
      type: 'response',
      id: 'c1',
      ok: true,
      result: { version: '1.0.0', bridge: { enabled: true, connected: true, url: 'ws://127.0.0.1:17345/ext' }, xTab: expect.objectContaining({ articleId: '7' }), busy: false },
    });
  });

  it('runs a draft through offscreen prepare and the writer, forwarding progress', async () => {
    const { run, sent, deps } = setup();
    await run('draft', { markdown: '# a', title: 'Custom', articleId: '7', mode: 'replace', options: { inlineCode: 'plain' } });
    expect(deps.ensureOffscreen).toHaveBeenCalled();
    expect(deps.prepare).toHaveBeenCalledWith({
      type: 'xap:prepare',
      requestId: 'c1',
      markdown: '# a',
      options: { inlineCode: 'plain' },
      target: { type: 'existing', articleId: '7', mode: 'replace' },
      title: 'Custom',
    });
    expect(deps.runWrite).toHaveBeenCalledWith(request, expect.any(Function));
    expect(sent[0]).toEqual({ type: 'progress', id: 'c1', progress: { runId: 'run1', phase: 'text', message: 'writing' } });
    expect(lastResponse(sent)).toEqual({ type: 'response', id: 'c1', ok: true, result: okResult });
  });

  it('targets a new draft and defaults existing drafts to append', async () => {
    const { run, deps } = setup();
    await run('draft', { markdown: 'x' });
    expect(vi.mocked(deps.prepare).mock.calls[0][0].target).toEqual({ type: 'new' });
    await run('draft', { markdown: 'x', articleId: '9' });
    expect(vi.mocked(deps.prepare).mock.calls[1][0].target).toEqual({ type: 'existing', articleId: '9', mode: 'append' });
  });

  it('refuses a draft while busy without touching offscreen', async () => {
    const { run, sent, deps } = setup({ isBusy: () => true });
    await run('draft', { markdown: 'x' });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
    expect(lastResponse(sent)).toMatchObject({ ok: false, error: { code: 'busy' } });
  });

  it('maps a busy WriteResult to the busy error code', async () => {
    const { run, sent } = setup({ runWrite: async () => ({ ...okResult, ok: false, error: 'busy' }) });
    await run('draft', { markdown: 'x' });
    expect(lastResponse(sent)).toMatchObject({ ok: false, error: { code: 'busy' } });
  });

  it('returns a failed WriteResult as a normal result', async () => {
    const failed = { ...okResult, ok: false, error: 'editor not found' };
    const { run, sent } = setup({ runWrite: async () => failed });
    await run('draft', { markdown: 'x' });
    expect(lastResponse(sent)).toMatchObject({ ok: true, result: failed });
  });

  it('reports prepare failures', async () => {
    const { run, sent } = setup({ prepare: async () => ({ ok: false, error: 'image too large' }) });
    await run('draft', { markdown: 'x' });
    expect(lastResponse(sent)).toMatchObject({ ok: false, error: { code: 'prepare-failed', message: 'image too large' } });
    const missing = setup({ prepare: async () => undefined });
    await missing.run('draft', { markdown: 'x' });
    expect(lastResponse(missing.sent)).toMatchObject({ ok: false, error: { code: 'prepare-failed' } });
  });

  it('validates draft params', async () => {
    for (const params of [{}, { markdown: ' ' }, { markdown: 'x', articleId: 'abc' }, { markdown: 'x', mode: 'publish' }, { markdown: 'x', mode: 'append' }, { markdown: 'x', options: [] }]) {
      const { run, sent } = setup();
      await run('draft', params);
      expect(lastResponse(sent)).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    }
  });

  it('turns unexpected errors into internal errors', async () => {
    const { run, sent } = setup({ ensureOffscreen: async () => { throw new Error('boom'); } });
    await run('draft', { markdown: 'x' });
    expect(lastResponse(sent)).toMatchObject({ ok: false, error: { code: 'internal', message: 'boom' } });
  });

  it('answers snapshot from the X tab state', async () => {
    const { run, sent } = setup();
    await run('snapshot');
    expect(lastResponse(sent)).toMatchObject({ ok: true, result: { articleId: '7', url: 'https://x.com/compose/articles/edit/7', editorReady: true } });
    const none = setup({ getXTabStatus: async () => null });
    await none.run('snapshot');
    expect(lastResponse(none.sent)).toMatchObject({ ok: true, result: { editorReady: false } });
  });

  it('rejects unknown methods, including convert (the bridge converts in Node)', async () => {
    for (const method of ['publish', 'convert']) {
      const { run, sent } = setup();
      await run(method, { markdown: 'x' });
      expect(lastResponse(sent)).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    }
  });
});
