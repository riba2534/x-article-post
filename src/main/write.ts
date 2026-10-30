// The write flow in the MAIN world: text blocks, title, images, cover, cleanup. Never publishes.
import type { PreparedImage, WritePhase } from '../shared/types';
import { articleIdFromUrl, type MainResult, type MainWriteRequest } from '../content/protocol';
import {
  applyWrite,
  cleanupMarkers,
  findMarkerBlock,
  hasCharacterSample,
  hasMarkers,
  isContentEmpty,
  listMedia,
  placeBlockAtMarker,
  removeBlock,
  replaceMarker,
  selectBlockEnd,
  type Draft,
  type ImageMarker,
} from './draft';
import { findDraftNode, findEditor, findOnFilesAdded, setCover, setTitle, sleep } from './dom';

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface WriteIO {
  progress(phase: WritePhase, message: string, current?: number, total?: number): void;
  getImage(imageId: string): Promise<PreparedImage>;
  isCancelled(): boolean;
}

export const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_ATTEMPTS = 3;
const HEARTBEAT_MS = 10_000;

function requireNode(): Draft {
  const node = findDraftNode();
  if (!node) throw new Error('X 编辑器未就绪');
  return node;
}

const editorState = (): Draft => requireNode().props.editorState;
const commit = (es: Draft): void => requireNode().props.onChange(es);
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs: number, io: WriteIO, step = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (io.isCancelled()) throw new Cancelled();
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

function toFile(img: PreparedImage): File {
  const bin = atob(img.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], img.fileName, { type: img.mime });
}

/** One upload through X's onFilesAdded, then moves the MEDIA block onto the placeholder. */
async function uploadOnce(marker: string, file: File, io: WriteIO, onWait: (s: number) => void): Promise<string | null> {
  const es = editorState();
  const markerKey = findMarkerBlock(es.getCurrentContent(), marker);
  if (!markerKey) throw new Error('图片占位符丢失');
  const before = new Set(listMedia(es.getCurrentContent()).keys());
  findEditor()?.focus();
  commit(selectBlockEnd(editorState(), markerKey));
  await frame();
  const upload = findOnFilesAdded();
  if (!upload) throw new Error('未找到 X 的图片上传入口');
  upload([file]);

  const started = Date.now();
  let seen: string | undefined;
  let lastBeat = started;
  const deadline = started + UPLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (io.isCancelled()) throw new Cancelled();
    const media = listMedia(editorState().getCurrentContent());
    const fresh = [...media].find(([key]) => !before.has(key));
    if (fresh) {
      const [entityKey, info] = fresh;
      seen = entityKey;
      if (info.mediaId) {
        await sleep(300); // let X finish its own follow-up update
        const now = editorState();
        const block = listMedia(now.getCurrentContent()).get(entityKey)?.blockKey ?? info.blockKey;
        const mk = findMarkerBlock(now.getCurrentContent(), marker);
        if (!mk) throw new Error('图片占位符丢失');
        commit(placeBlockAtMarker(now, mk, block));
        return info.mediaId;
      }
    } else if (seen) {
      return null; // X dropped the pending block: upload failed
    }
    if (Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      onWait(Math.round((lastBeat - started) / 1000));
    }
    await sleep(400);
  }
  // Timed out: drop the half-uploaded block so a retry starts clean.
  const leftover = seen && listMedia(editorState().getCurrentContent()).get(seen);
  if (leftover) commit(removeBlock(editorState(), leftover.blockKey));
  return null;
}

async function uploadImage(m: ImageMarker, index: number, total: number, io: WriteIO): Promise<string | null> {
  const label = `图片 ${index + 1}/${total}`;
  const file = toFile(await io.getImage(m.imageId));
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    io.progress('image', attempt === 1 ? `上传${label}` : `重试${label}（第 ${attempt} 次）`, index + 1, total);
    const id = await uploadOnce(m.marker, file, io, (s) => io.progress('image', `等待${label}上传（${s} s）`, index + 1, total));
    if (id) return id;
  }
  return null;
}

function cleanup(): number {
  const node = findDraftNode();
  if (!node) return 0;
  const { editorState: next, removed } = cleanupMarkers(node.props.editorState);
  if (removed) node.props.onChange(next);
  return removed;
}

export async function runWrite(req: MainWriteRequest, io: WriteIO): Promise<MainResult> {
  const result: MainResult = { blocksWritten: 0, imagesOk: 0, imagesFailed: [], titleSet: false, coverSet: false, warnings: [] };
  try {
    io.progress('text', '等待 X 编辑器就绪');
    if (!(await waitFor(findDraftNode, 30_000, io))) throw new Error('X 编辑器未就绪（标签页需在前台）');
    const pageId = articleIdFromUrl(location.href);
    if (req.articleId && pageId !== req.articleId) throw new Error(`当前页面不是目标草稿 ${req.articleId}`);
    result.articleId = pageId;

    let mode = req.mode;
    if (!hasCharacterSample(editorState().getCurrentContent())) {
      // Empty editor: type one character so Draft has a block/character sample to clone.
      findEditor()?.focus();
      document.execCommand('insertText', false, 'x');
      if (!(await waitFor(() => hasCharacterSample(editorState().getCurrentContent()), 3000, io))) throw new Error('无法初始化编辑器');
      mode = 'replace';
    } else if (isContentEmpty(editorState().getCurrentContent())) {
      mode = 'replace';
    }

    io.progress('text', '写入正文');
    const out = applyWrite(editorState(), req.blocks, mode, req.runId);
    commit(out.editorState);
    const first = out.keys[0];
    if (first && !(await waitFor(() => editorState().getCurrentContent().getBlockMap().has(first), 3000, io))) {
      throw new Error('正文写入未生效');
    }
    result.blocksWritten = req.blocks.length;

    if (req.title) {
      io.progress('title', '设置标题');
      result.titleSet = await setTitle(req.title);
      if (!result.titleSet) result.warnings.push('未找到标题输入框，标题未设置');
    }

    const total = out.markers.length;
    for (const [i, m] of out.markers.entries()) {
      let error = '上传失败或超时';
      let ok = false;
      try {
        ok = Boolean(await uploadImage(m, i, total, io));
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        error = e instanceof Error ? e.message : String(e);
      }
      if (ok) {
        result.imagesOk++;
      } else {
        result.imagesFailed.push({ imageId: m.imageId, error });
        commit(replaceMarker(editorState(), m.marker, m.fallbackText));
      }
    }

    if (req.coverImageId) {
      io.progress('cover', '设置封面');
      try {
        const cover = await setCover(toFile(await io.getImage(req.coverImageId)), () => {
          if (io.isCancelled()) throw new Cancelled();
        });
        result.coverSet = cover.ok;
        if (!cover.ok) result.warnings.push(cover.warning);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        result.warnings.push(`封面设置失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    io.progress('cleanup', '清理占位符');
    cleanup();
    await sleep(200);
    if (hasMarkers(editorState().getCurrentContent())) result.warnings.push('仍有占位符残留');
    // Give X's autosave a moment before the caller reports success.
    await sleep(2500);
    result.articleId = articleIdFromUrl(location.href) ?? result.articleId;
    return result;
  } catch (e) {
    try {
      cleanup();
    } catch {
      // editor gone; nothing to clean
    }
    result.error = e instanceof Cancelled ? 'cancelled' : e instanceof Error ? e.message : String(e);
    return result;
  }
}
