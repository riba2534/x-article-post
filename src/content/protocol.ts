// Messages and URLs shared by background, the content script and the MAIN-world script.
import type { PreparedImage, WriteBlock, WriteProgress, WriteResult } from '../shared/types';

/** What MAIN needs to write; image bytes are fetched one by one on demand. */
export interface MainWriteRequest {
  runId: string;
  title: string;
  blocks: WriteBlock[];
  coverImageId?: string;
  mode: 'append' | 'replace';
  /** Refuse to write when the page shows another article. */
  articleId?: string;
}

export type MainResult = Omit<WriteResult, 'ok' | 'runId' | 'url'>;

export interface EditorStatus {
  url: string;
  articleId?: string;
  editorReady: boolean;
}

/** background -> content via chrome.tabs.sendMessage. */
export type ContentRequest =
  | { type: 'xap:c:ping' }
  | { type: 'xap:c:state' }
  | { type: 'xap:c:new-draft' };

export type NewDraftResponse = { ok: true; articleId: string } | { ok: false; error: string };

/** Name of the port background opens with chrome.tabs.connect for one write. */
export const WRITE_PORT = 'xap-write';

/** background -> content on the write port; content forwards image/cancel to MAIN unchanged. */
export type PortDown =
  | { type: 'start'; request: MainWriteRequest }
  | { type: 'image'; imageId: string; image?: PreparedImage; error?: string }
  | { type: 'cancel' };

/** content -> background on the write port (MAIN events forwarded unchanged). */
export type PortUp =
  | { type: 'progress'; progress: WriteProgress }
  | { type: 'need-image'; imageId: string }
  | { type: 'result'; result: MainResult };

// content <-> MAIN over a MessageChannel handed over with a window.postMessage handshake.
export const CONNECT_SOURCE = 'xap-content';
export const MAIN_READY_SOURCE = 'xap-main';

export type MainCall =
  | { method: 'state' }
  | { method: 'write'; request: MainWriteRequest };

/** content -> MAIN. Every message carries the handshake token. */
export type ToMain =
  | { token: string; kind: 'call'; id: number; call: MainCall }
  | { token: string; kind: 'image'; imageId: string; image?: PreparedImage; error?: string }
  | { token: string; kind: 'cancel' };

/** MAIN -> content. */
export type FromMain =
  | { kind: 'hello' }
  /** Sent periodically while a call runs, so the content script can detect a dead MAIN. */
  | { kind: 'beat' }
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }
  | { kind: 'progress'; progress: WriteProgress }
  | { kind: 'need-image'; imageId: string };

export const ARTICLES_URL = 'https://x.com/compose/articles';
export const editUrl = (id: string): string => `${ARTICLES_URL}/edit/${id}`;

export const articleIdFromUrl = (url: string): string | undefined =>
  /\/compose\/articles\/edit\/(\d+)/.exec(url)?.[1];

/** The Articles list page (where "create" lives), path or full URL. */
export const isArticlesList = (url: string): boolean => /\/compose\/articles\/?(\?.*)?$/.test(url);
