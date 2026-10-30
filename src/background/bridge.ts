// Agent bridge client: connects the background to the local `xap` bridge and runs its commands.
import { loadSettings, mergeSettings, SETTINGS_KEY, type Settings } from '../shared/settings';
import { ensureOffscreen } from './offscreen';
import { getXTabStatus, isBusy, runWrite, setBridgeStatusProvider } from './writer';
import { createCommandHandler, type CommandDeps, type PrepareReply } from './bridge/commands';
import { createBridgeConnection, type SocketLike } from './bridge/connection';

const ALARM = 'xap:bridge';

export interface BridgeInitDeps extends Omit<CommandDeps, 'bridgeStatus' | 'version'> {
  version: string;
  createSocket(url: string): SocketLike;
}

function defaultDeps(): BridgeInitDeps {
  return {
    version: chrome.runtime.getManifest().version,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    isBusy,
    getXTabStatus,
    ensureOffscreen,
    prepare: (message) => chrome.runtime.sendMessage(message) as Promise<PrepareReply | undefined>,
    runWrite,
  };
}

export function initBridge(overrides: Partial<BridgeInitDeps> = {}): void {
  const deps = { ...defaultDeps(), ...overrides };
  const connection = createBridgeConnection({
    version: deps.version,
    createSocket: deps.createSocket,
    onCommand: (cmd, send) => void handle(cmd, send),
    log: (message) => console.warn(message),
  });
  const handle = createCommandHandler({ ...deps, bridgeStatus: connection.status });
  setBridgeStatusProvider(() => connection.status());

  const apply = (settings: Settings) => connection.configure(settings.bridge);
  void loadSettings().then(apply);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) apply(mergeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined));
  });

  // Wakes the service worker after it was suspended and restores the connection.
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    // Settings are kept current by storage.onChanged; only revive an idle connection.
    if (alarm.name === ALARM) connection.ensure();
  });
}
