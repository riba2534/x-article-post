// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ContentState, EditorState, convertToRaw } from 'draft-js';
import type { WriteBlock } from '../../src/shared/types';
import {
  appendEmptyBlock,
  applyWrite,
  cleanupMarkers,
  findMarkerBlock,
  hasCharacterSample,
  hasMarkers,
  isContentEmpty,
  listMedia,
  markerText,
  mediaIdOf,
  placeBlockAtMarker,
  removeBlock,
  replaceMarker,
  selectBlockEnd,
} from '../../src/main/draft';

const sample = (text = 'x') => EditorState.createWithContent(ContentState.createFromText(text));
interface RawBlock {
  key: string;
  type: string;
  text: string;
  depth: number;
  inlineStyleRanges: { offset: number; length: number; style: string }[];
  entityRanges: { offset: number; length: number; key: number }[];
}
interface RawDraft {
  blocks: RawBlock[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entityMap: Record<string, { type: string; mutability: string; data: any }>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = (es: any): RawDraft => convertToRaw(es.getCurrentContent());
const write = (blocks: WriteBlock[], mode: 'append' | 'replace' = 'replace', es = sample()) => applyWrite(es, blocks, mode, 'r1');
const text = (t: string, extra: Partial<Extract<WriteBlock, { kind: 'text' }>> = {}): WriteBlock => ({ kind: 'text', type: 'unstyled', text: t, styles: [], links: [], ...extra });

/** Simulates X inserting an uploaded MEDIA block after `afterKey` (what onFilesAdded does). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertMedia(es: any, afterKey: string, mediaId?: string) {
  let content = es.getCurrentContent();
  content = content.createEntity('MEDIA', 'IMMUTABLE', { mediaItems: [{ mediaCategory: 'DraftTweetImage', localMediaId: 'l1', mediaId }] });
  const entity = content.getLastCreatedEntityKey();
  const sampleBlock = content.getBlockMap().find((b: { getCharacterList(): { size: number } }) => b.getCharacterList().size > 0);
  const ch = sampleBlock.getCharacterList().first().merge({ entity });
  const block = sampleBlock.merge({ key: 'media1', type: 'atomic', text: ' ', characterList: sampleBlock.getCharacterList().clear().push(ch) });
  const map = content.getBlockMap();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next = map.clear().withMutations((m: any) => map.forEach((b: any, k: string) => {
    m.set(k, b);
    if (k === afterKey) m.set('media1', block);
  }));
  return { es: EditorState.push(es, content.merge({ blockMap: next }), 'insert-fragment'), entity };
}

describe('applyWrite text blocks', () => {
  it('writes types, inline styles and link entities with exact offsets', () => {
    const { editorState, keys } = write([
      text('Title', { type: 'header-one' }),
      text('a bold link', {
        styles: [{ offset: 2, length: 4, style: 'BOLD' }, { offset: 2, length: 9, style: 'ITALIC' }],
        links: [{ offset: 7, length: 4, url: 'https://e.com' }],
      }),
      text('line1\nline2', { type: 'blockquote' }),
      text('li', { type: 'ordered-list-item' }),
    ]);
    const r = raw(editorState);
    expect(keys).toHaveLength(4);
    expect(r.blocks.map((b) => [b.type, b.text, b.depth])).toEqual([
      ['header-one', 'Title', 0],
      ['unstyled', 'a bold link', 0],
      ['blockquote', 'line1\nline2', 0],
      ['ordered-list-item', 'li', 0],
    ]);
    expect(r.blocks[1].inlineStyleRanges).toEqual([
      { offset: 2, length: 4, style: 'BOLD' },
      { offset: 2, length: 9, style: 'ITALIC' },
    ]);
    expect(r.blocks[1].entityRanges).toEqual([{ offset: 7, length: 4, key: 0 }]);
    expect(r.entityMap[0]).toEqual({ type: 'LINK', mutability: 'MUTABLE', data: { url: 'https://e.com' } });
    expect(r.blocks[0].inlineStyleRanges).toEqual([]);
  });

  it('skips empty links and gives each link its own entity', () => {
    const r = raw(write([text('ab cd', { links: [{ offset: 0, length: 2, url: 'u1' }, { offset: 3, length: 2, url: 'u2' }, { offset: 0, length: 0, url: 'x' }] })]).editorState);
    expect(r.blocks[0].entityRanges).toEqual([{ offset: 0, length: 2, key: 0 }, { offset: 3, length: 2, key: 1 }]);
    expect(Object.values(r.entityMap).map((e) => e.data.url)).toEqual(['u1', 'u2']);
  });

  it('splits style runs at every boundary and ignores ranges past the text', () => {
    const r = raw(write([text('abcdef', {
      styles: [{ offset: 4, length: 9, style: 'STRIKETHROUGH' }, { offset: 1, length: 2, style: 'BOLD' }, { offset: 1, length: 2, style: 'BOLD' }],
      links: [{ offset: 2, length: 3, url: 'u' }],
    })]).editorState);
    expect(r.blocks[0].inlineStyleRanges).toEqual([
      { offset: 1, length: 2, style: 'BOLD' },
      { offset: 4, length: 2, style: 'STRIKETHROUGH' },
    ]);
    expect(r.blocks[0].entityRanges).toEqual([{ offset: 2, length: 3, key: 0 }]);
  });

  it('caret ends at the end of the last block', () => {
    const { editorState, keys } = write([text('hello')]);
    const sel = editorState.getSelection();
    expect(sel.getAnchorKey()).toBe(keys[0]);
    expect(sel.getAnchorOffset()).toBe(5);
    expect(sel.isCollapsed()).toBe(true);
  });
});

describe('applyWrite atomic blocks', () => {
  it('builds MARKDOWN, LATEX, DIVIDER, TWEET exactly like X', () => {
    const r = raw(write([
      { kind: 'markdown', role: 'table', markdown: '| a |\n|---|\n| 1 |' },
      { kind: 'latex', tex: 'E=mc^2' },
      { kind: 'divider' },
      { kind: 'tweet', tweetId: '123', url: 'https://x.com/a/status/123' },
    ]).editorState);
    expect(r.blocks.map((b) => [b.type, b.text])).toEqual([
      ['atomic', ' '],
      ['atomic', 'E=mc^2'],
      ['atomic', ' '],
      ['atomic', ' '],
      ['unstyled', ''],
    ]);
    expect(r.blocks.map((b) => b.entityRanges)).toEqual([
      [{ offset: 0, length: 1, key: 0 }],
      [{ offset: 0, length: 6, key: 1 }],
      [{ offset: 0, length: 1, key: 2 }],
      [{ offset: 0, length: 1, key: 3 }],
      [],
    ]);
    expect(r.entityMap).toEqual({
      0: { type: 'MARKDOWN', mutability: 'MUTABLE', data: { markdown: '| a |\n|---|\n| 1 |' } },
      1: { type: 'LATEX', mutability: 'IMMUTABLE', data: {} },
      2: { type: 'DIVIDER', mutability: 'IMMUTABLE', data: {} },
      3: { type: 'TWEET', mutability: 'IMMUTABLE', data: { tweetId: '123' } },
    });
    expect(r.blocks.every((b) => b.inlineStyleRanges.length === 0)).toBe(true);
  });

  it('keeps fenced code as is and fences bare code', () => {
    const r = raw(write([
      { kind: 'markdown', role: 'code', language: 'ts', markdown: '```ts\nlet a\n```' },
      { kind: 'markdown', role: 'code', language: 'go', markdown: 'x := 1' },
      { kind: 'markdown', role: 'code', markdown: 'plain' },
    ]).editorState);
    expect(Object.values(r.entityMap).map((e) => e.data.markdown)).toEqual(['```ts\nlet a\n```', '```go\nx := 1\n```', '```\nplain\n```']);
  });

  it('does not add a trailing line after a text block', () => {
    const r = raw(write([{ kind: 'divider' }, text('end')]).editorState);
    expect(r.blocks.map((b) => b.text)).toEqual([' ', 'end']);
  });
});

describe('replace / append', () => {
  const existing = () => applyWrite(sample(), [text('old'), text('')], 'replace', 'r0').editorState;

  it('replace drops existing content', () => {
    expect(raw(write([text('new')], 'replace', existing()).editorState).blocks.map((b) => b.text)).toEqual(['new']);
  });

  it('append keeps existing content and drops trailing blank lines', () => {
    expect(raw(write([text('new')], 'append', existing()).editorState).blocks.map((b) => b.text)).toEqual(['old', 'new']);
  });

  it('append into an empty editor replaces it', () => {
    const es = sample('   ');
    expect(raw(write([text('new')], 'append', es).editorState).blocks.map((b) => b.text)).toEqual(['new']);
  });

  it('append keeps existing atomic blocks', () => {
    const base = write([{ kind: 'divider' }]).editorState;
    expect(raw(write([text('n')], 'append', base).editorState).blocks.map((b) => b.type)).toEqual(['atomic', 'unstyled']);
  });

  it('empty request leaves one empty block', () => {
    expect(raw(write([], 'replace', existing()).editorState).blocks.map((b) => b.text)).toEqual(['']);
  });

  it('creates unique keys distinct from existing ones', () => {
    const base = existing();
    const { editorState, keys } = write([text('a'), text('b'), text('c')], 'append', base);
    const all = raw(editorState).blocks.map((b) => b.key);
    expect(new Set(all).size).toBe(all.length);
    expect(keys.every((k) => k.length === 5)).toBe(true);
  });

  it('needs a character sample', () => {
    expect(hasCharacterSample(EditorState.createEmpty().getCurrentContent())).toBe(false);
    expect(hasCharacterSample(sample().getCurrentContent())).toBe(true);
    expect(() => write([text('a')], 'replace', EditorState.createEmpty())).toThrow(/sample/);
  });

  it('isContentEmpty', () => {
    expect(isContentEmpty(sample(' \n ').getCurrentContent())).toBe(true);
    expect(isContentEmpty(sample('a').getCurrentContent())).toBe(false);
    expect(isContentEmpty(write([{ kind: 'divider' }]).editorState.getCurrentContent())).toBe(false);
  });
});

describe('image markers', () => {
  const blocks: WriteBlock[] = [
    text('before'),
    { kind: 'image', imageId: 'img-a', alt: 'a', fallbackText: '[图片 a]' },
    { kind: 'image', imageId: 'img-b', alt: 'b', fallbackText: '' },
    text('after'),
  ];

  it('writes one unique placeholder block per image', () => {
    const { editorState, markers } = write(blocks);
    expect(markers).toEqual([
      { imageId: 'img-a', marker: '⟦xap:r1:0⟧', fallbackText: '[图片 a]' },
      { imageId: 'img-b', marker: '⟦xap:r1:1⟧', fallbackText: '' },
    ]);
    const r = raw(editorState);
    expect(r.blocks.map((b) => [b.type, b.text])).toEqual([
      ['unstyled', 'before'],
      ['unstyled', markerText('r1', 0)],
      ['unstyled', markerText('r1', 1)],
      ['unstyled', 'after'],
    ]);
    expect(hasMarkers(editorState.getCurrentContent())).toBe(true);
  });

  it('selects the end of the marker block', () => {
    const { editorState, markers } = write(blocks);
    const key = findMarkerBlock(editorState.getCurrentContent(), markers[0].marker)!;
    const sel = selectBlockEnd(editorState, key).getSelection();
    expect([sel.getAnchorKey(), sel.getAnchorOffset(), sel.getFocusOffset(), sel.getHasFocus()]).toEqual([key, markers[0].marker.length, markers[0].marker.length, true]);
    expect(findMarkerBlock(editorState.getCurrentContent(), 'nope')).toBeUndefined();
  });

  it('tracks MEDIA entities and their mediaId', () => {
    const { editorState, markers } = write(blocks);
    const key = findMarkerBlock(editorState.getCurrentContent(), markers[0].marker)!;
    expect(listMedia(editorState.getCurrentContent()).size).toBe(0);
    const pending = insertMedia(editorState, key);
    expect([...listMedia(pending.es.getCurrentContent()).values()]).toEqual([{ blockKey: 'media1', mediaId: undefined }]);
    const done = insertMedia(editorState, key, '1880');
    expect(listMedia(done.es.getCurrentContent()).get(done.entity)).toEqual({ blockKey: 'media1', mediaId: '1880' });
    expect(listMedia(write([{ kind: 'divider' }]).editorState.getCurrentContent()).size).toBe(0);
  });

  it('mediaIdOf', () => {
    expect(mediaIdOf({ mediaItems: [{ mediaId: 12 }] })).toBe('12');
    expect(mediaIdOf({ mediaItems: [{ mediaId: '' }] })).toBeUndefined();
    expect(mediaIdOf({ mediaItems: [] })).toBeUndefined();
    expect(mediaIdOf(undefined)).toBeUndefined();
  });

  it('moves the MEDIA block into the placeholder position and drops the placeholder', () => {
    const { editorState, markers } = write(blocks);
    const m1 = findMarkerBlock(editorState.getCurrentContent(), markers[1].marker)!;
    // X inserted the image after the second marker; it belongs at the first one.
    const { es } = insertMedia(editorState, m1, '1');
    const m0 = findMarkerBlock(es.getCurrentContent(), markers[0].marker)!;
    const placed = placeBlockAtMarker(es, m0, 'media1');
    expect(raw(placed).blocks.map((b) => b.text)).toEqual(['before', ' ', markers[1].marker, 'after']);
    expect(raw(placed).blocks[1].key).toBe('media1');
    expect(placed.getSelection().getAnchorKey()).toBe('media1');
    expect(() => placeBlockAtMarker(es, 'zzz', 'media1')).toThrow();
  });

  it('replaces a failed image placeholder with fallback text, or removes it', () => {
    const { editorState, markers } = write(blocks);
    let es = replaceMarker(editorState, markers[0].marker, '[图片 a]');
    es = replaceMarker(es, markers[1].marker, '');
    const r = raw(es);
    expect(r.blocks.map((b) => [b.type, b.text])).toEqual([['unstyled', 'before'], ['unstyled', '[图片 a]'], ['unstyled', 'after']]);
    expect(r.blocks[1].inlineStyleRanges).toEqual([]);
    expect(replaceMarker(es, 'missing', 'x')).toBe(es);
  });

  it('appendEmptyBlock + removeBlock round-trips the content', () => {
    const base = write([text('a'), { kind: 'divider' }]).editorState;
    const extra = appendEmptyBlock(base);
    expect(raw(extra.editorState).blocks.map((b) => [b.type, b.text]).slice(-2)).toEqual([['unstyled', ''], ['unstyled', '']]);
    expect(extra.editorState.getSelection().getAnchorKey()).toBe(extra.key);
    expect(raw(removeBlock(extra.editorState, extra.key)).blocks).toEqual(raw(base).blocks);
  });

  it('removeBlock deletes a block and keeps at least one', () => {
    const one = write([text('only')]);
    const after = removeBlock(one.editorState, one.keys[0]);
    expect(raw(after).blocks.map((b) => b.text)).toEqual(['']);
    expect(removeBlock(after, 'missing')).toBe(after);
  });

  it('cleanupMarkers removes marker-only blocks and strips inline markers', () => {
    const { editorState } = write([
      text(`keep ${markerText('old', 3)} me`, { styles: [{ offset: 0, length: 4, style: 'BOLD' }, { offset: 16, length: 2, style: 'ITALIC' }] }),
      { kind: 'image', imageId: 'i', alt: '', fallbackText: '' },
      text('tail'),
    ]);
    const { editorState: es, removed } = cleanupMarkers(editorState);
    expect(removed).toBe(2);
    const r = raw(es);
    expect(r.blocks.map((b) => b.text)).toEqual(['keep  me', 'tail']);
    expect(r.blocks[0].inlineStyleRanges).toEqual([{ offset: 0, length: 4, style: 'BOLD' }, { offset: 5, length: 2, style: 'ITALIC' }]);
    expect(hasMarkers(es.getCurrentContent())).toBe(false);
  });

  it('cleanupMarkers is a no-op without markers and keeps one block when all go', () => {
    const plain = write([text('a')]).editorState;
    expect(cleanupMarkers(plain)).toEqual({ editorState: plain, removed: 0 });
    const only = write([{ kind: 'image', imageId: 'i', alt: '', fallbackText: '' }]).editorState;
    expect(raw(cleanupMarkers(only).editorState).blocks.map((b) => b.text)).toEqual(['']);
  });
});
