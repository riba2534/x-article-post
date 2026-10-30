// Read-only observation of X's own article saves while a write runs. Wraps fetch and
// XMLHttpRequest to read the responses of ArticleEntityUpdate{Content,Title,CoverMedia}; the
// requests are passed through untouched and we never send any. stop() restores the originals.

export type SaveOp = 'content' | 'title' | 'cover';

/** A save X got an answer for. Aborted / failed-network requests are not answers and not kept. */
export interface SaveRecord {
  op: SaveOp;
  /** performance.now() when X sent the request. */
  sentAt: number;
  /** Undefined = accepted; otherwise the first GraphQL error message in the response body. */
  error?: string;
}

export type SaveOutcome = { ok: true } | { ok: false; error: string };

/** X saves body edits ~3 s after the last change. Earlier requests carry older content. */
export const SAVE_DEBOUNCE_MS = 2500;
/** After the first answer for the final state, later answers may still arrive; the last one counts. */
export const SAVE_SETTLE_MS = 1500;

const OPS: Record<string, SaveOp> = {
  ArticleEntityUpdateContent: 'content',
  ArticleEntityUpdateTitle: 'title',
  ArticleEntityUpdateCoverMedia: 'cover',
};

/** X's media upload FINALIZE step: after it answers, X inserts the image within about a second. */
export function isUploadFinalize(url: string): boolean {
  return /\/media\/upload\.json\b/.test(url) && /[?&]command=FINALIZE\b/.test(url);
}

export function saveOpOf(url: string): SaveOp | undefined {
  const name = /\/graphql\/[^/]+\/(ArticleEntityUpdate\w+)/.exec(url)?.[1];
  return name ? OPS[name] : undefined;
}

/**
 * Reads X's answer from a completed response: { error } when the body carries GraphQL errors,
 * {} when it is a normal GraphQL result, null when it is no answer at all (non-JSON body, HTTP
 * error without errors) and so neither confirms nor rejects anything.
 */
export function graphqlAnswer(status: number, body: string): { error?: string } | null {
  let json: { errors?: { message?: string }[]; data?: unknown };
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (json?.errors?.length) return { error: String(json.errors[0].message ?? 'unknown error') };
  return status >= 200 && status < 300 && json && 'data' in json ? {} : null;
}

interface SaveWin {
  fetch: typeof fetch;
  XMLHttpRequest: typeof XMLHttpRequest;
  performance: { now(): number };
}

export interface SaveWatcher {
  /** Answered saves, in completion order. */
  readonly records: readonly SaveRecord[];
  /** Save requests X sent while we watched (answered or not): 0 means the wrappers saw nothing. */
  readonly requests: number;
  /**
   * X's last answer to a content save sent at least SAVE_DEBOUNCE_MS after `since`
   * (performance.now()), i.e. one carrying the edit made at `since`; null when none came in time.
   */
  contentAfter(since: number, timeoutMs: number, settleMs?: number): Promise<SaveOutcome | null>;
  /** performance.now() of the first media upload X finished (FINALIZE answered) at or after `since`. */
  uploadFinishedAfter(since: number): number | undefined;
  stop(): void;
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

export function watchSaves(win: SaveWin): SaveWatcher {
  const records: SaveRecord[] = [];
  const finalized: number[] = [];
  let requests = 0;
  const waiters = new Set<() => void>();
  const answer = (op: SaveOp, sentAt: number, a: { error?: string } | null) => {
    if (!a) return;
    records.push({ op, sentAt, error: a.error });
    for (const w of waiters) w();
  };

  const origFetch = win.fetch;
  const wrappedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const url = urlOf(input);
    const op = saveOpOf(url);
    const sentAt = win.performance.now();
    const pending = origFetch.call(this, input, init);
    if (isUploadFinalize(url)) pending.then((res) => res.ok && finalized.push(win.performance.now())).catch(() => {});
    if (op) {
      requests++;
      // A rejected fetch (AbortError, network failure) is no answer from X: ignore it.
      pending.then((res) => res.clone().text().then((body) => answer(op, sentAt, graphqlAnswer(res.status, body)))).catch(() => {});
    }
    return pending;
  } as typeof fetch;
  win.fetch = wrappedFetch;

  const proto = win.XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const opOf = new WeakMap<XMLHttpRequest, SaveOp>();
  const finalizes = new WeakSet<XMLHttpRequest>();
  const wrappedOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
    if (isUploadFinalize(String(args[1]))) finalizes.add(this);
    else finalizes.delete(this);
    const op = saveOpOf(String(args[1]));
    if (op) opOf.set(this, op);
    else opOf.delete(this);
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  };
  const wrappedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (finalizes.has(this)) {
      this.addEventListener('loadend', () => {
        if (this.status >= 200 && this.status < 300) finalized.push(win.performance.now());
      });
    }
    const op = opOf.get(this);
    if (op) {
      requests++;
      const sentAt = win.performance.now();
      this.addEventListener('loadend', () => {
        if (this.status === 0) return; // aborted or network error
        try {
          const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response ?? null);
          answer(op, sentAt, graphqlAnswer(this.status, text));
        } catch {
          // unreadable body: no answer
        }
      });
    }
    return origSend.call(this, body);
  };
  proto.open = wrappedOpen as typeof proto.open;
  proto.send = wrappedSend;

  return {
    records,
    get requests() {
      return requests;
    },
    contentAfter(since, timeoutMs, settleMs = SAVE_SETTLE_MS) {
      const matching = () => records.filter((r) => r.op === 'content' && r.sentAt >= since + SAVE_DEBOUNCE_MS);
      return new Promise((resolve) => {
        let settle: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          waiters.delete(check);
          clearTimeout(timer);
          clearTimeout(settle);
          const last = matching().at(-1);
          resolve(last ? (last.error ? { ok: false, error: last.error } : { ok: true }) : null);
        };
        const check = () => {
          if (!settle && matching().length) settle = setTimeout(finish, settleMs);
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    uploadFinishedAfter(since) {
      return finalized.find((t) => t >= since);
    },
    stop() {
      if (win.fetch === wrappedFetch) win.fetch = origFetch;
      if (proto.open === (wrappedOpen as typeof proto.open)) proto.open = origOpen;
      if (proto.send === wrappedSend) proto.send = origSend;
    },
  };
}
