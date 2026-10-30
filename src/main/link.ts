// MAIN-world side of the content-script channel. Only one instance answers per page: a newly
// injected main.js disposes the previous one (registered under a non-enumerable Symbol.for key,
// which is no API for the page: it can only switch our listener off, not call into it).
import { CONNECT_SOURCE, MAIN_READY_SOURCE, type FromMain, type MainCall, type ToMain } from '../content/protocol';
import { errorMessage } from '../content/util';

const DISPOSE = Symbol.for('xap.main.dispose');
export const BEAT_MS = 5000;

export interface MainHandlers {
  call(call: MainCall, send: (msg: FromMain) => void): Promise<unknown>;
  image(msg: Extract<ToMain, { kind: 'image' }>): void;
  cancel(): void;
}

type Host = Window & { [DISPOSE]?: () => void };

/** Starts answering connect requests on `win`; returns the dispose function. */
export function installMainLink(win: Window, handlers: MainHandlers): () => void {
  const host = win as Host;
  host[DISPOSE]?.();

  let port: MessagePort | null = null;
  let token = '';
  let running = 0;
  let beat: ReturnType<typeof setInterval> | undefined;
  const send = (msg: FromMain): void => port?.postMessage(msg);

  const onPortMessage = (ev: MessageEvent<ToMain>): void => {
    const msg = ev.data;
    if (!msg || msg.token !== token) return;
    if (msg.kind === 'cancel') return handlers.cancel();
    if (msg.kind === 'image') return handlers.image(msg);
    // Heartbeat while any call runs so the content script can tell slow from dead.
    if (running++ === 0) beat = setInterval(() => send({ kind: 'beat' }), BEAT_MS);
    handlers
      .call(msg.call, send)
      .then(
        (value) => send({ kind: 'reply', id: msg.id, ok: true, value }),
        (e: unknown) => send({ kind: 'reply', id: msg.id, ok: false, error: errorMessage(e) }),
      )
      .finally(() => {
        if (--running === 0) clearInterval(beat);
      });
  };

  const onWindowMessage = (ev: MessageEvent): void => {
    const d = ev.data;
    if (ev.source !== win || ev.origin !== win.location.origin || d?.source !== CONNECT_SOURCE || d.type !== 'connect') return;
    if (typeof d.token !== 'string' || d.token.length < 16 || !ev.ports[0]) return;
    // The newest content script wins (e.g. after an extension reload).
    port?.close();
    port = ev.ports[0];
    token = d.token;
    port.onmessage = onPortMessage;
    send({ kind: 'hello' });
  };

  const dispose = (): void => {
    win.removeEventListener('message', onWindowMessage);
    clearInterval(beat);
    handlers.cancel();
    port?.close();
    port = null;
    if (host[DISPOSE] === dispose) delete host[DISPOSE];
  };

  win.addEventListener('message', onWindowMessage);
  Object.defineProperty(host, DISPOSE, { value: dispose, configurable: true, enumerable: false });
  win.postMessage({ source: MAIN_READY_SOURCE, type: 'ready' }, win.location.origin);
  return dispose;
}
