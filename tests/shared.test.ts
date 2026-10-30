import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/shared/settings';

describe('mergeSettings', () => {
  it('fills defaults and keeps overrides', () => {
    const s = mergeSettings({ convert: { ...DEFAULT_SETTINGS.convert, inlineCode: 'plain' } });
    expect(s.convert.inlineCode).toBe('plain');
    expect(s.convert.embedTweets).toBe(true);
    expect(s.bridge.enabled).toBe(false);
  });
});
