// Isolated-world content script on x.com: relays background <-> MAIN and creates new drafts.
import {
  CONNECT_SOURCE,
  MAIN_READY_SOURCE,
  WRITE_PORT,
  articleIdFromUrl,
  type ContentRequest,
  type EditorStatus,
  type FromMain,
  type MainCall,
  type MainResult,
  type NewDraftResponse,
  type PortDown,
  type PortUp,
} from './protocol';
import { clickCreate } from './page';
import { emptyMainResult, errorMessage, sleep } from './util';

type Pending = { resolve(v: unknown): void; reject(e: Error): void };

const g = globalThis as { __xapContent?: boolean };

if (!g.__xapContent) {
  g.__xapContent = true;

  let main: { port: MessagePort; token: string } | null = null;
  let connecting: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let writePort: chrome.runtime.Port | null = null;

  const randomToken = (): string => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

  function onMain(ev: MessageEvent<FromMain>): void {
    const msg = ev.data;
    if (msg.kind === 'reply') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.value);
      else p?.reject(new Error(msg.error));
    } else if (msg.kind === 'progress' || msg.kind === 'need-image') {
      const up: PortUp = msg.kind === 'progress' ? { type: 'progress', progress: msg.progress } : { type: 'need-image', imageId: msg.imageId };
      writePort?.postMessage(up);
    }
  }

  /** Hands MAIN a fresh MessageChannel + token; resolves once MAIN says hello. */
  function connect(): Promise<void> {
    connecting ??= (async () => {
      for (let attempt = 0; attempt < 25; attempt++) {
        const channel = new MessageChannel();
        const token = randomToken();
        const hello = new Promise<boolean>((resolve) => {
          channel.port1.onmessage = (ev: MessageEvent<FromMain>) => {
            if (ev.data?.kind !== 'hello') return;
            channel.port1.onmessage = onMain;
            resolve(true);
          };
          setTimeout(() => resolve(false), 400);
        });
        window.postMessage({ source: CONNECT_SOURCE, type: 'connect', token }, location.origin, [channel.port2]);
        if (await hello) {
          main?.port.close();
          main = { port: channel.port1, token };
          return;
        }
        channel.port1.close();
      }
      throw new Error('页面脚本未就绪');
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function callMain(call: MainCall, timeoutMs?: number): Promise<unknown> {
    if (!main) await connect();
    const id = nextId++;
    const m = main!;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (timeoutMs) {
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error('页面脚本无响应'));
        }, timeoutMs);
      }
      m.port.postMessage({ token: m.token, kind: 'call', id, call });
    });
  }

  function toMain(msg: { kind: 'image'; imageId: string; image?: unknown; error?: string } | { kind: 'cancel' }): void {
    if (main) main.port.postMessage({ ...msg, token: main.token });
  }

  async function status(): Promise<EditorStatus> {
    try {
      return (await callMain({ method: 'state' }, 3000)) as EditorStatus;
    } catch {
      return { url: location.href, articleId: articleIdFromUrl(location.href), editorReady: false };
    }
  }

  async function newDraft(): Promise<NewDraftResponse> {
    try {
      await clickCreate();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const s = await status();
        if (s.articleId && s.editorReady) return { ok: true, articleId: s.articleId };
        await sleep(300);
      }
      return { ok: false, error: '新建草稿后编辑器未就绪' };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    // MAIN (re)loaded after us: reconnect so the newest MAIN holds our channel.
    if (ev.source === window && ev.data?.source === MAIN_READY_SOURCE) connect().catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    if (msg?.type === 'xap:c:ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'xap:c:state') {
      status().then(sendResponse);
      return true;
    }
    if (msg?.type === 'xap:c:new-draft') {
      newDraft().then(sendResponse);
      return true;
    }
    return false;
  });

  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== WRITE_PORT) return;
    writePort?.disconnect();
    writePort = p;
    p.onDisconnect.addListener(() => {
      if (writePort === p) writePort = null;
      toMain({ kind: 'cancel' });
    });
    p.onMessage.addListener((msg: PortDown) => {
      if (msg.type === 'cancel') return toMain({ kind: 'cancel' });
      if (msg.type === 'image') return toMain({ kind: 'image', imageId: msg.imageId, image: msg.image, error: msg.error });
      callMain({ method: 'write', request: msg.request })
        .then((value) => value as MainResult)
        .catch((e: unknown) => emptyMainResult(errorMessage(e)))
        .then((result) => {
          if (writePort === p) p.postMessage({ type: 'result', result } satisfies PortUp);
        });
    });
  });

  connect().catch(() => {});
}
