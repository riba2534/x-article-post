// MAIN-world script on x.com (Draft.js access). Talks only to the content script over a
// MessageChannel; messages without the handshake token are ignored. Nothing is exposed globally.
import type { PreparedImage, WritePhase } from '../shared/types';
import { articleIdFromUrl, type EditorStatus, type MainCall, type FromMain } from '../content/protocol';
import { findDraftNode } from './dom';
import { installMainLink } from './link';
import { runWrite } from './write';

const IMAGE_TIMEOUT_MS = 60_000;

type Job = { cancelled: boolean; images: Map<string, { resolve(i: PreparedImage): void; reject(e: Error): void }> };
let job: Job | null = null;

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

async function call(c: MainCall, send: (msg: FromMain) => void): Promise<unknown> {
  if (c.method === 'state') return state();
  if (job) throw new Error('busy');
  const current: Job = (job = { cancelled: false, images: new Map() });
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

installMainLink(window, {
  call,
  cancel,
  image: (msg) => {
    const pending = job?.images.get(msg.imageId);
    if (!pending) return;
    if (msg.image) pending.resolve(msg.image);
    else pending.reject(new Error(msg.error || '图片数据缺失'));
  },
});
