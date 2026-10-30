// Small helpers shared by the background writer, the content script and the MAIN-world script.
// No chrome.* APIs: this is also bundled into the page's MAIN world.
import type { MainResult } from './protocol';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Labels that must never be clicked: the writer only creates drafts. */
export const PUBLISH_RE = /publish|post|发布|發佈|發布|公開|게시/i;

export const emptyMainResult = (error?: string): MainResult => ({
  blocksWritten: 0, imagesOk: 0, imagesFailed: [], titleSet: false, coverSet: false, warnings: [], error,
});
