import { describe, expect, it, vi } from 'vitest';
import { fetchImageBytes, isPrivateHost, mapLimit } from '../../src/pipeline/fetch';

const host = (url: string) => new URL(url).hostname;

function response(body: BodyInit | null, init: ResponseInit & { url?: string; redirected?: boolean } = {}): Response {
  const res = new Response(body, init);
  if (init.url) Object.defineProperty(res, 'url', { value: init.url });
  if (init.redirected) Object.defineProperty(res, 'redirected', { value: true });
  return res;
}

describe('isPrivateHost', () => {
  it.each([
    'http://localhost/',
    'http://foo.localhost/',
    'http://printer.local/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://0x7f000001/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.31.1/',
    'http://169.254.169.254/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
  ])('%s is private', (url) => expect(isPrivateHost(host(url))).toBe(true));

  it.each(['https://img.riba2534.cn/', 'http://8.8.8.8/', 'http://172.32.0.1/', 'http://100.128.0.1/', 'http://[2001:4860::8888]/', 'http://[::ffff:8.8.8.8]/', 'https://localhost.example.com/'])(
    '%s is public',
    (url) => expect(isPrivateHost(host(url))).toBe(false),
  );
});

describe('fetchImageBytes', () => {
  it('fetches without credentials and returns bytes + content type', async () => {
    const fetchImpl = vi.fn(async () => response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const out = await fetchImageBytes('https://a.example/x.png', { fetchImpl });
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.contentType).toBe('image/png');
    expect(fetchImpl).toHaveBeenCalledWith('https://a.example/x.png', expect.objectContaining({ credentials: 'omit', redirect: 'follow' }));
  });

  it('rejects a public URL that redirects into a private network', async () => {
    const fetchImpl = vi.fn(async () => response('secret', { url: 'http://192.168.1.1/admin', redirected: true }));
    await expect(fetchImageBytes('https://a.example/x.png', { fetchImpl })).rejects.toThrow('内网');
  });

  it('allows redirects between public hosts and from private hosts', async () => {
    const ok = (url: string) => vi.fn(async () => response('img', { url, redirected: true }));
    await expect(fetchImageBytes('https://a.example/x.png', { fetchImpl: ok('https://cdn.example/x.png') })).resolves.toBeTruthy();
    await expect(fetchImageBytes('http://localhost:8080/x.png', { fetchImpl: ok('http://127.0.0.1:8080/y.png') })).resolves.toBeTruthy();
  });

  it('enforces the size cap from content-length and from the stream', async () => {
    const big = vi.fn(async () => response('x', { headers: { 'content-length': '999' } }));
    await expect(fetchImageBytes('https://a.example/x', { fetchImpl: big, maxBytes: 100 })).rejects.toThrow('20 MB');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(30));
        c.close();
      },
    });
    const streamed = vi.fn(async () => response(stream));
    await expect(fetchImageBytes('https://a.example/x', { fetchImpl: streamed, maxBytes: 100 })).rejects.toThrow('20 MB');
  });

  it('accepts a body exactly at the cap', async () => {
    const fetchImpl = vi.fn(async () => response(new Uint8Array(100)));
    expect((await fetchImageBytes('https://a.example/x', { fetchImpl, maxBytes: 100 })).bytes.byteLength).toBe(100);
  });

  it('times out', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    ) as unknown as typeof fetch;
    await expect(fetchImageBytes('https://a.example/x', { fetchImpl, timeoutMs: 10 })).rejects.toThrow('超时');
  });

  it('reports HTTP errors and refuses other protocols', async () => {
    await expect(fetchImageBytes('https://a.example/x', { fetchImpl: vi.fn(async () => response('', { status: 403 })) })).rejects.toThrow('HTTP 403');
    await expect(fetchImageBytes('file:///etc/passwd', { fetchImpl: vi.fn() })).rejects.toThrow('不支持');
  });
});

describe('mapLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 4, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 8, 4, 6, 0]);
    expect(peak).toBe(4);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
