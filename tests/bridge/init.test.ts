import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketLike } from '../../src/background/bridge/connection';
import { SETTINGS_KEY } from '../../src/shared/settings';

const statusProvider = vi.hoisted(() => ({ fn: null as null | (() => unknown) }));

vi.mock('../../src/background/writer', () => ({
  isBusy: () => false,
  getXTabStatus: async () => null,
  runWrite: vi.fn(),
  setBridgeStatusProvider: (fn: () => unknown) => {
    statusProvider.fn = fn;
  },
}));
vi.mock('../../src/background/offscreen', () => ({ ensureOffscreen: vi.fn(async () => {}) }));

type Listener = (...args: never[]) => void;

function mockChrome(stored: unknown) {
  const listeners: { storage: Listener[]; alarm: Listener[] } = { storage: [], alarm: [] };
  const chromeMock = {
    runtime: { getManifest: () => ({ version: '2.0.0' }), sendMessage: vi.fn() },
    storage: {
      local: { get: vi.fn(async () => ({ [SETTINGS_KEY]: stored })) },
      onChanged: { addListener: (fn: Listener) => listeners.storage.push(fn) },
    },
    alarms: { create: vi.fn(async () => {}), onAlarm: { addListener: (fn: Listener) => listeners.alarm.push(fn) } },
  };
  vi.stubGlobal('chrome', chromeMock);
  return { chromeMock, listeners };
}

describe('initBridge', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('connects from stored settings, follows storage changes and registers the alarm', async () => {
    const urls: string[] = [];
    const sockets: SocketLike[] = [];
    const createSocket = (url: string) => {
      urls.push(url);
      const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn() } as SocketLike;
      sockets.push(s);
      return s;
    };
    const { chromeMock, listeners } = mockChrome({ bridge: { enabled: true, url: 'ws://127.0.0.1:1/ext', token: 't' } });
    const { initBridge } = await import('../../src/background/bridge');
    initBridge({ createSocket });

    await vi.waitFor(() => expect(urls).toEqual(['ws://127.0.0.1:1/ext']));
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('xap:bridge', { periodInMinutes: 1 });
    expect(statusProvider.fn?.()).toEqual({ enabled: true, connected: false, url: 'ws://127.0.0.1:1/ext' });

    const change = (value: unknown) => (listeners.storage[0] as (c: unknown, a: string) => void)({ [SETTINGS_KEY]: { newValue: value } }, 'local');
    change({ bridge: { enabled: true, url: 'ws://127.0.0.1:2/ext', token: 't' } });
    expect(urls).toEqual(['ws://127.0.0.1:1/ext', 'ws://127.0.0.1:2/ext']);
    change({ bridge: { enabled: false, url: 'ws://127.0.0.1:2/ext', token: 't' } });
    expect(sockets[1].close).toHaveBeenCalled();
    expect(statusProvider.fn?.()).toMatchObject({ enabled: false, connected: false });

    // Storage area other than local is ignored.
    (listeners.storage[0] as (c: unknown, a: string) => void)({ [SETTINGS_KEY]: { newValue: { bridge: { enabled: true, token: 'x' } } } }, 'sync');
    expect(urls).toHaveLength(2);
  });

  it('stays idle when the bridge is disabled', async () => {
    const createSocket = vi.fn();
    const { listeners } = mockChrome(undefined);
    const { initBridge } = await import('../../src/background/bridge');
    initBridge({ createSocket });
    (listeners.alarm[0] as (a: { name: string }) => void)({ name: 'xap:bridge' });
    await new Promise((r) => setTimeout(r, 10));
    expect(createSocket).not.toHaveBeenCalled();
  });
});
