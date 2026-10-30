// The write flow in the MAIN world: text blocks, title, images, cover, cleanup. Never publishes.
import type { PreparedImage, WritePhase } from '../shared/types';
import { articleIdFromUrl, type MainResult, type MainWriteRequest } from '../content/protocol';
import { emptyMainResult, errorMessage, sleep } from '../content/util';
import {
  appendEmptyBlock,
  applyWrite,
  cleanupMarkers,
  findMarkerBlock,
  hasCharacterSample,
  hasMarkers,
  listMedia,
  placeBlockAtMarker,
  removeBlock,
  replaceMarker,
  selectBlockEnd,
  type Draft,
  type ImageMarker,
} from './draft';
import { findDraftNode, findEditor, findOnFilesAdded, setCover, setTitle, watchSaves } from './dom';

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

const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_ATTEMPTS = 3;
const HEARTBEAT_MS = 10_000;
const SAVE_TIMEOUT_MS = 15_000;
const STICK_MS = 1500;
const CANCEL_GRACE_MS = 15_000;

// X updates `props.editorState` (Redux) without refreshing the Draft instance's
// `_latestEditorState`, which Draft's focus/blur/select handlers push back via onChange. Live
// tests showed that resurrecting old states (lost image blocks). While a write runs, the field
// is replaced by an accessor that always resolves to the current state: the newest value Draft
// or we assigned until X's props move on, otherwise the props. X occasionally never takes a
// state over into its props; after OWN_STATE_MS the props win again so later checks see the
// truth and re-apply.
const OWN_STATE_MS = 1000;
const unguards = new Map<Draft, () => void>();

function guardLatest(node: Draft): void {
  if (unguards.has(node) || !('_latestEditorState' in node)) return;
  let own: { es: Draft; prev: Draft; at: number } | null = null;
  Object.defineProperty(node, '_latestEditorState', {
    configurable: true,
    get: () => {
      const props = node.props.editorState;
      return own && props === own.prev && Date.now() - own.at < OWN_STATE_MS ? own.es : props;
    },
    set: (es: Draft) => {
      own = es === node.props.editorState ? null : { es, prev: node.props.editorState, at: Date.now() };
    },
  });
  unguards.set(node, () => {
    const current = node._latestEditorState;
    delete node._latestEditorState;
    node._latestEditorState = current;
  });
}

function unguardAll(): void {
  for (const restore of unguards.values()) restore();
  unguards.clear();
}

function requireNode(): Draft {
  const node = findDraftNode();
  if (!node) throw new Error('X 编辑器未就绪');
  guardLatest(node);
  return node;
}

function editorState(): Draft {
  const node = requireNode();
  return node._latestEditorState ?? node.props.editorState;
}

/** performance.now() of our latest editor change; X's autosave must start after it. */
let lastEdit = 0;
function commit(es: Draft): void {
  const node = requireNode();
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
  const fresh = () => [...listMedia(editorState().getCurrentContent())].find(([key]) => !before.has(key));
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
        seen = fresh()?.[0];
      }
      dropSeen();
      throw new Cancelled();
    }
    const [entityKey, info] = fresh() ?? [];
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
async function finalize(placed: Placed[], failed: Failed[], saves: ReturnType<typeof watchSaves>): Promise<boolean> {
  const tidy = (): boolean => {
    const edited = lastEdit;
    settle(placed, failed);
    cleanup();
    return lastEdit !== edited;
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let round = 0; round < 5 && (tidy() || round === 0); round++) await sleep(1000);
    const saved = await saves.savedAfter(lastEdit, SAVE_TIMEOUT_MS);
    await sleep(1000);
    if (tidy()) continue;
    // X sometimes sends an older upload-triggered save right next to its debounced one and the
    // older one can land last. One more lone save of the final content settles the server on it.
    const extra = appendEmptyBlock(editorState());
    commit(extra.editorState);
    await sleep(300);
    commit(removeBlock(editorState(), extra.key));
    return (await saves.savedAfter(lastEdit, SAVE_TIMEOUT_MS)) && saved;
  }
  return false;
}

export async function runWrite(req: MainWriteRequest, io: WriteIO): Promise<MainResult> {
  const result = emptyMainResult();
  let placed: (Placed & ImageMarker)[] = [];
  const failed: Failed[] = [];
  const saves = watchSaves();
  /** Counts only images still in the editor: X can drop one even after it was placed. */
  const audit = () => {
    const media = listMedia(editorState().getCurrentContent());
    for (const p of placed) if (!media.has(p.entityKey)) failed.push({ ...p, error: 'X 丢弃了已上传的图片' });
    placed = placed.filter((p) => media.has(p.entityKey));
  };
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
    const placeImage = async (m: ImageMarker, index: number): Promise<void> => {
      let error = '上传失败或超时';
      try {
        const done = await uploadImage(m, index, markers.length, io);
        if (done) {
          placed.push({ ...m, entityKey: done.entityKey });
          return;
        }
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        error = errorMessage(e);
      }
      const f = { ...m, error };
      failed.push(f);
      settle([], [f]);
    };
    for (const [i, m] of markers.entries()) await placeImage(m, i);

    if (req.coverImageId) {
      io.progress('cover', '设置封面');
      try {
        const cover = await setCover(toFile(await io.getImage(req.coverImageId)), () => checkCancel(io));
        result.coverSet = cover.ok;
        if (!cover.ok) result.warnings.push(cover.warning);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        result.warnings.push(`封面设置失败：${errorMessage(e)}`);
      }
    }

    io.progress('cleanup', '清理占位符');
    await settleAll(placed, failed);
    // Images X dropped after they were placed: upload once more where the placeholder came back.
    const content = editorState().getCurrentContent();
    const media = listMedia(content);
    const lost = placed.filter((p) => !media.has(p.entityKey) && findMarkerBlock(content, p.marker));
    placed = placed.filter((p) => !lost.includes(p));
    for (const p of lost) await placeImage(p, markers.findIndex((m) => m.marker === p.marker));
    io.progress('cleanup', '等待 X 自动保存');
    if (!(await finalize(placed, failed, saves))) result.warnings.push('未确认 X 已保存最终内容，请检查草稿');
    audit();
    if (hasMarkers(editorState().getCurrentContent())) result.warnings.push('仍有占位符残留');
    result.articleId = articleIdFromUrl(location.href) ?? result.articleId;
    return result;
  } catch (e) {
    try {
      if (findDraftNode()) {
        await finalize(placed, failed, saves);
        audit();
      }
    } catch (cleanupError) {
      result.warnings.push(`清理占位符失败：${errorMessage(cleanupError)}`);
    }
    result.error = e instanceof Cancelled ? 'cancelled' : errorMessage(e);
    return result;
  } finally {
    saves.stop();
    unguardAll();
    result.imagesOk = placed.length;
    result.imagesFailed = failed.map((f) => ({ imageId: f.imageId, error: f.error }));
  }
}
