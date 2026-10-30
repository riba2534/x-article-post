import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DEBOUNCE_MS, graphqlError, saveOpOf, watchSaves } from '../../src/main/saves';
import { runWrite, saveError } from '../../src/main/write';
import { ARTICLE_BLOCK_LIMIT, type WriteBlock } from '../../src/shared/types';

const CONTENT = 'https://x.com/i/api/graphql/abc123/ArticleEntityUpdateContent';
const TITLE = 'https://x.com/i/api/graphql/q1/ArticleEntityUpdateTitle';
const REJECTED = JSON.stringify({ errors: [{ message: 'BadRequest: Block count exceeds the allowed limit' }] });
const ACCEPTED = JSON.stringify({ data: { articleentity_update_content: { ok: true } } });

/** XHR stand-in: `respond` finishes the request like the network would. */
class FakeXHR {
  static sent: FakeXHR[] = [];
  responseType = '';
  responseText = '';
  response: unknown = null;
  status = 0;
  url = '';
  body: unknown;
  private listeners: (() => void)[] = [];
  open(_method: string, url: string) {
    this.url = url;
  }
  send(body?: unknown) {
    this.body = body;
    FakeXHR.sent.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    if (type === 'loadend') this.listeners.push(fn);
  }
  respond(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    for (const fn of this.listeners) fn();
  }
}

function fakeWin() {
  let now = 0;
  const calls: unknown[][] = [];
  const responses = new Map<string, () => Response>();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const make = responses.get(String(input));
    return make ? make() : new Response('{}');
  });
  FakeXHR.sent = [];
  const win = {
    fetch: fetchImpl as unknown as typeof fetch,
    XMLHttpRequest: class extends FakeXHR {} as unknown as typeof XMLHttpRequest,
    performance: { now: () => now },
  };
  return { win, calls, responses, fetchImpl, setNow: (t: number) => (now = t) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('save response parsing', () => {
  it('recognises only article update operations', () => {
    expect(saveOpOf(CONTENT)).toBe('content');
    expect(saveOpOf(`${TITLE}?x=1`)).toBe('title');
    expect(saveOpOf('https://x.com/i/api/graphql/z/ArticleEntityUpdateCoverMedia')).toBe('cover');
    expect(saveOpOf('https://x.com/i/api/graphql/z/ArticleEntityResultByRestId')).toBeUndefined();
    expect(saveOpOf('https://x.com/home')).toBeUndefined();
  });

  it('reads the first GraphQL error even on HTTP 200', () => {
    expect(graphqlError(200, REJECTED)).toBe('BadRequest: Block count exceeds the allowed limit');
    expect(graphqlError(200, ACCEPTED)).toBeUndefined();
    expect(graphqlError(200, JSON.stringify({ errors: [] }))).toBeUndefined();
    expect(graphqlError(500, 'oops')).toBe('HTTP 500');
    expect(graphqlError(403, '{}')).toBe('HTTP 403');
    expect(graphqlError(200, 'not json')).toBeUndefined();
  });

  it('maps the final outcome to the run error', () => {
    expect(saveError({ ok: true })).toBeUndefined();
    expect(saveError({ ok: false, error: 'BadRequest' })).toBe('X 拒绝保存：BadRequest');
    expect(saveError(null)).toBe('未确认 X 已保存');
  });
});

describe('watchSaves', () => {
  it('passes fetch requests through untouched and records X answers', async () => {
    const { win, calls, responses } = fakeWin();
    responses.set(CONTENT, () => new Response(REJECTED, { status: 200 }));
    const w = watchSaves(win);
    const init = { method: 'POST', body: '{"variables":1}' };
    const res = await win.fetch(CONTENT, init);
    expect(await res.text()).toBe(REJECTED); // the page still gets the full body
    await win.fetch('https://x.com/i/api/graphql/q/HomeTimeline');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toEqual([CONTENT, init]);
    expect(w.records).toEqual([{ op: 'content', sentAt: 0, error: 'BadRequest: Block count exceeds the allowed limit' }]);
    w.stop();
  });

  it('observes XMLHttpRequest saves without changing the request body', () => {
    const { win } = fakeWin();
    const w = watchSaves(win);
    const ok = new win.XMLHttpRequest();
    ok.open('POST', TITLE);
    ok.send('title-body');
    const other = new win.XMLHttpRequest();
    other.open('POST', 'https://x.com/i/api/1.1/jot');
    other.send('x');
    const sent = FakeXHR.sent as FakeXHR[];
    expect(sent.map((x) => x.body)).toEqual(['title-body', 'x']);
    sent[0].respond(200, ACCEPTED);
    sent[1].respond(200, REJECTED);
    expect(w.records).toEqual([{ op: 'title', sentAt: 0, error: undefined }]);
    w.stop();
  });

  it('contentAfter waits for the save carrying the edit, ignoring earlier ones', async () => {
    const { win, setNow } = fakeWin();
    const w = watchSaves(win);
    const send = (t: number, body: string) => {
      setNow(t);
      const x = new win.XMLHttpRequest();
      x.open('POST', CONTENT);
      x.send('{}');
      (FakeXHR.sent.at(-1) as FakeXHR).respond(200, body);
    };
    const edit = 10_000;
    send(edit + 100, ACCEPTED); // upload-triggered save: older content
    const pending = w.contentAfter(edit, 20_000);
    let outcome: unknown = 'pending';
    void pending.then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe('pending');
    send(edit + SAVE_DEBOUNCE_MS + 500, REJECTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toEqual({ ok: false, error: 'BadRequest: Block count exceeds the allowed limit' });
    w.stop();
  });

  it('contentAfter resolves ok for an accepted save and null on timeout', async () => {
    const { win, setNow } = fakeWin();
    const w = watchSaves(win);
    const none = w.contentAfter(0, 20_000);
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(none).resolves.toBeNull();
    setNow(SAVE_DEBOUNCE_MS + 1);
    const x = new win.XMLHttpRequest();
    x.open('POST', CONTENT);
    x.send('{}');
    (FakeXHR.sent.at(-1) as FakeXHR).respond(200, ACCEPTED);
    await expect(w.contentAfter(0, 1000)).resolves.toEqual({ ok: true });
    w.stop();
  });

  it('counts a network failure as not saved', () => {
    const { win, setNow } = fakeWin();
    const w = watchSaves(win);
    setNow(5000);
    const x = new win.XMLHttpRequest();
    x.open('POST', CONTENT);
    x.send('{}');
    (FakeXHR.sent.at(-1) as FakeXHR).respond(0, '');
    expect(w.records[0].error).toBe('network error');
    w.stop();
  });

  it('stop() restores the original fetch and XHR methods', () => {
    const { win, fetchImpl } = fakeWin();
    const proto = win.XMLHttpRequest.prototype;
    const [open, send] = [proto.open, proto.send];
    const w = watchSaves(win);
    expect(win.fetch).not.toBe(fetchImpl);
    expect(proto.open).not.toBe(open);
    w.stop();
    expect(win.fetch).toBe(fetchImpl);
    expect(proto.open).toBe(open);
    expect(proto.send).toBe(send);
  });
});

describe('block limit', () => {
  it('refuses requests over the X block limit without touching the page', async () => {
    const block: WriteBlock = { kind: 'text', type: 'unstyled', text: 'a', styles: [], links: [] };
    const io = { progress: vi.fn(), getImage: vi.fn(), isCancelled: () => false };
    const result = await runWrite(
      { runId: 'r', title: 't', blocks: Array(ARTICLE_BLOCK_LIMIT + 1).fill(block), mode: 'replace' },
      io,
    );
    expect(result.error).toBe('内容超过 X 的 1000 块上限');
    expect(result.blocksWritten).toBe(0);
    expect(io.progress).not.toHaveBeenCalled();
  });
});
