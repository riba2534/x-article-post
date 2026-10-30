// Read-only observation of X's own article saves while a write runs. Wraps fetch and
// XMLHttpRequest to read the responses of ArticleEntityUpdate{Content,Title,CoverMedia}; the
// requests are passed through untouched and we never send any. stop() restores the originals.

export type SaveOp = 'content' | 'title' | 'cover';

export interface SaveRecord {
  op: SaveOp;
  /** performance.now() when X sent the request. */
  sentAt: number;
  /** Undefined = accepted; otherwise the first GraphQL error message. */
  error?: string;
}

export type SaveOutcome = { ok: true } | { ok: false; error: string };

/** X saves body edits ~3 s after the last change. Earlier requests carry older content. */
export const SAVE_DEBOUNCE_MS = 2500;

const OPS: Record<string, SaveOp> = {
  ArticleEntityUpdateContent: 'content',
  ArticleEntityUpdateTitle: 'title',
  ArticleEntityUpdateCoverMedia: 'cover',
};

export function saveOpOf(url: string): SaveOp | undefined {
  const name = /\/graphql\/[^/]+\/(ArticleEntityUpdate\w+)/.exec(url)?.[1];
  return name ? OPS[name] : undefined;
}

/** First GraphQL error message of a response body, or undefined when X accepted it. */
export function graphqlError(status: number, body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { errors?: { message?: string }[] };
    if (json.errors?.length) return String(json.errors[0].message ?? 'unknown error');
  } catch {
    if (status < 200 || status >= 300) return `HTTP ${status}`;
    return undefined;
  }
  return status >= 200 && status < 300 ? undefined : `HTTP ${status}`;
}

interface SaveWin {
  fetch: typeof fetch;
  XMLHttpRequest: typeof XMLHttpRequest;
  performance: { now(): number };
}

export interface SaveWatcher {
  readonly records: readonly SaveRecord[];
  /**
   * Resolves with the first content save X sent at least SAVE_DEBOUNCE_MS after `since`
   * (performance.now()), i.e. the one carrying edits made at `since`; null on timeout.
   */
  contentAfter(since: number, timeoutMs: number): Promise<SaveOutcome | null>;
  stop(): void;
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

export function watchSaves(win: SaveWin): SaveWatcher {
  const records: SaveRecord[] = [];
  const waiters = new Set<() => void>();
  const add = (r: SaveRecord) => {
    records.push(r);
    for (const w of waiters) w();
  };

  const origFetch = win.fetch;
  const wrappedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const op = saveOpOf(urlOf(input));
    const sentAt = win.performance.now();
    const pending = origFetch.call(this, input, init);
    if (op) {
      pending
        .then((res) => res.clone().text().then((body) => add({ op, sentAt, error: graphqlError(res.status, body) })))
        .catch((e: unknown) => add({ op, sentAt, error: e instanceof Error ? e.message : String(e) }));
    }
    return pending;
  } as typeof fetch;
  win.fetch = wrappedFetch;

  const proto = win.XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const opOf = new WeakMap<XMLHttpRequest, SaveOp>();
  const wrappedOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
    const op = saveOpOf(String(args[1]));
    if (op) opOf.set(this, op);
    else opOf.delete(this);
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  };
  const wrappedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const op = opOf.get(this);
    if (op) {
      const sentAt = win.performance.now();
      this.addEventListener('loadend', () => {
        let text = '';
        try {
          text = this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response ?? null);
        } catch {
          // unreadable body: judge by status only
        }
        add({ op, sentAt, error: this.status === 0 ? 'network error' : graphqlError(this.status, text) });
      });
    }
    return origSend.call(this, body);
  };
  proto.open = wrappedOpen as typeof proto.open;
  proto.send = wrappedSend;

  return {
    records,
    contentAfter(since, timeoutMs) {
      const find = () => records.find((r) => r.op === 'content' && r.sentAt >= since + SAVE_DEBOUNCE_MS);
      return new Promise((resolve) => {
        const done = (r: SaveRecord | undefined) => {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(r ? (r.error ? { ok: false, error: r.error } : { ok: true }) : null);
        };
        const check = () => {
          const r = find();
          if (r) done(r);
        };
        const timer = setTimeout(() => done(undefined), timeoutMs);
        waiters.add(check);
        check();
      });
    },
    stop() {
      if (win.fetch === wrappedFetch) win.fetch = origFetch;
      if (proto.open === (wrappedOpen as typeof proto.open)) proto.open = origOpen;
      if (proto.send === wrappedSend) proto.send = origSend;
      for (const w of waiters) w();
    },
  };
}
