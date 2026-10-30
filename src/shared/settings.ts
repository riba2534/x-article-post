import { BRIDGE_DEFAULT_PORT, DEFAULT_CONVERT_OPTIONS, type ConvertOptions } from './types';

export interface BridgeSettings {
  enabled: boolean;
  /** ws://127.0.0.1:<port>/ext */
  url: string;
  /** Pairing token printed by `xap serve`. */
  token: string;
}

export interface Settings {
  convert: ConvertOptions;
  bridge: BridgeSettings;
}

export const SETTINGS_KEY = 'xap:settings';
export const DRAFT_KEY = 'xap:draft';

export const DEFAULT_SETTINGS: Settings = {
  convert: DEFAULT_CONVERT_OPTIONS,
  bridge: { enabled: false, url: `ws://127.0.0.1:${BRIDGE_DEFAULT_PORT}/ext`, token: '' },
};

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return {
    convert: { ...DEFAULT_SETTINGS.convert, ...(stored?.convert ?? {}) },
    bridge: { ...DEFAULT_SETTINGS.bridge, ...(stored?.bridge ?? {}) },
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings({
    convert: { ...current.convert, ...(patch.convert ?? {}) },
    bridge: { ...current.bridge, ...(patch.bridge ?? {}) },
  });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
