// Prepare pipeline: Markdown -> ArticleDoc -> images fetched/rendered/normalized -> WriteRequest.
// Runs in the side panel and in the offscreen document; only needs a DOM, not the panel UI.
import { convertMarkdown } from '../core/index';
import type {
  ArticleDoc,
  Block,
  ConvertOptions,
  ImageSource,
  PreparedImage,
  Warning,
  WriteBlock,
  WriteProgress,
  WriteRequest,
  WriteTarget,
} from '../shared/types';
import { MARKDOWN_BLOCK_LIMIT } from '../shared/types';
import { errorMessage } from './errors';
import { FETCH_CONCURRENCY, fetchImageBytes, isPrivateHost, mapLimit } from './fetch';
import { bytesToBase64, extensionFor, normalizeImage, type NormalizedImage } from './image';
import { markdownImageUrls } from './markdown-html';
import { mermaidToPng } from './mermaid';
import { tableToPng } from './table';

export interface PrepareResult {
  doc: ArticleDoc;
  request: WriteRequest;
}

export type ImageKey = number | 'cover';

export interface ImageRef {
  /** Block index, or 'cover' for doc.cover. */
  key: ImageKey;
  source: ImageSource;
}

export type ImagePreparer = (source: ImageSource) => Promise<NormalizedImage>;

export interface AssembleOptions {
  runId?: string;
  title?: string;
  onProgress?: (p: WriteProgress) => void;
  concurrency?: number;
}

export function collectImages(doc: ArticleDoc): ImageRef[] {
  const refs: ImageRef[] = [];
  doc.blocks.forEach((block, i) => {
    if (block.kind === 'image') refs.push({ key: i, source: block.source });
  });
  if (doc.cover) refs.push({ key: 'cover', source: { type: 'url', url: doc.cover } });
  return refs;
}

/** Remote URLs a source needs to fetch (table cells may hold several). */
export function sourceUrls(source: ImageSource): string[] {
  if (source.type === 'url') return [source.url];
  if (source.type === 'table') return markdownImageUrls(source.markdown);
  return [];
}

/**
 * Host permission patterns for every remote image in the doc (cover included). Pure and
 * synchronous so the side panel can call chrome.permissions.request inside the click handler.
 */
export function collectPermissionOrigins(doc: ArticleDoc): string[] {
  const origins = new Set<string>();
  for (const ref of collectImages(doc)) {
    for (const raw of sourceUrls(ref.source)) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      // Private hosts are never fetched, so there is nothing to ask permission for.
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !isPrivateHost(url.hostname)) origins.add(`${url.protocol}//${url.hostname}/*`);
    }
  }
  return [...origins];
}

function describe(source: ImageSource): string {
  if (source.type === 'mermaid') return 'Mermaid 图';
  if (source.type === 'table') return '表格图片';
  return source.url.startsWith('data:') ? '内嵌图片' : source.url;
}

/**
 * Splits a GFM table into chunks of at most `limit` characters by rows, repeating the header and
 * delimiter rows in each chunk (same rule core applies to plain tables).
 */
export function splitTableMarkdown(markdown: string, limit = MARKDOWN_BLOCK_LIMIT): string[] {
  if (markdown.length <= limit) return [markdown];
  const [header = '', delimiter = '', ...rows] = markdown.split('\n');
  const head = `${header}\n${delimiter}`;
  const chunks: string[] = [];
  let chunk = head;
  for (const row of rows) {
    if (chunk !== head && chunk.length + 1 + row.length > limit) {
      chunks.push(chunk);
      chunk = head;
    }
    chunk += `\n${row}`;
  }
  chunks.push(chunk);
  return chunks;
}

function fallbackBlock(text: string): WriteBlock {
  return { kind: 'text', type: 'unstyled', text, styles: [], links: [] };
}

type Outcome = { ok: true; image: NormalizedImage } | { ok: false; error: string };

/** Turns an ArticleDoc into a WriteRequest; image failures become fallbacks plus warnings. */
export async function assembleRequest(
  doc: ArticleDoc,
  target: WriteTarget,
  prepareImage: ImagePreparer,
  opts: AssembleOptions = {},
): Promise<PrepareResult> {
  const runId = opts.runId ?? crypto.randomUUID();
  const refs = collectImages(doc);
  const total = refs.length;
  const report = (message: string, current?: number) =>
    opts.onProgress?.({ runId, phase: 'prepare', message, current, total: total || undefined });

  report(total ? `准备图片 0/${total}` : '整理内容', total ? 0 : undefined);
  let done = 0;
  const outcomes = await mapLimit<ImageRef, Outcome>(refs, opts.concurrency ?? FETCH_CONCURRENCY, async (ref) => {
    try {
      return { ok: true, image: await prepareImage(ref.source) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    } finally {
      done++;
      report(`准备图片 ${done}/${total}`, done);
    }
  });

  const warnings: Warning[] = [...doc.warnings];
  const images: Record<string, PreparedImage> = {};
  const ids = new Map<ImageKey, string>();
  let n = 0;
  refs.forEach((ref, i) => {
    const outcome = outcomes[i];
    if (!outcome.ok) {
      const what = ref.key === 'cover' ? '封面' : ref.source.type === 'table' ? '表格图片（已改为 Markdown 表格）' : '图片';
      warnings.push({ code: 'image-unsupported', message: `${what}未能准备：${describe(ref.source)}（${outcome.error}）` });
      return;
    }
    const id = ref.key === 'cover' ? 'cover' : `img-${++n}`;
    const { bytes, mime, width, height } = outcome.image;
    images[id] = { id, base64: bytesToBase64(bytes), mime, fileName: `${id}.${extensionFor(mime)}`, width, height };
    ids.set(ref.key, id);
  });

  const blocks = doc.blocks.flatMap((block: Block, i): WriteBlock | WriteBlock[] => {
    if (block.kind !== 'image') return block;
    const imageId = ids.get(i);
    if (imageId) return { kind: 'image', imageId, alt: block.alt, fallbackText: block.fallbackText };
    if (block.source.type === 'table') return splitTableMarkdown(block.source.markdown).map((markdown) => ({ kind: 'markdown', role: 'table', markdown }));
    return fallbackBlock(block.fallbackText || block.alt || '[图片]');
  });

  const request: WriteRequest = { runId, title: opts.title ?? doc.title, blocks, images, target };
  const coverImageId = ids.get('cover');
  if (coverImageId) request.coverImageId = coverImageId;
  report('内容已就绪', total || undefined);
  return { doc: { ...doc, warnings }, request };
}

export async function prepareImageSource(source: ImageSource): Promise<NormalizedImage> {
  switch (source.type) {
    case 'url': {
      const { bytes, contentType } = await fetchImageBytes(source.url);
      return normalizeImage(bytes, contentType);
    }
    case 'mermaid':
      return mermaidToPng(source.code);
    case 'table':
      return tableToPng(source.markdown);
  }
}

export async function prepareWrite(
  markdown: string,
  options: Partial<ConvertOptions>,
  target: WriteTarget,
  onProgress?: (p: WriteProgress) => void,
  titleOverride?: string,
): Promise<PrepareResult> {
  const doc = convertMarkdown(markdown, options);
  return assembleRequest(doc, target, prepareImageSource, { onProgress, title: titleOverride?.trim() || undefined });
}
