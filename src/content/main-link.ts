// Content-script side of the MessageChannel to the MAIN-world script. Every call ends: it
// resolves with MAIN's reply, or rejects on timeout (short calls), on missing heartbeats
// (long calls such as 'write'), or when the channel is replaced or closed.
import type { FromMain, MainCall } from './protocol';

/** Time a short call ('state', ...) may take. */
export const CALL_TIMEOUT_MS = 10_000;
/** A long call fails when MAIN sends nothing (beat/progress/reply) for this long. */
export const SILENCE_TIMEOUT_MS = 30_000;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** Long calls re-arm their timer on every message from MAIN. */
  long: boolean;
}

export class MainLink {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly port: MessagePort,
    private readonly token: string,
    /** Progress / need-image events, forwarded to the background. */
    private readonly onEvent: (msg: FromMain) => void,
  ) {
    port.onmessage = (ev: MessageEvent<FromMain>) => this.receive(ev.data);
  }

  call(call: MainCall, long = false): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, long, timer: setTimeout(() => {}, 0) };
      this.pending.set(id, p);
      this.arm(id, p);
      this.port.postMessage({ token: this.token, kind: 'call', id, call });
    });
  }

  /** Fire-and-forget messages (image data, cancel). */
  post(msg: { kind: 'image'; imageId: string; image?: unknown; error?: string } | { kind: 'cancel' }): void {
    this.port.postMessage({ ...msg, token: this.token });
  }

  /** Rejects every outstanding call and closes the channel. */
  close(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.port.onmessage = null;
    this.port.close();
  }

  get size(): number {
    return this.pending.size;
  }

  private arm(id: number, p: Pending): void {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (this.pending.delete(id)) p.reject(new Error('页面脚本无响应'));
    }, p.long ? SILENCE_TIMEOUT_MS : CALL_TIMEOUT_MS);
  }

  private receive(msg: FromMain): void {
    if (!msg) return;
    // Any sign of life keeps long calls going.
    for (const [id, p] of this.pending) if (p.long) this.arm(id, p);
    if (msg.kind === 'reply') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    } else if (msg.kind === 'progress' || msg.kind === 'need-image') {
      this.onEvent(msg);
    }
  }
}
