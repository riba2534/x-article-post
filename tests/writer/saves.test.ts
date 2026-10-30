import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DEBOUNCE_MS, SAVE_SETTLE_MS, graphqlAnswer, isUploadFinalize, saveOpOf, watchSaves } from '../../src/main/saves';
import { UNOBSERVED_WARNING, runWrite, saveVerdict } from '../../src/main/write';
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

  it('only GraphQL errors in the body reject; only a data result confirms', () => {
    expect(graphqlAnswer(200, REJECTED)).toEqual({ error: 'BadRequest: Block count exceeds the allowed limit' });
    expect(graphqlAnswer(400, REJECTED)).toEqual({ error: 'BadRequest: Block count exceeds the allowed limit' });
    expect(graphqlAnswer(200, ACCEPTED)).toEqual({});
    expect(graphqlAnswer(200, JSON.stringify({ errors: [], data: {} }))).toEqual({});
    expect(graphqlAnswer(500, 'oops')).toBeNull();
    expect(graphqlAnswer(503, '{}')).toBeNull();
    expect(graphqlAnswer(200, 'not json')).toBeNull();
    expect(graphqlAnswer(200, 'null')).toBeNull();
  });

  it('judges the final save; unobserved traffic is a warning, not a failure', () => {
    expect(saveVerdict({ ok: true }, 3)).toEqual({});
    expect(saveVerdict({ ok: false, error: 'BadRequest' }, 3)).toEqual({ error: 'X 拒绝保存：BadRequest' });
    expect(saveVerdict(null, 2)).toEqual({ error: '未确认 X 已保存' });
    expect(saveVerdict(null, 0)).toEqual({ warning: UNOBSERVED_WARNING });
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
    expect(w.requests).toBe(1);
    w.stop();
  });

  it('ignores aborted fetches but counts them as observed requests', async () => {
    const { win, fetchImpl } = fakeWin();
    fetchImpl.mockImplementationOnce(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const w = watchSaves(win);
    await expect(win.fetch(CONTENT, { method: 'POST' })).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(0);
    expect(w.records).toEqual([]);
    expect(w.requests).toBe(1);
    w.stop();
  });

  it('ignores XHR status 0 and HTTP errors without GraphQL errors', () => {
    const { win } = fakeWin();
    const w = watchSaves(win);
    for (const [status, body] of [[0, ''], [0, REJECTED], [500, 'oops'], [502, '{}']] as const) {
      const x = new win.XMLHttpRequest();
      x.open('POST', CONTENT);
      x.send('{}');
      (FakeXHR.sent.at(-1) as FakeXHR).respond(status, body);
    }
    expect(w.records).toEqual([]);
    expect(w.requests).toBe(4);
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
    expect(w.requests).toBe(1);
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
    await vi.advanceTimersByTimeAsync(SAVE_SETTLE_MS + 1);
    expect(outcome).toEqual({ ok: false, error: 'BadRequest: Block count exceeds the allowed limit' });
    w.stop();
  });

  it('contentAfter with settleMs 0 resolves on the first answer carrying the edit', async () => {
    const { win, setNow } = fakeWin();
    const w = watchSaves(win);
    setNow(SAVE_DEBOUNCE_MS + 100);
    const x = new win.XMLHttpRequest();
    x.open('POST', CONTENT);
    x.send('{}');
    let outcome: unknown = 'pending';
    void w.contentAfter(0, 20_000, 0).then((o) => (outcome = o));
    (FakeXHR.sent.at(-1) as FakeXHR).respond(200, ACCEPTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toEqual({ ok: true });
    w.stop();
  });

  it('records when X finishes a media upload (FINALIZE), and only successful ones', () => {
    const { win, setNow } = fakeWin();
    const w = watchSaves(win);
    const finalize = (t: number, status: number) => {
      setNow(t);
      const x = new win.XMLHttpRequest();
      x.open('POST', 'https://upload.x.com/i/media/upload.json?command=FINALIZE&media_id=1');
      x.send('');
      (FakeXHR.sent.at(-1) as FakeXHR).respond(status, '{}');
    };
    finalize(100, 500);
    expect(w.uploadFinishedAfter(0)).toBeUndefined();
    finalize(200, 200);
    finalize(300, 200);
    expect(w.uploadFinishedAfter(0)).toBe(200);
    expect(w.uploadFinishedAfter(250)).toBe(300);
    expect(w.uploadFinishedAfter(400)).toBeUndefined();
    expect(isUploadFinalize('https://upload.x.com/i/media/upload.json?command=APPEND')).toBe(false);
    w.stop();
  });

  it('the last completed answer after the final edit wins', async () => {
    const { win, setNow } = fakeWin();
    const w = watchSaves(win);
    const open = (t: number) => {
      setNow(t);
      const x = new win.XMLHttpRequest();
      x.open('POST', CONTENT);
      x.send('{}');
      return FakeXHR.sent.at(-1) as FakeXHR;
    };
    const late = SAVE_DEBOUNCE_MS + 100;
    const first = open(late);
    const second = open(late + 50);
    const pending = w.contentAfter(0, 20_000);
    first.respond(200, REJECTED);
    await vi.advanceTimersByTimeAsync(500);
    second.respond(200, ACCEPTED);
    await vi.advanceTimersByTimeAsync(SAVE_SETTLE_MS);
    await expect(pending).resolves.toEqual({ ok: true });

    const third = open(late + 100);
    const again = w.contentAfter(0, 20_000);
    third.respond(200, REJECTED);
    await vi.advanceTimersByTimeAsync(SAVE_SETTLE_MS + 1);
    await expect(again).resolves.toEqual({ ok: false, error: 'BadRequest: Block count exceeds the allowed limit' });
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
    const ok = w.contentAfter(0, 20_000);
    await vi.advanceTimersByTimeAsync(SAVE_SETTLE_MS + 1);
    await expect(ok).resolves.toEqual({ ok: true });
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
