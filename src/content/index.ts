// Isolated-world content script on x.com: relays background <-> MAIN and creates new drafts.
import {
  CONNECT_SOURCE,
  MAIN_READY_SOURCE,
  WRITE_PORT,
  articleIdFromUrl,
  type ContentRequest,
  type EditorStatus,
  type FromMain,
  type MainResult,
  type NewDraftResponse,
  type PortDown,
  type PortUp,
} from './protocol';
import { MainLink } from './main-link';
import { clickCreate } from './page';
import { emptyMainResult, errorMessage, sleep } from './util';

const g = globalThis as { __xapContent?: boolean };

if (!g.__xapContent) {
  g.__xapContent = true;

  let main: MainLink | null = null;
  let connecting: Promise<MainLink> | null = null;
  let writePort: chrome.runtime.Port | null = null;

  const randomToken = (): string => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

  function onMainEvent(msg: FromMain): void {
    if (msg.kind === 'progress') writePort?.postMessage({ type: 'progress', progress: msg.progress } satisfies PortUp);
    else if (msg.kind === 'need-image') writePort?.postMessage({ type: 'need-image', imageId: msg.imageId } satisfies PortUp);
  }

  /** Hands MAIN a fresh MessageChannel + token; resolves once MAIN says hello. */
  function connect(): Promise<MainLink> {
    connecting ??= (async () => {
      for (let attempt = 0; attempt < 25; attempt++) {
        const channel = new MessageChannel();
        const token = randomToken();
        const hello = new Promise<boolean>((resolve) => {
          channel.port1.onmessage = (ev: MessageEvent<FromMain>) => {
            if (ev.data?.kind === 'hello') resolve(true);
          };
          setTimeout(() => resolve(false), 400);
        });
        window.postMessage({ source: CONNECT_SOURCE, type: 'connect', token }, location.origin, [channel.port2]);
        if (await hello) {
          // Calls on the old channel can never be answered now: fail them instead of hanging.
          main?.close('页面脚本已重新连接');
          main = new MainLink(channel.port1, token, onMainEvent);
          return main;
        }
        channel.port1.close();
      }
      throw new Error('页面脚本未就绪');
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  const link = async (): Promise<MainLink> => main ?? connect();

  async function status(): Promise<EditorStatus> {
    try {
      return (await (await link()).call({ method: 'state' })) as EditorStatus;
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
      main?.post({ kind: 'cancel' });
    });
    p.onMessage.addListener((msg: PortDown) => {
      if (msg.type === 'cancel') return main?.post({ kind: 'cancel' });
      if (msg.type === 'image') return main?.post({ kind: 'image', imageId: msg.imageId, image: msg.image, error: msg.error });
      link()
        .then((m) => m.call({ method: 'write', request: msg.request }, true))
        .then((value) => value as MainResult)
        .catch((e: unknown) => emptyMainResult(errorMessage(e)))
        .then((result) => {
          if (writePort === p) p.postMessage({ type: 'result', result } satisfies PortUp);
        });
    });
  });

  connect().catch(() => {});
}
