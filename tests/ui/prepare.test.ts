import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleDoc, ImageSource, WriteProgress } from '../../src/shared/types';
import { sampleDoc } from './fixtures';

const convert = vi.hoisted(() => ({ doc: null as ArticleDoc | null }));
vi.mock('../../src/core/index', () => ({ convertMarkdown: vi.fn(() => convert.doc) }));
vi.mock('../../src/pipeline/mermaid', () => ({
  mermaidToPng: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 20, height: 10 })),
}));
vi.mock('../../src/pipeline/table', () => ({ tableToPng: vi.fn(async () => Promise.reject(new Error('foreignObject tainted'))) }));

const { assembleRequest, collectImages, collectPermissionOrigins, prepareWrite, sourceUrls } = await import('../../src/pipeline/prepare');
const { convertMarkdown } = await import('../../src/core/index');

const png = (n = 1) => ({ bytes: new Uint8Array(n).fill(7), mime: 'image/png', width: 10, height: 5 });

describe('collectImages', () => {
  it('lists image blocks by index and the cover last', () => {
    const refs = collectImages(sampleDoc());
    expect(refs.map((r) => r.key)).toEqual([14, 15, 16, 'cover']);
    expect(refs[3].source).toEqual({ type: 'url', url: 'https://img.example.com/cover.png' });
  });

  it('skips the cover when absent', () => {
    const doc = { ...sampleDoc(), cover: undefined };
    expect(collectImages(doc).some((r) => r.key === 'cover')).toBe(false);
  });
});

describe('collectPermissionOrigins', () => {
  it('dedupes hosts across blocks, table cells and cover', () => {
    expect(collectPermissionOrigins(sampleDoc())).toEqual(['https://img.example.com/*', 'https://cdn.example.org/*']);
  });

  it('ignores data: URIs, invalid URLs and mermaid', () => {
    const doc: ArticleDoc = {
      ...sampleDoc(),
      cover: 'data:image/png;base64,AAAA',
      blocks: [
        { kind: 'image', source: { type: 'url', url: 'not a url' }, alt: '', fallbackText: '' },
        { kind: 'image', source: { type: 'url', url: 'http://localhost:8080/a.png' }, alt: '', fallbackText: '' },
        { kind: 'image', source: { type: 'mermaid', code: 'graph TD; A-->B' }, alt: '', fallbackText: '' },
      ],
    };
    expect(collectPermissionOrigins(doc)).toEqual(['http://localhost/*']);
  });

  it('finds inline and reference images in tables, ignoring raw HTML like the renderer does', () => {
    const markdown = '| a |\n|---|\n| <img src="https://h.example/x.png"> ![b](<https://i.example/y.png>) ![c][r] |\n\n[r]: https://r.example/z.png';
    expect(sourceUrls({ type: 'table', markdown })).toEqual(['https://i.example/y.png', 'https://r.example/z.png']);
  });
});

describe('assembleRequest', () => {
  it('replaces images with ids, sets cover and keeps other blocks', async () => {
    const doc = sampleDoc();
    const { request, doc: out } = await assembleRequest(doc, { type: 'new' }, async () => png(3), { runId: 'r1' });
    expect(request.runId).toBe('r1');
    expect(request.title).toBe(doc.title);
    expect(request.target).toEqual({ type: 'new' });
    expect(request.blocks[14]).toEqual({ kind: 'image', imageId: 'img-1', alt: '示意图', fallbackText: '[图片：示意图]' });
    expect(request.blocks[16]).toMatchObject({ kind: 'image', imageId: 'img-3' });
    expect(request.blocks[0]).toBe(doc.blocks[0]);
    expect(request.coverImageId).toBe('cover');
    expect(Object.keys(request.images)).toEqual(['img-1', 'img-2', 'img-3', 'cover']);
    expect(request.images['img-1']).toEqual({ id: 'img-1', base64: 'BwcH', mime: 'image/png', fileName: 'img-1.png', width: 10, height: 5 });
    expect(out.warnings).toEqual(doc.warnings);
  });

  it('turns failures into fallback text / markdown tables with warnings', async () => {
    const doc = sampleDoc();
    const fail = async (s: ImageSource) => {
      if (s.type === 'mermaid') return png();
      throw new Error(`boom ${s.type}`);
    };
    const { request, doc: out } = await assembleRequest(doc, { type: 'existing', articleId: '42', mode: 'append' }, fail, { title: '自定义' });
    expect(request.title).toBe('自定义');
    expect(request.blocks[14]).toEqual({ kind: 'text', type: 'unstyled', text: '[图片：示意图]', styles: [], links: [] });
    expect(request.blocks[15]).toMatchObject({ kind: 'image', imageId: 'img-1' });
    expect(request.blocks[16]).toEqual({ kind: 'markdown', role: 'table', markdown: (doc.blocks[16] as { source: { markdown: string } }).source.markdown });
    expect(request.coverImageId).toBeUndefined();
    expect('coverImageId' in request).toBe(false);
    expect(Object.keys(request.images)).toEqual(['img-1']);
    const added = out.warnings.slice(doc.warnings.length);
    expect(added).toHaveLength(3);
    expect(added.every((w) => w.code === 'image-unsupported')).toBe(true);
    expect(added[0].message).toContain('boom url');
    expect(added[2].message).toContain('封面');
    expect(doc.warnings).toHaveLength(3);
  });

  it('falls back to alt, then a placeholder, when fallbackText is empty', async () => {
    const doc: ArticleDoc = {
      ...sampleDoc(),
      cover: undefined,
      blocks: [
        { kind: 'image', source: { type: 'url', url: 'https://a.example/1.png' }, alt: '替代', fallbackText: '' },
        { kind: 'image', source: { type: 'url', url: 'https://a.example/2.png' }, alt: '', fallbackText: '' },
      ],
    };
    const { request } = await assembleRequest(doc, { type: 'new' }, () => Promise.reject(new Error('x')));
    expect(request.blocks.map((b) => (b.kind === 'text' ? b.text : ''))).toEqual(['替代', '[图片]']);
    expect(request.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports progress per image and limits concurrency', async () => {
    const progress: WriteProgress[] = [];
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return png();
    };
    const doc: ArticleDoc = {
      ...sampleDoc(),
      cover: undefined,
      blocks: Array.from({ length: 9 }, (_, i) => ({ kind: 'image' as const, source: { type: 'url' as const, url: `https://a.example/${i}.png` }, alt: '', fallbackText: '' })),
    };
    await assembleRequest(doc, { type: 'new' }, slow, { runId: 'p', onProgress: (p) => progress.push(p), concurrency: 3 });
    expect(peak).toBe(3);
    expect(progress.every((p) => p.phase === 'prepare' && p.runId === 'p' && p.total === 9)).toBe(true);
    expect(progress.map((p) => p.current)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
  });
});

describe('prepareWrite', () => {
  beforeEach(() => {
    convert.doc = sampleDoc();
    vi.unstubAllGlobals();
  });

  it('converts, fetches without credentials and falls back on failures', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { request, doc } = await prepareWrite('# md', { embedTweets: false }, { type: 'new' }, undefined, '  ');
    expect(convertMarkdown).toHaveBeenCalledWith('# md', { embedTweets: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) expect(call[1]).toMatchObject({ credentials: 'omit' });
    expect(request.title).toBe('用 Markdown 写 X 长文');
    expect(request.blocks[14]).toMatchObject({ kind: 'text', text: '[图片：示意图]' });
    expect(request.blocks[15]).toMatchObject({ kind: 'image', imageId: 'img-1' });
    expect(request.blocks[16]).toMatchObject({ kind: 'markdown', role: 'table' });
    expect(doc.warnings.filter((w) => w.code === 'image-unsupported')).toHaveLength(3);
    expect(doc.warnings.some((w) => w.message.includes('HTTP 404'))).toBe(true);
  });

  it('uses the title override', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const { request } = await prepareWrite('x', {}, { type: 'new' }, undefined, '覆盖标题');
    expect(request.title).toBe('覆盖标题');
  });
});
