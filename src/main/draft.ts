// Pure Draft.js state transforms. Classes are never imported: everything is reached through
// the instances handed in (X's bundled draft-js in the page, real draft-js in tests).
import type { WriteBlock } from '../shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Draft = any;

const MARKER_RE = /⟦xap:[^⟧]*⟧/g;

export const markerText = (runId: string, n: number): string => `⟦xap:${runId}:${n}⟧`;

export interface ImageMarker {
  imageId: string;
  marker: string;
  fallbackText: string;
}

export interface WriteOutcome {
  editorState: Draft;
  markers: ImageMarker[];
  /** Keys of the blocks created for the request, in order. */
  keys: string[];
}

/** Templates cloned for every new block/character, taken from the live content. */
interface Kit {
  sampleBlock: Draft;
  sampleChar: Draft;
  emptyStyle: Draft;
  newKey: () => string;
}

export function hasCharacterSample(content: Draft): boolean {
  return Boolean(content.getBlockMap().find((b: Draft) => b.getCharacterList().size > 0));
}

function makeKit(content: Draft): Kit {
  const sampleBlock = content.getBlockMap().find((b: Draft) => b.getCharacterList().size > 0);
  if (!sampleBlock) throw new Error('Draft.js character sample missing');
  const sampleChar = sampleBlock.getCharacterList().first();
  const used = new Set<string>(content.getBlockMap().keySeq().toArray());
  const newKey = (): string => {
    for (;;) {
      const key = Math.random().toString(36).slice(2, 7);
      if (key.length === 5 && !used.has(key)) {
        used.add(key);
        return key;
      }
    }
  };
  return { sampleBlock, sampleChar, emptyStyle: sampleChar.getStyle().clear(), newKey };
}

function makeBlock(kit: Kit, type: string, text: string, charAt: (i: number) => Draft): Draft {
  const characterList = kit.sampleBlock.getCharacterList().clear().withMutations((list: Draft) => {
    for (let i = 0; i < text.length; i++) list.push(charAt(i));
  });
  return kit.sampleBlock.merge({
    key: kit.newKey(),
    type,
    text,
    characterList,
    depth: 0,
    data: kit.sampleBlock.getData().clear(),
  });
}

/** Character metadata factory with flyweight caching (Draft does the same). */
function charFactory(kit: Kit): (styles: string[], entity: string | null) => Draft {
  const cache = new Map<string, Draft>();
  return (styles, entity) => {
    const id = `${styles.join(',')}|${entity ?? ''}`;
    let c = cache.get(id);
    if (!c) {
      const style = styles.reduce((s: Draft, name) => s.add(name), kit.emptyStyle);
      c = kit.sampleChar.merge({ style, entity });
      cache.set(id, c);
    }
    return c;
  };
}

function createEntity(content: Draft, type: string, mutability: string, data: object): { content: Draft; key: string } {
  const next = content.createEntity(type, mutability, data);
  return { content: next, key: next.getLastCreatedEntityKey() };
}

const ATOMIC: Record<'markdown' | 'divider' | 'tweet', [string, string]> = {
  markdown: ['MARKDOWN', 'MUTABLE'],
  divider: ['DIVIDER', 'IMMUTABLE'],
  tweet: ['TWEET', 'IMMUTABLE'],
};

function atomicData(block: Exclude<WriteBlock, { kind: 'text' } | { kind: 'image' } | { kind: 'latex' }>): object {
  switch (block.kind) {
    case 'markdown': {
      const md = block.role === 'code' && !block.markdown.startsWith('```')
        ? `\`\`\`${block.language ?? ''}\n${block.markdown}\n\`\`\``
        : block.markdown;
      return { markdown: md };
    }
    case 'tweet':
      return { tweetId: block.tweetId };
    case 'divider':
      return {};
  }
}

/** Builds the ContentBlocks (and their entities) for a request. */
function buildBlocks(kit: Kit, content: Draft, blocks: WriteBlock[], runId: string): { content: Draft; blocks: Draft[]; markers: ImageMarker[] } {
  const char = charFactory(kit);
  const out: Draft[] = [];
  const markers: ImageMarker[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'text': {
        const links: { start: number; end: number; key: string }[] = [];
        for (const link of block.links) {
          if (link.length <= 0 || !link.url) continue;
          const e = createEntity(content, 'LINK', 'MUTABLE', { url: link.url });
          content = e.content;
          links.push({ start: link.offset, end: link.offset + link.length, key: e.key });
        }
        out.push(makeBlock(kit, block.type, block.text, (i) => {
          const styles = block.styles.filter((s) => i >= s.offset && i < s.offset + s.length).map((s) => s.style);
          const entity = links.find((l) => i >= l.start && i < l.end)?.key ?? null;
          return char([...new Set(styles)].sort(), entity);
        }));
        break;
      }
      case 'latex': {
        const e = createEntity(content, 'LATEX', 'IMMUTABLE', {});
        content = e.content;
        out.push(makeBlock(kit, 'atomic', block.tex, () => char([], e.key)));
        break;
      }
      case 'image': {
        const marker = markerText(runId, markers.length);
        markers.push({ imageId: block.imageId, marker, fallbackText: block.fallbackText });
        out.push(makeBlock(kit, 'unstyled', marker, () => char([], null)));
        break;
      }
      default: {
        const [type, mutability] = ATOMIC[block.kind];
        const e = createEntity(content, type, mutability, atomicData(block));
        content = e.content;
        out.push(makeBlock(kit, 'atomic', ' ', () => char([], e.key)));
      }
    }
  }
  return { content, blocks: out, markers };
}

export function isContentEmpty(content: Draft): boolean {
  return content.getBlockMap().every((b: Draft) => b.getType() !== 'atomic' && b.getText().trim() === '');
}

const isBlankText = (b: Draft): boolean => b.getType() !== 'atomic' && b.getText().trim() === '';

function collapsedAt(es: Draft, key: string, offset: number): Draft {
  return es.getSelection().constructor.createEmpty(key).merge({ anchorOffset: offset, focusOffset: offset });
}

/** Pushes a new block map, keeping entities, with the caret at `caretKey` (end of block). */
function pushBlockMap(es: Draft, content: Draft, blockMap: Draft, caretKey: string, change: string): Draft {
  const caret = blockMap.get(caretKey);
  const selection = collapsedAt(es, caretKey, caret ? caret.getLength() : 0);
  const next = content.merge({ blockMap, selectionBefore: es.getSelection(), selectionAfter: selection });
  return es.constructor.push(es, next, change);
}

/**
 * Writes the request blocks. 'replace' drops all existing blocks; 'append' keeps them (minus
 * trailing blank lines). An empty editor is always replaced. Needs a character sample.
 */
export function applyWrite(es: Draft, blocks: WriteBlock[], mode: 'append' | 'replace', runId: string): WriteOutcome {
  const current = es.getCurrentContent();
  const kit = makeKit(current);
  const built = buildBlocks(kit, current, blocks, runId);
  const created = [...built.blocks];
  // X keeps an editable line after a trailing atomic block; an empty request still needs one block.
  if (!created.length || created[created.length - 1].getType() === 'atomic') {
    created.push(makeBlock(kit, 'unstyled', '', () => null));
  }
  let base = current.getBlockMap();
  if (mode === 'replace' || isContentEmpty(current)) {
    base = base.clear();
  } else {
    while (base.size && isBlankText(base.last())) base = base.butLast();
  }
  const blockMap = base.withMutations((m: Draft) => {
    for (const b of created) m.set(b.getKey(), b);
  });
  const keys = built.blocks.map((b: Draft) => b.getKey());
  const editorState = pushBlockMap(es, built.content, blockMap, created[created.length - 1].getKey(), 'insert-fragment');
  return { editorState, markers: built.markers, keys };
}

export function findMarkerBlock(content: Draft, marker: string): string | undefined {
  return content.getBlockMap().find((b: Draft) => b.getText().includes(marker))?.getKey();
}

export function hasMarkers(content: Draft): boolean {
  return content.getBlockMap().some((b: Draft) => b.getText().search(MARKER_RE) >= 0);
}

/** Caret at the end of `key`, forced so X inserts uploads right after that block. */
export function selectBlockEnd(es: Draft, key: string): Draft {
  const block = es.getCurrentContent().getBlockForKey(key);
  return es.constructor.forceSelection(es, collapsedAt(es, key, block.getLength()).merge({ hasFocus: true }));
}

export interface MediaInfo {
  blockKey: string;
  mediaId?: string;
}

export function mediaIdOf(data: Draft): string | undefined {
  const id = data?.mediaItems?.[0]?.mediaId;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

/** MEDIA entities of atomic blocks, keyed by entity key. */
export function listMedia(content: Draft): Map<string, MediaInfo> {
  const out = new Map<string, MediaInfo>();
  content.getBlockMap().forEach((b: Draft, blockKey: string) => {
    if (b.getType() !== 'atomic') return;
    const entityKey = b.getEntityAt(0);
    if (!entityKey) return;
    const entity = content.getEntity(entityKey);
    if (entity.getType() === 'MEDIA') out.set(entityKey, { blockKey, mediaId: mediaIdOf(entity.getData()) });
  });
  return out;
}

/** Moves block `blockKey` to where the marker block is and removes the marker block. */
export function placeBlockAtMarker(es: Draft, markerKey: string, blockKey: string): Draft {
  const content = es.getCurrentContent();
  const map = content.getBlockMap();
  if (!map.has(markerKey) || !map.has(blockKey)) throw new Error('block to place was not found');
  const moved = map.get(blockKey);
  const blockMap = map.clear().withMutations((m: Draft) => {
    map.forEach((b: Draft, k: string) => {
      if (k === markerKey) m.set(blockKey, moved);
      else if (k !== blockKey) m.set(k, b);
    });
  });
  return pushBlockMap(es, content, blockMap, blockKey, 'remove-range');
}

export function removeBlock(es: Draft, key: string): Draft {
  const content = es.getCurrentContent();
  const map = content.getBlockMap();
  if (!map.has(key)) return es;
  return withBlockMap(es, content, map.delete(key), 'remove-range');
}

/** Pushes `blockMap`, guaranteeing at least one block; caret at the end of the last block. */
function withBlockMap(es: Draft, content: Draft, blockMap: Draft, change: string): Draft {
  if (!blockMap.size) {
    const kit = makeKit(content);
    const empty = makeBlock(kit, 'unstyled', '', () => null);
    blockMap = blockMap.set(empty.getKey(), empty);
  }
  return pushBlockMap(es, content, blockMap, blockMap.last().getKey(), change);
}

/** Replaces the marker block with a plain unstyled block holding `text` (removed when empty). */
export function replaceMarker(es: Draft, marker: string, text: string): Draft {
  const content = es.getCurrentContent();
  const key = findMarkerBlock(content, marker);
  if (!key) return es;
  if (!text) return removeBlock(es, key);
  const kit = makeKit(content);
  const plain = kit.sampleChar.merge({ style: kit.emptyStyle, entity: null });
  const block = content.getBlockForKey(key).merge({
    type: 'unstyled',
    text,
    characterList: makeBlock(kit, 'unstyled', text, () => plain).getCharacterList(),
  });
  return withBlockMap(es, content, content.getBlockMap().set(key, block), 'change-block-type');
}

/** Removes every `⟦xap:…⟧` marker; blocks that only held markers are dropped. */
export function cleanupMarkers(es: Draft): { editorState: Draft; removed: number } {
  const content = es.getCurrentContent();
  let removed = 0;
  const blockMap = content.getBlockMap().clear().withMutations((m: Draft) => {
    content.getBlockMap().forEach((b: Draft, k: string) => {
      const text: string = b.getText();
      const ranges = [...text.matchAll(MARKER_RE)];
      if (!ranges.length) {
        m.set(k, b);
        return;
      }
      removed += ranges.length;
      let kept = '';
      let chars = b.getCharacterList().clear();
      let from = 0;
      for (const r of [...ranges, { index: text.length, 0: '' }]) {
        const to = r.index ?? text.length;
        kept += text.slice(from, to);
        chars = chars.concat(b.getCharacterList().slice(from, to));
        from = to + r[0].length;
      }
      if (kept.trim() !== '') m.set(k, b.merge({ text: kept, characterList: chars }));
    });
  });
  if (!removed) return { editorState: es, removed };
  return { editorState: withBlockMap(es, content, blockMap, 'remove-range'), removed };
}
