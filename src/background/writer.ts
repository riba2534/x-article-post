// Background side of the writer: picks/opens the X tab and drives the content script over a port.
// It only ever creates or edits drafts; nothing here can publish.
import { dropImages, loadImage } from '../shared/image-store';
import type { ExtensionStatus, RuntimeMessage, WriteProgress, WriteRequest, WriteResult } from '../shared/types';
import { WRITE_PORT, articleIdFromUrl, editUrl, type EditorStatus, type MainResult, type PortDown, type PortUp } from '../content/protocol';
import { emptyMainResult, errorMessage } from '../content/util';
import { findStatusTab, prepareTab, sendToTab } from './writer/tabs';

/** No message from the page for this long means the tab died or got stuck. */
const IDLE_TIMEOUT_MS = 180_000;

type BridgeStatus = ExtensionStatus['bridge'];
let bridgeStatus: () => BridgeStatus = () => ({ enabled: false, connected: false, url: '' });

/** Lets the bridge area report its connection state in `xap:status`. */
export function setBridgeStatusProvider(fn: () => BridgeStatus): void {
  bridgeStatus = fn;
}

interface Run {
  runId: string;
  cancelled: boolean;
  port?: chrome.runtime.Port;
}

let active: Run | null = null;

export function isBusy(): boolean {
  return active !== null;
}

const broadcast = (msg: RuntimeMessage): void => {
  chrome.runtime.sendMessage(msg).catch(() => {});
};

const emptyResult = (runId: string, error?: string): WriteResult => ({ ...emptyMainResult(error), ok: false, runId });

export async function getXTabStatus(): Promise<ExtensionStatus['xTab']> {
  const tab = await findStatusTab();
  if (tab?.id === undefined || !tab.url) return null;
  const s = await sendToTab<EditorStatus>(tab.id, { type: 'xap:c:state' }).catch(() => null);
  return { tabId: tab.id, url: tab.url, articleId: s?.articleId ?? articleIdFromUrl(tab.url), editorReady: s?.editorReady ?? false };
}

/** Streams one write through the content script; images are sent one at a time on request. */
function drive(tabId: number, request: WriteRequest, articleId: string, run: Run, onProgress: (p: WriteProgress) => void): Promise<MainResult> {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: WRITE_PORT });
    run.port = port;
    let idle: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void) => {
      clearTimeout(idle);
      run.port = undefined;
      fn();
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(() => {
        port.disconnect();
        reject(new Error('X 页面长时间无响应'));
      }), IDLE_TIMEOUT_MS);
    };
    const post = (msg: PortDown) => port.postMessage(msg);
    port.onDisconnect.addListener(() => finish(() => reject(new Error(chrome.runtime.lastError?.message || 'X 页面连接已断开'))));
    port.onMessage.addListener((msg: PortUp) => {
      touch();
      if (msg.type === 'progress') onProgress(msg.progress);
      else if (msg.type === 'need-image') {
        const stashed = request.images[msg.imageId];
        void (stashed ? loadImage(request.runId, stashed) : Promise.resolve(undefined))
          .catch(() => undefined)
          .then((image) => post(image ? { type: 'image', imageId: msg.imageId, image } : { type: 'image', imageId: msg.imageId, error: '图片未准备好' }));
      } else if (msg.type === 'result') {
        finish(() => {
          port.disconnect();
          resolve(msg.result);
        });
      }
    });
    touch();
    const { runId, title, blocks, coverImageId, target } = request;
    post({
      type: 'start',
      request: { runId, title, blocks, coverImageId, mode: target.type === 'existing' ? target.mode : 'replace', articleId },
    });
  });
}

export async function runWrite(request: WriteRequest, onProgress: (p: WriteProgress) => void): Promise<WriteResult> {
  if (active) return emptyResult(request.runId, 'busy');
  const run: Run = { runId: request.runId, cancelled: false };
  active = run;
  const progress = (p: WriteProgress) => {
    onProgress(p);
    broadcast({ type: 'xap:progress', progress: p });
  };
  const check = () => {
    if (run.cancelled) throw new Error('cancelled');
  };
  let result: WriteResult;
  try {
    progress({ runId: request.runId, phase: 'tab', message: '打开 X 草稿' });
    const { tabId, articleId } = await prepareTab(request.target, check);
    check();
    const r = await drive(tabId, request, articleId, run, progress);
    const id = r.articleId ?? articleId;
    result = {
      ...r,
      ok: !r.error,
      runId: request.runId,
      articleId: id,
      url: editUrl(id),
    };
  } catch (e) {
    result = emptyResult(request.runId, run.cancelled ? 'cancelled' : errorMessage(e));
  } finally {
    active = null;
    void dropImages(request.runId).catch(() => undefined);
  }
  progress({ runId: request.runId, phase: result.ok ? 'done' : 'error', message: result.ok ? '草稿已写入' : result.error ?? '写入失败' });
  broadcast({ type: 'xap:result', result });
  return result;
}

function cancel(runId: string): boolean {
  if (!active || active.runId !== runId) return false;
  active.cancelled = true;
  active.port?.postMessage({ type: 'cancel' } satisfies PortDown);
  return true;
}

export function initWriter(): void {
  chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
    // Only extension pages talk to the writer; content scripts in web pages do not.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    switch (msg?.type) {
      case 'xap:write':
        runWrite(msg.request, () => {}).then(sendResponse);
        return true;
      case 'xap:cancel':
        sendResponse({ ok: cancel(msg.runId) });
        return false;
      case 'xap:status':
        getXTabStatus()
          .catch(() => null)
          .then((xTab) => sendResponse({ version: chrome.runtime.getManifest().version, bridge: bridgeStatus(), xTab, busy: isBusy() } satisfies ExtensionStatus));
        return true;
      default:
        return false;
    }
  });
}
