// X tab handling for the writer: find/open, focus, content-script readiness.
import { articleIdFromUrl, type ContentRequest, type EditorStatus, type NewDraftResponse } from '../../content/protocol';

export const ARTICLES_URL = 'https://x.com/compose/articles';
export const editUrl = (id: string): string => `${ARTICLES_URL}/edit/${id}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const X_HOST = /^https:\/\/(x|twitter)\.com\//;
const LIST_PAGE = /^https:\/\/(x|twitter)\.com\/compose\/articles\/?(\?.*)?$/;

export function sendToTab<T>(tabId: number, msg: ContentRequest): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}

async function windowTabs(): Promise<chrome.tabs.Tab[]> {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  return chrome.tabs.query(win?.id !== undefined ? { windowId: win.id } : {});
}

async function waitComplete(tabId: number, timeoutMs = 30_000): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url && X_HOST.test(tab.url)) return tab;
    if (Date.now() > deadline) throw new Error('X 页面加载超时');
    await sleep(250);
  }
}

/** Activates the tab and focuses its window: X does not render the editor in background tabs. */
export async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

/** Reuses an Articles list tab (never someone's open draft) or opens one in the current window. */
async function openList(): Promise<number> {
  const reuse = (await windowTabs()).find((t) => t.id !== undefined && t.url && LIST_PAGE.test(t.url));
  if (reuse?.id !== undefined) return reuse.id;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const tab = await chrome.tabs.create({ url: ARTICLES_URL, active: true, windowId: win?.id });
  return tab.id!;
}

async function openDraft(articleId: string): Promise<number> {
  const all = await chrome.tabs.query({ url: ['https://x.com/compose/articles/edit/*', 'https://twitter.com/compose/articles/edit/*'] });
  const open = all.find((t) => t.url && articleIdFromUrl(t.url) === articleId);
  if (open?.id !== undefined) return open.id;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const tab = await chrome.tabs.create({ url: editUrl(articleId), active: true, windowId: win?.id });
  return tab.id!;
}

/** Makes sure content.js (and MAIN main.js) answer in the tab, injecting them if needed. */
export async function ensureContent(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendToTab(tabId, { type: 'xap:c:ping' });
      return;
    } catch {
      if (attempt === 0) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['main.js'], world: 'MAIN' }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
      }
      await sleep(500);
    }
  }
  throw new Error('无法连接 X 页面脚本');
}

async function waitEditor(tabId: number, timeoutMs: number, check?: () => void): Promise<EditorStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    check?.();
    const s = await sendToTab<EditorStatus>(tabId, { type: 'xap:c:state' }).catch(() => null);
    if (s?.editorReady) return s;
    if (Date.now() > deadline) throw new Error('X 编辑器未就绪（请保持 X 标签页在前台）');
    await sleep(500);
  }
}

/** Opens the target draft (creating one for 'new') and returns its tab id and article id. */
export async function prepareTab(target: { type: 'new' } | { type: 'existing'; articleId: string }, check: () => void): Promise<{ tabId: number; articleId: string }> {
  const tabId = target.type === 'new' ? await openList() : await openDraft(target.articleId);
  await focusTab(tabId);
  await waitComplete(tabId);
  check();
  await ensureContent(tabId);
  if (target.type === 'existing') {
    const s = await waitEditor(tabId, 30_000, check);
    if (s.articleId !== target.articleId) throw new Error(`目标草稿 ${target.articleId} 未打开`);
    return { tabId, articleId: target.articleId };
  }
  const created = await sendToTab<NewDraftResponse>(tabId, { type: 'xap:c:new-draft' });
  if (!created.ok) throw new Error(created.error);
  check();
  await focusTab(tabId);
  return { tabId, articleId: created.articleId };
}

/** The X tab most relevant for status: active X tab, else any open draft editor, else any X compose tab. */
export async function findStatusTab(): Promise<chrome.tabs.Tab | undefined> {
  const active = (await windowTabs()).find((t) => t.active && t.url && X_HOST.test(t.url));
  if (active) return active;
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  return tabs.find((t) => t.url && articleIdFromUrl(t.url)) ?? tabs.find((t) => t.url?.includes('/compose/articles'));
}
