import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_MAX_MS, createBridgeConnection, type SocketLike } from '../../src/background/bridge/connection';
import { BRIDGE_PROTOCOL_VERSION, type BridgeCommand } from '../../src/shared/types';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closedWith: number | undefined;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const URL = 'ws://127.0.0.1:17345/ext';
const on = { enabled: true, url: URL, token: 'tok' };

function setup() {
  const onCommand = vi.fn();
  const conn = createBridgeConnection({ version: '1.0.0', createSocket: (url) => new FakeSocket(url), onCommand });
  return { conn, onCommand, latest: () => FakeSocket.all.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe('bridge connection', () => {
  it('does nothing while disabled or without a token', () => {
    const { conn } = setup();
    conn.configure({ enabled: false, url: URL, token: 'tok' });
    conn.configure({ enabled: true, url: URL, token: '' });
    conn.ensure();
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('sends hello on open and becomes connected after welcome', () => {
    const { conn, latest } = setup();
    conn.configure(on);
    latest().open();
    expect(latest().sent[0]).toEqual({ type: 'hello', token: 'tok', protocol: BRIDGE_PROTOCOL_VERSION, version: '1.0.0' });
    expect(conn.status().connected).toBe(false);
    latest().receive({ type: 'welcome', protocol: 1 });
    expect(conn.status()).toEqual({ enabled: true, connected: true, url: URL });
  });

  it('answers ping with pong and dispatches commands', () => {
    const { conn, latest, onCommand } = setup();
    conn.configure(on);
    latest().open();
    latest().receive({ type: 'ping' });
    expect(latest().sent.at(-1)).toEqual({ type: 'pong' });
    const cmd: BridgeCommand = { id: 'a', method: 'status', params: {} };
    latest().receive(cmd);
    expect(onCommand).toHaveBeenCalledWith(cmd, expect.any(Function));
    const send = onCommand.mock.calls[0][1];
    send({ type: 'response', id: 'a', ok: true, result: 1 });
    expect(latest().sent.at(-1)).toEqual({ type: 'response', id: 'a', ok: true, result: 1 });
  });

  it('reconnects with exponential backoff capped at 30 s and resets after welcome', () => {
    const { conn, latest } = setup();
    conn.configure(on);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = FakeSocket.all.length;
      latest().serverClose();
      let waited = 0;
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    latest().open();
    latest().receive({ type: 'welcome' });
    latest().serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(9);
  });

  it('backs off to the maximum after a token rejection', () => {
    const { conn, latest } = setup();
    conn.configure(on);
    latest().open();
    latest().serverClose(4003, 'bad token');
    vi.advanceTimersByTime(BACKOFF_MAX_MS - 1);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('reconnects immediately when settings change and disconnects when disabled', () => {
    const { conn, latest } = setup();
    conn.configure(on);
    const first = latest();
    conn.configure({ ...on, token: 'new' });
    expect(first.closedWith).toBe(1000);
    expect(FakeSocket.all).toHaveLength(2);
    latest().open();
    expect(latest().sent[0]).toMatchObject({ token: 'new' });
    conn.configure({ ...on, token: 'new', enabled: false });
    expect(latest().closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(conn.status()).toEqual({ enabled: false, connected: false, url: URL });
  });

  it('ignores identical settings and lets the alarm reconnect early', () => {
    const { conn, latest } = setup();
    conn.configure(on);
    conn.configure({ ...on });
    expect(FakeSocket.all).toHaveLength(1);
    latest().serverClose();
    conn.ensure();
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('retries when the socket constructor throws', () => {
    let fail = true;
    const conn = createBridgeConnection({
      version: '1',
      createSocket: (url) => {
        if (fail) throw new Error('bad url');
        return new FakeSocket(url);
      },
      onCommand: () => {},
    });
    conn.configure(on);
    fail = false;
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
