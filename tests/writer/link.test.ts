import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_TIMEOUT_MS, MainLink, SILENCE_TIMEOUT_MS } from '../../src/content/main-link';
import { BEAT_MS, installMainLink, type MainHandlers } from '../../src/main/link';
import { CONNECT_SOURCE, MAIN_READY_SOURCE, type FromMain } from '../../src/content/protocol';

/** Minimal MessagePort stand-in: records what was posted, lets the test deliver messages. */
class FakePort {
  sent: unknown[] = [];
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(msg: unknown): void {
    this.sent.push(msg);
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const asPort = (p: FakePort) => p as unknown as MessagePort;
const lastCallId = (p: FakePort) => (p.sent.at(-1) as { id: number }).id;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MainLink (content side)', () => {
  it('resolves with the reply and tags calls with the token', async () => {
    const port = new FakePort();
    const link = new MainLink(asPort(port), 'tok', () => {});
    const p = link.call({ method: 'state' });
    expect(port.sent[0]).toEqual({ token: 'tok', kind: 'call', id: 1, call: { method: 'state' } });
    port.deliver({ kind: 'reply', id: 1, ok: true, value: 42 });
    await expect(p).resolves.toBe(42);
    expect(link.size).toBe(0);
  });

  it('rejects with the error MAIN reports', async () => {
    const port = new FakePort();
    const link = new MainLink(asPort(port), 'tok', () => {});
    const p = link.call({ method: 'state' });
    port.deliver({ kind: 'reply', id: lastCallId(port), ok: false, error: 'busy' });
    await expect(p).rejects.toThrow('busy');
  });

  it('times out short calls', async () => {
    const link = new MainLink(asPort(new FakePort()), 'tok', () => {});
    const p = link.call({ method: 'state' });
    const check = expect(p).rejects.toThrow('页面脚本无响应');
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + 1);
    await check;
    expect(link.size).toBe(0);
  });

  it('keeps long calls alive while MAIN sends heartbeats, fails them after silence', async () => {
    const port = new FakePort();
    const events: FromMain[] = [];
    const link = new MainLink(asPort(port), 'tok', (m) => events.push(m));
    const p = link.call({ method: 'state' }, true);
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1000);
      port.deliver({ kind: 'beat' });
    }
    port.deliver({ kind: 'progress', progress: { runId: 'r', phase: 'text', message: 'm' } });
    expect(settled).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['progress']);
    const check = expect(p).rejects.toThrow('页面脚本无响应');
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS + 1);
    await check;
  });

  it('close() rejects every pending call (reconnect must not leave a write hanging)', async () => {
    const port = new FakePort();
    const link = new MainLink(asPort(port), 'tok', () => {});
    const write = link.call({ method: 'state' }, true);
    const state = link.call({ method: 'state' });
    link.close('页面脚本已重新连接');
    await expect(write).rejects.toThrow('页面脚本已重新连接');
    await expect(state).rejects.toThrow('页面脚本已重新连接');
    expect(link.size).toBe(0);
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();
  });

  it('ignores replies to unknown ids and forwards need-image', () => {
    const port = new FakePort();
    const events: FromMain[] = [];
    new MainLink(asPort(port), 'tok', (m) => events.push(m));
    port.deliver({ kind: 'reply', id: 99, ok: true, value: 1 });
    port.deliver({ kind: 'need-image', imageId: 'a' });
    expect(events).toEqual([{ kind: 'need-image', imageId: 'a' }]);
  });

  it('post() adds the token', () => {
    const port = new FakePort();
    new MainLink(asPort(port), 'tok', () => {}).post({ kind: 'cancel' });
    expect(port.sent).toEqual([{ kind: 'cancel', token: 'tok' }]);
  });
});

/** A window stand-in with just what installMainLink uses. */
interface FakeWindow {
  location: { origin: string };
  posted: unknown[];
  postMessage(msg: unknown): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  connect(token: string, port: FakePort, origin?: string, source?: unknown): void;
  listeners: Set<(ev: unknown) => void>;
}

function fakeWindow(): FakeWindow {
  const listeners = new Set<(ev: unknown) => void>();
  const win: FakeWindow = {
    location: { origin: 'https://x.com' },
    posted: [] as unknown[],
    postMessage(msg) {
      win.posted.push(msg);
    },
    addEventListener: (_: string, fn: (ev: unknown) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (ev: unknown) => void) => listeners.delete(fn),
    connect(token, port, origin = 'https://x.com', source: unknown = win) {
      for (const fn of [...listeners]) fn({ source, origin, data: { source: CONNECT_SOURCE, type: 'connect', token }, ports: [port] });
    },
    listeners,
  };
  return win;
}

function handlers(overrides: Partial<MainHandlers> = {}): MainHandlers & { cancels: number } {
  const h = {
    cancels: 0,
    call: vi.fn(async () => 'value'),
    image: vi.fn(),
    cancel: () => {
      h.cancels++;
    },
    ...overrides,
  };
  return h;
}

const TOKEN = 'a'.repeat(32);
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('installMainLink (MAIN side)', () => {
  it('announces itself, answers connect with hello and replies to calls', async () => {
    const win = fakeWindow();
    const h = handlers();
    installMainLink(win as unknown as Window, h);
    expect(win.posted).toEqual([{ source: MAIN_READY_SOURCE, type: 'ready' }]);
    const port = new FakePort();
    win.connect(TOKEN, port);
    expect(port.sent).toEqual([{ kind: 'hello' }]);
    port.deliver({ token: TOKEN, kind: 'call', id: 7, call: { method: 'state' } });
    await flush();
    expect(port.sent.at(-1)).toEqual({ kind: 'reply', id: 7, ok: true, value: 'value' });
  });

  it('ignores wrong tokens, short tokens, foreign origins and other sources', async () => {
    const win = fakeWindow();
    const h = handlers();
    installMainLink(win as unknown as Window, h);
    const short = new FakePort();
    win.connect('short', short);
    const foreign = new FakePort();
    win.connect(TOKEN, foreign, 'https://evil.example');
    const other = new FakePort();
    win.connect(TOKEN, other, 'https://x.com', {});
    expect([short.sent, foreign.sent, other.sent]).toEqual([[], [], []]);
    const port = new FakePort();
    win.connect(TOKEN, port);
    port.deliver({ token: 'wrong', kind: 'call', id: 1, call: { method: 'state' } });
    port.deliver({ token: 'wrong', kind: 'cancel' });
    await flush();
    expect(h.call).not.toHaveBeenCalled();
    expect(h.cancels).toBe(0);
  });

  it('sends heartbeats only while a call runs', async () => {
    const win = fakeWindow();
    let finish!: (v: unknown) => void;
    installMainLink(win as unknown as Window, handlers({ call: () => new Promise((r) => (finish = r)) }));
    const port = new FakePort();
    win.connect(TOKEN, port);
    port.deliver({ token: TOKEN, kind: 'call', id: 1, call: { method: 'state' } });
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3 + 1);
    expect(port.sent.filter((m) => (m as FromMain).kind === 'beat')).toHaveLength(3);
    finish('done');
    await flush();
    const before = port.sent.length;
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    expect(port.sent.length).toBe(before);
  });

  it('routes image and cancel messages', () => {
    const win = fakeWindow();
    const h = handlers();
    installMainLink(win as unknown as Window, h);
    const port = new FakePort();
    win.connect(TOKEN, port);
    port.deliver({ token: TOKEN, kind: 'image', imageId: 'i', error: 'x' });
    port.deliver({ token: TOKEN, kind: 'cancel' });
    expect(h.image).toHaveBeenCalledWith({ token: TOKEN, kind: 'image', imageId: 'i', error: 'x' });
    expect(h.cancels).toBe(1);
  });

  it('a re-injected instance takes over: the old one stops answering and cancels its job', async () => {
    const win = fakeWindow();
    const oldH = handlers();
    installMainLink(win as unknown as Window, oldH);
    const oldPort = new FakePort();
    win.connect(TOKEN, oldPort);

    const newH = handlers();
    installMainLink(win as unknown as Window, newH);
    expect(oldH.cancels).toBe(1);
    expect(oldPort.closed).toBe(true);
    expect(win.listeners.size).toBe(1);
    expect(Object.keys(win)).not.toContain(Symbol.for('xap.main.dispose').toString());

    const port = new FakePort();
    win.connect(TOKEN, port);
    expect(port.sent).toEqual([{ kind: 'hello' }]);
    port.deliver({ token: TOKEN, kind: 'call', id: 1, call: { method: 'state' } });
    await flush();
    expect(oldH.call).not.toHaveBeenCalled();
    expect(newH.call).toHaveBeenCalledTimes(1);
  });

  it('dispose() detaches and unregisters itself', () => {
    const win = fakeWindow();
    const dispose = installMainLink(win as unknown as Window, handlers());
    dispose();
    expect(win.listeners.size).toBe(0);
    expect(Symbol.for('xap.main.dispose') in win).toBe(false);
  });
});
