// MAIN-world script on x.com (Draft.js access). Talks only to the content script over a
// MessageChannel; messages without the handshake token are ignored. Nothing is exposed globally.
import type { PreparedImage, WritePhase } from '../shared/types';
import { CONNECT_SOURCE, MAIN_READY_SOURCE, articleIdFromUrl, type EditorStatus, type FromMain, type MainCall, type ToMain } from '../content/protocol';
import { findDraftNode } from './dom';
import { runWrite } from './write';
import { errorMessage } from '../content/util';

const IMAGE_TIMEOUT_MS = 60_000;

let port: MessagePort | null = null;
let token = '';
let job: { cancelled: boolean; images: Map<string, { resolve(i: PreparedImage): void; reject(e: Error): void }> } | null = null;

const send = (msg: FromMain): void => port?.postMessage(msg);

function state(): EditorStatus {
  return {
    url: location.href,
    articleId: articleIdFromUrl(location.href),
    editorReady: Boolean(findDraftNode()),
  };
}

function cancel(): void {
  if (!job) return;
  job.cancelled = true;
  for (const p of job.images.values()) p.reject(new Error('cancelled'));
  job.images.clear();
}

async function call(c: MainCall): Promise<unknown> {
  if (c.method === 'state') return state();
  if (job) throw new Error('busy');
  const current = (job = { cancelled: false, images: new Map() });
  try {
    return await runWrite(c.request, {
      isCancelled: () => current.cancelled,
      progress: (phase: WritePhase, message: string, cur?: number, total?: number) =>
        send({ kind: 'progress', progress: { runId: c.request.runId, phase, message, current: cur, total } }),
      getImage: (imageId) =>
        new Promise<PreparedImage>((resolve, reject) => {
          if (current.cancelled) return reject(new Error('cancelled'));
          const timer = setTimeout(() => {
            current.images.delete(imageId);
            reject(new Error('图片数据获取超时'));
          }, IMAGE_TIMEOUT_MS);
          const done = <T,>(fn: (v: T) => void) => (v: T) => {
            clearTimeout(timer);
            current.images.delete(imageId);
            fn(v);
          };
          current.images.set(imageId, { resolve: done(resolve), reject: done(reject) });
          send({ kind: 'need-image', imageId });
        }),
    });
  } finally {
    job = null;
  }
}

function onPortMessage(ev: MessageEvent<ToMain>): void {
  const msg = ev.data;
  if (!msg || msg.token !== token) return;
  if (msg.kind === 'cancel') return cancel();
  if (msg.kind === 'image') {
    const pending = job?.images.get(msg.imageId);
    if (!pending) return;
    if (msg.image) pending.resolve(msg.image);
    else pending.reject(new Error(msg.error || '图片数据缺失'));
    return;
  }
  call(msg.call).then(
    (value) => send({ kind: 'reply', id: msg.id, ok: true, value }),
    (e: unknown) => send({ kind: 'reply', id: msg.id, ok: false, error: errorMessage(e) }),
  );
}

window.addEventListener('message', (ev: MessageEvent) => {
  const d = ev.data;
  if (ev.source !== window || ev.origin !== location.origin || d?.source !== CONNECT_SOURCE || d.type !== 'connect') return;
  if (typeof d.token !== 'string' || d.token.length < 16 || !ev.ports[0]) return;
  // The newest content script wins (e.g. after an extension reload).
  port?.close();
  port = ev.ports[0];
  token = d.token;
  port.onmessage = onPortMessage;
  send({ kind: 'hello' });
});

window.postMessage({ source: MAIN_READY_SOURCE, type: 'ready' }, location.origin);
