// WebSocket client from the extension background to the local `xap` bridge.
import { BRIDGE_PROTOCOL_VERSION, type BridgeCommand, type BridgeMessage, type ExtensionStatus } from '../../shared/types';
import type { BridgeSettings } from '../../shared/settings';

/** The subset of the DOM WebSocket the connection uses (lets tests inject a fake). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectionDeps {
  version: string;
  createSocket(url: string): SocketLike;
  onCommand(cmd: BridgeCommand, send: (msg: BridgeMessage) => void): void;
  onStateChange?(state: ExtensionStatus['bridge']): void;
  log?(message: string): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
const OPEN = 1;
/** Close codes from the bridge that will not fix themselves (bad token, protocol). */
const FATAL_CLOSE_CODES = new Set([4003, 4004]);

export function createBridgeConnection(deps: ConnectionDeps) {
  const setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => {});

  let settings: BridgeSettings = { enabled: false, url: '', token: '' };
  let socket: SocketLike | null = null;
  let connected = false;
  let backoff = BACKOFF_MIN_MS;
  let retryTimer: unknown = null;

  const state = (): ExtensionStatus['bridge'] => ({ enabled: settings.enabled, connected, url: settings.url });

  function setConnected(value: boolean) {
    if (connected === value) return;
    connected = value;
    deps.onStateChange?.(state());
  }

  function cancelRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  function drop() {
    cancelRetry();
    const s = socket;
    socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close(1000, 'bridge disabled');
    }
    setConnected(false);
  }

  function scheduleRetry() {
    if (!settings.enabled || retryTimer !== null) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retryTimer = setTimer(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    cancelRetry();
    if (!settings.enabled || !settings.url || !settings.token || socket) return;
    let s: SocketLike;
    try {
      s = deps.createSocket(settings.url);
    } catch (err) {
      log(`bridge: cannot open ${settings.url}: ${err instanceof Error ? err.message : String(err)}`);
      scheduleRetry();
      return;
    }
    socket = s;
    const send = (msg: BridgeMessage) => {
      if (socket === s && s.readyState === OPEN) s.send(JSON.stringify(msg));
    };
    s.onopen = () => send({ type: 'hello', token: settings.token, protocol: BRIDGE_PROTOCOL_VERSION, version: deps.version });
    s.onmessage = (ev) => {
      let msg: { type?: unknown; id?: unknown; method?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'ping') return s.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'welcome') {
        backoff = BACKOFF_MIN_MS;
        setConnected(true);
        return;
      }
      if (typeof msg.id === 'string' && typeof msg.method === 'string') deps.onCommand(msg as BridgeCommand, send);
    };
    s.onerror = () => {};
    s.onclose = (ev) => {
      if (socket !== s) return;
      socket = null;
      setConnected(false);
      if (FATAL_CLOSE_CODES.has(ev.code)) {
        log(`bridge: rejected (${ev.code} ${ev.reason}); check the token in settings`);
        backoff = BACKOFF_MAX_MS;
      }
      scheduleRetry();
    };
  }

  return {
    /** Applies new settings: connects, disconnects or reconnects as needed. */
    configure(next: BridgeSettings) {
      const changed = next.enabled !== settings.enabled || next.url !== settings.url || next.token !== settings.token;
      settings = { ...next };
      if (!changed) return;
      drop();
      backoff = BACKOFF_MIN_MS;
      deps.onStateChange?.(state());
      connect();
    },
    /** Periodic check (alarm): reconnect right away if enabled and idle. */
    ensure() {
      if (settings.enabled && !socket) connect();
    },
    status: state,
    disconnect: drop,
  };
}
