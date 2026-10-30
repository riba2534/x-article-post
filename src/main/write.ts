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
import { findDraftNode, findEditor, findOnFilesAdded, setCover, setTitle, sleep, waitContentSaved } from './dom';

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
const SAVE_TIMEOUT_MS = 15_000;
const STICK_MS = 1500;
const CANCEL_GRACE_MS = 15_000;

function requireNode(): Draft {
  const node = findDraftNode();
  if (!node) throw new Error('X 编辑器未就绪');
  return node;
}

// X updates `props.editorState` (Redux) without refreshing the Draft instance's
// `_latestEditorState`, which Draft's focus/blur/select handlers push back via onChange. Live
// tests showed that resurrecting old states (lost image blocks), so we keep it in sync ourselves.

/** Our last commit until X's props catch up with it. */
let pending: { es: Draft; prev: Draft } | null = null;

/** Current editor state; also re-syncs Draft's `_latestEditorState` with X's props. */
function editorState(): Draft {
  const node = requireNode();
  const props = node.props.editorState;
  if (pending && props === pending.prev) return pending.es;
  pending = null;
  if ('_latestEditorState' in node) node._latestEditorState = props;
  return props;
}

/** performance.now() of our latest editor change; X's autosave must start after it. */
let lastEdit = 0;
function commit(es: Draft): void {
  const node = requireNode();
  pending = { es, prev: node.props.editorState };
  lastEdit = performance.now();
  if (typeof node.update === 'function') node.update(es);
  else node.props.onChange(es);
}
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

function checkCancel(io: WriteIO): void {
  if (io.isCancelled()) throw new Cancelled();
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs: number, io: WriteIO, step = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    checkCancel(io);
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

/** Waits until X stops replacing the content (it loads the saved article after the editor mounts). */
async function waitStable(io: WriteIO, quietMs = 1500, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let content = editorState().getCurrentContent();
  let since = Date.now();
  while (Date.now() < deadline && Date.now() - since < quietMs) {
    checkCancel(io);
    await sleep(250);
    const now = editorState().getCurrentContent();
    if (now !== content) {
      content = now;
      since = Date.now();
    }
  }
}

function toFile(img: PreparedImage): File {
  const bin = atob(img.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], img.fileName, { type: img.mime });
}

/** One upload through X's onFilesAdded, then moves the MEDIA block onto the placeholder. */
async function uploadOnce(marker: string, file: File, io: WriteIO, onWait: (s: number) => void): Promise<{ entityKey: string } | null> {
  const markerKey = await waitFor(() => findMarkerBlock(editorState().getCurrentContent(), marker), 3000, io);
  if (!markerKey) throw new Error('图片占位符丢失');
  const before = new Set(listMedia(editorState().getCurrentContent()).keys());
  findEditor()?.focus();
  commit(selectBlockEnd(editorState(), markerKey));
  await frame();
  const upload = findOnFilesAdded();
  if (!upload) throw new Error('未找到 X 的图片上传入口');
  upload([file]);

  const started = Date.now();
  let seen: string | undefined;
  const freshKey = () => [...listMedia(editorState().getCurrentContent()).keys()].find((key) => !before.has(key));
  const dropSeen = () => {
    const leftover = seen && listMedia(editorState().getCurrentContent()).get(seen);
    if (leftover) commit(removeBlock(editorState(), leftover.blockKey));
  };
  let lastBeat = started;
  const deadline = started + UPLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (io.isCancelled()) {
      // X finishes an upload it already started; remove the image if it lands shortly.
      for (const end = Date.now() + CANCEL_GRACE_MS; !seen && Date.now() < end; ) {
        await sleep(400);
        seen = freshKey();
      }
      dropSeen();
      throw new Cancelled();
    }
    const entityKey = freshKey();
    const info = entityKey && listMedia(editorState().getCurrentContent()).get(entityKey);
    if (entityKey && info) {
      seen = entityKey;
      if (info.mediaId) {
        await sleep(300); // let X finish its own follow-up update
        settle([{ marker, entityKey }], []);
        // X sometimes drops a freshly inserted image a moment later; then this attempt failed.
        await sleep(STICK_MS);
        return listMedia(editorState().getCurrentContent()).has(entityKey) ? { entityKey } : null;
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
  dropSeen(); // timed out: a retry starts clean
  return null;
}

async function uploadImage(m: ImageMarker, index: number, total: number, io: WriteIO): Promise<{ entityKey: string } | null> {
  const label = `图片 ${index + 1}/${total}`;
  const file = toFile(await io.getImage(m.imageId));
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    io.progress('image', attempt === 1 ? `上传${label}` : `重试${label}（第 ${attempt} 次）`, index + 1, total);
    const done = await uploadOnce(m.marker, file, io, (s) => io.progress('image', `等待${label}上传（${s} s）`, index + 1, total));
    if (done) return done;
  }
  return null;
}

type Placed = Pick<ImageMarker, 'marker'> & { entityKey: string };
type Failed = ImageMarker & { error: string };

/**
 * Applies (again, if X's async updates resurrected an older state) every finished placement and
 * fallback. Idempotent; returns how many fixes were needed.
 */
function settle(placed: Placed[], failed: Failed[]): number {
  let fixes = 0;
  for (const p of placed) {
    const es = editorState();
    const mk = findMarkerBlock(es.getCurrentContent(), p.marker);
    const media = listMedia(es.getCurrentContent()).get(p.entityKey);
    if (!mk || !media) continue;
    commit(placeBlockAtMarker(es, mk, media.blockKey));
    fixes++;
  }
  for (const f of failed) {
    const es = editorState();
    if (!findMarkerBlock(es.getCurrentContent(), f.marker)) continue;
    commit(replaceMarker(es, f.marker, f.fallbackText));
    fixes++;
  }
  return fixes;
}

/** X's late upload updates can bring back an older state; re-apply until it stays put. */
async function settleAll(placed: Placed[], failed: Failed[]): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await sleep(1000);
    if (!settle(placed, failed)) return;
  }
}

function cleanup(): void {
  const { editorState: next, removed } = cleanupMarkers(editorState());
  if (removed) commit(next);
}

/** Re-applies placements and removes placeholders until nothing changes, then waits for a save
 * of that state; repeats when X brought an older state back after the save. */
async function finalize(placed: Placed[], failed: Failed[]): Promise<boolean> {
  const tidy = (): boolean => {
    const edited = lastEdit;
    settle(placed, failed);
    cleanup();
    return lastEdit !== edited;
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let round = 0; round < 5 && (tidy() || round === 0); round++) await sleep(1000);
    const saved = await waitContentSaved(lastEdit, SAVE_TIMEOUT_MS);
    await sleep(1000);
    if (!tidy()) return saved;
  }
  return false;
}

export async function runWrite(req: MainWriteRequest, io: WriteIO): Promise<MainResult> {
  const result: MainResult = { blocksWritten: 0, imagesOk: 0, imagesFailed: [], titleSet: false, coverSet: false, warnings: [] };
  const placed: (Placed & ImageMarker)[] = [];
  const failed: Failed[] = [];
  const syncTimer = setInterval(() => {
    try {
      if (findDraftNode()) editorState();
    } catch {
      // editor unmounted; next read reports it
    }
  }, 100);
  try {
    io.progress('text', '等待 X 编辑器就绪');
    if (!(await waitFor(findDraftNode, 30_000, io))) throw new Error('X 编辑器未就绪（标签页需在前台）');
    const pageId = articleIdFromUrl(location.href);
    if (req.articleId && pageId !== req.articleId) throw new Error(`当前页面不是目标草稿 ${req.articleId}`);
    result.articleId = pageId;

    await waitStable(io);
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
    let out = applyWrite(editorState(), req.blocks, mode, req.runId);
    for (let attempt = 0; ; attempt++) {
      commit(out.editorState);
      await sleep(1500);
      const first = out.keys[0];
      if (!first || editorState().getCurrentContent().getBlockMap().has(first)) break;
      // X replaced the editor content (late article load): write again on top of what it loaded.
      if (attempt === 2) throw new Error('正文写入未生效');
      out = applyWrite(editorState(), req.blocks, mode, req.runId);
    }
    result.blocksWritten = req.blocks.length;

    if (req.title) {
      io.progress('title', '设置标题');
      result.titleSet = await setTitle(req.title);
      if (!result.titleSet) result.warnings.push('未找到标题输入框，标题未设置');
    }

    const { markers } = out;
    const placeImage = async (m: ImageMarker): Promise<void> => {
      let error = '上传失败或超时';
      try {
        const done = await uploadImage(m, markers.indexOf(m), markers.length, io);
        if (done) {
          placed.push({ ...m, entityKey: done.entityKey });
          return;
        }
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        error = e instanceof Error ? e.message : String(e);
      }
      const f = { ...m, error };
      failed.push(f);
      settle([], [f]);
    };
    for (const m of markers) await placeImage(m);

    if (req.coverImageId) {
      io.progress('cover', '设置封面');
      try {
        const cover = await setCover(toFile(await io.getImage(req.coverImageId)), () => checkCancel(io));
        result.coverSet = cover.ok;
        if (!cover.ok) result.warnings.push(cover.warning);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        result.warnings.push(`封面设置失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    io.progress('cleanup', '清理占位符');
    await settleAll(placed, failed);
    // Images X dropped after they were placed: upload once more where the placeholder came back.
    const content = editorState().getCurrentContent();
    const media = listMedia(content);
    const lost = placed.filter((p) => !media.has(p.entityKey));
    for (const p of lost) {
      placed.splice(placed.indexOf(p), 1);
      if (findMarkerBlock(content, p.marker)) await placeImage(p);
      else failed.push({ ...p, error: 'X 丢弃了已上传的图片' });
    }
    io.progress('cleanup', '等待 X 自动保存');
    if (!(await finalize(placed, failed))) result.warnings.push('未确认 X 已保存最终内容，请检查草稿');
    if (hasMarkers(editorState().getCurrentContent())) result.warnings.push('仍有占位符残留');
    result.articleId = articleIdFromUrl(location.href) ?? result.articleId;
    return result;
  } catch (e) {
    try {
      if (findDraftNode()) await finalize(placed, failed);
    } catch (cleanupError) {
      result.warnings.push(`清理占位符失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    result.error = e instanceof Cancelled ? 'cancelled' : e instanceof Error ? e.message : String(e);
    return result;
  } finally {
    clearInterval(syncTimer);
    pending = null;
    result.imagesOk = placed.length;
    result.imagesFailed = failed.map((f) => ({ imageId: f.imageId, error: f.error }));
  }
}
