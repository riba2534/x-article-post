// X Article page access from the MAIN world: Draft instance, upload handler, title, cover.
import type { Draft } from './draft';
import { PUBLISH_RE, sleep } from '../content/util';

interface Fiber {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  stateNode: Draft;
  memoizedProps: Draft;
}

function fiberOf(el: Element | null): Fiber | null {
  if (!el) return null;
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
}

export function findEditor(): HTMLElement | null {
  const els = [...document.querySelectorAll<HTMLElement>('[data-testid="composer"], .public-DraftEditor-content')];
  return els.find((el) => el.getBoundingClientRect().width > 200) ?? null;
}

/** The Draft.js `Editor` component instance (props.editorState / props.onChange). */
export function findDraftNode(): Draft | null {
  let fiber = fiberOf(findEditor());
  for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
    const props = fiber.stateNode?.props;
    if (props?.editorState && typeof props.onChange === 'function') return fiber.stateNode;
  }
  return null;
}

type FilesAdded = (files: File[]) => void;

function filesAddedIn(fiber: Fiber | null, depth: number): FilesAdded | null {
  for (; fiber; fiber = fiber.sibling) {
    if (typeof fiber.memoizedProps?.onFilesAdded === 'function') return fiber.memoizedProps.onFilesAdded;
    if (depth < 8) {
      const found = filesAddedIn(fiber.child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** X's `onFilesAdded(files)` prop, found up the tree from the editor (shallow children included). */
export function findOnFilesAdded(): FilesAdded | null {
  let fiber = fiberOf(findEditor());
  for (let depth = 0; fiber && depth < 160; depth++, fiber = fiber.return) {
    const own = fiber.memoizedProps?.onFilesAdded;
    if (typeof own === 'function') return own;
    const nested = filesAddedIn(fiber.child, 0);
    if (nested) return nested;
  }
  return null;
}

const TITLE_WORDS = ['title', '标题', '標題', 'タイトル', '제목', 'titre', 'titel', 'título', 'titolo', 'заголовок'];

export function findTitleField(): HTMLTextAreaElement | null {
  const areas = [...document.querySelectorAll('textarea')].filter((t) => t.getBoundingClientRect().width > 0);
  const labelled = areas.find((t) => {
    const hay = `${t.placeholder} ${t.getAttribute('aria-label') ?? ''} ${t.name}`.toLowerCase();
    return TITLE_WORDS.some((w) => hay.includes(w));
  });
  if (labelled) return labelled;
  const editor = findEditor();
  // Fallback: the last textarea placed before the composer.
  return editor ? (areas.filter((t) => t.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).pop() ?? null) : null;
}

export async function setTitle(title: string): Promise<boolean> {
  const field = findTitleField();
  if (!field) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(field, title);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  return findTitleField()?.value === title;
}

const precedes = (a: Node, b: Node): boolean => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Cover file input: the last image file input placed before the title field. */
function findCoverInput(): HTMLInputElement | null {
  const anchor = findTitleField() ?? findEditor();
  if (!anchor) return null;
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')]
    .filter((i) => precedes(i, anchor) && (!i.accept || /image/.test(i.accept)));
  return inputs.pop() ?? null;
}

/** Uploaded cover images shown above the title (X renders `original_img_url`). */
function coverImages(): string[] {
  const anchor = findTitleField();
  if (!anchor) return [];
  return [...document.querySelectorAll('img')]
    .filter((img) => precedes(img, anchor) && /pbs\.twimg\.com\/media\//.test(img.src))
    .map((img) => img.src);
}

const DONE_LABELS = ['应用', '套用', '完成', '保存', 'apply', 'done', 'save', '適用', '保存する', '완료', '적용'];

/** Confirms X's cover crop dialog: a labelled confirm button, else the dialog's own onDone prop. */
function confirmCoverDialog(): boolean {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  if (!dialog) return false;
  for (const button of dialog.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    const label = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.trim().toLowerCase();
    if (!label || PUBLISH_RE.test(label) || button.matches(':disabled, [aria-disabled="true"]')) continue;
    if (button.getAttribute('data-testid') === 'applyButton' || DONE_LABELS.some((w) => label === w || label.split(/\s+/).includes(w))) {
      button.click();
      return true;
    }
  }
  let fiber = fiberOf(dialog.querySelector('*') ?? dialog);
  for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
    const p = fiber.memoizedProps;
    if (typeof p?.onDone === 'function' && typeof p?.onCancel === 'function' && p.media) {
      p.onDone();
      return true;
    }
  }
  return false;
}

export type CoverOutcome = { ok: true } | { ok: false; warning: string };

/** Uploads the cover through X's own cover picker (no GraphQL). */
export async function setCover(file: File, checkCancel: () => void, timeoutMs = 120_000): Promise<CoverOutcome> {
  const input = findCoverInput();
  if (!input) return { ok: false, warning: '未找到封面上传入口，封面未设置' };
  const before = new Set(coverImages());
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const deadline = Date.now() + timeoutMs;
  for (let tick = 0; Date.now() < deadline; tick++) {
    checkCancel();
    await sleep(500);
    // The crop dialog may ignore an early click while the image loads: retry every 2 s.
    if (tick % 4 === 1) confirmCoverDialog();
    if (!document.querySelector('[role="dialog"]') && coverImages().some((src) => !before.has(src))) return { ok: true };
  }
  return { ok: false, warning: '封面上传超时' };
}

// X autosaves body edits with its own ArticleEntityUpdateContent request, debounced ~3 s after
// the last change. Upload completions also send immediate saves carrying an older state, so only
// a save that starts after the debounce window proves the latest edit was sent. We only observe
// resource timings (read-only).
const SAVE_DEBOUNCE_MS = 2500;

/** Observes X's content saves while a write runs. */
export function watchSaves(): { savedAfter(since: number, timeoutMs: number): Promise<boolean>; stop(): void } {
  let latest = -Infinity;
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (/\/graphql\/[^/]+\/ArticleEntityUpdateContent\b/.test(e.name)) latest = Math.max(latest, e.startTime);
    }
  });
  observer.observe({ type: 'resource' });
  return {
    /** True once X's debounced save for an edit made at `since` (performance.now()) completed. */
    async savedAfter(since, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (latest >= since + SAVE_DEBOUNCE_MS) return true;
        await sleep(250);
      }
      return false;
    },
    stop: () => observer.disconnect(),
  };
}
