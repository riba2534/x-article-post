// Remote image download with the limits the pipeline promises: no cookies, size cap, timeout,
// and no redirects from a public host into a private network.

const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
export const FETCH_CONCURRENCY = 4;

export interface FetchedBytes {
  bytes: Uint8Array;
  contentType: string;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** True for loopback, link-local, private and other non-public hosts (hostname as produced by URL). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIPv4(h);
  if (!h.includes(':')) return false;
  if (h === '::' || h === '::1') return true;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return isPrivateIPv4(dotted[1]);
  // WHATWG URL serializes ::ffff:127.0.0.1 as ::ffff:7f00:1.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

const TOO_LARGE = '图片超过 20 MB';

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(TOO_LARGE);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(TOO_LARGE);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

export async function fetchImageBytes(url: string, opts: FetchOptions = {}): Promise<FetchedBytes> {
  const { fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES } = opts;
  const parsed = new URL(url);
  if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) throw new Error(`不支持的图片地址：${parsed.protocol}`);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, {
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: ctrl.signal,
    });
    // Extension pages cannot read Location with redirect:'manual', so the final URL is checked
    // before the body is read.
    if (res.redirected && parsed.protocol !== 'data:' && !isPrivateHost(parsed.hostname) && isPrivateHost(new URL(res.url).hostname)) {
      ctrl.abort();
      throw new Error('图片地址重定向到了内网地址');
    }
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    if (Number(res.headers.get('content-length')) > maxBytes) throw new Error(TOO_LARGE);
    const bytes = await readLimited(res, maxBytes);
    return { bytes, contentType: res.headers.get('content-type') ?? '' };
  } catch (err) {
    if (timedOut) throw new Error('下载超时（30 秒）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Promise.all with at most `limit` tasks in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
