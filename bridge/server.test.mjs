import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createBridgeServer, PROTOCOL_VERSION } from './server.mjs';
import { ensureToken, maskToken, readToken, tokenMatches } from './token.mjs';
import { callApi } from './client.mjs';
import { main } from './cli.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const TMP = '/tmp/bridge';
await mkdir(TMP, { recursive: true });

let server;
let port;
const fakeConvert = (markdown, options) => ({ title: 'T', blocks: [], warnings: [{ code: 'other', message: markdown }], options });

async function start(timeouts) {
  server = createBridgeServer({ token: TOKEN, version: '9.9.9', loadConvert: async () => fakeConvert, timeouts });
  port = await server.listen(0);
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function api(method, pathname, body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }).then(
    async (res) => ({ status: res.status, body: await res.json() }),
  );
}

/** Fake extension background. `handler(cmd, ws)` answers commands. */
function connectExtension({ origin = ORIGIN, token = TOKEN, protocol = PROTOCOL_VERSION, handler } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, origin ? { origin } : {});
  const messages = [];
  const result = new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, protocol, version: '1.2.3' })));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      messages.push(msg);
      if (msg.type === 'welcome') resolve({ welcome: true });
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (msg.method && handler) handler(msg, ws);
    });
    ws.on('close', (code, reason) => resolve({ closed: true, code, reason: String(reason) }));
    ws.on('unexpected-response', (_req, res) => resolve({ rejected: true, status: res.statusCode }));
    ws.on('error', () => {});
  });
  return { ws, messages, result };
}

const respond = (ws, id, result) => ws.send(JSON.stringify({ type: 'response', id, ok: true, result }));

describe('HTTP auth', () => {
  beforeEach(() => start());

  it('rejects requests without a token', async () => {
    const res = await api('GET', '/v1/status', undefined, null);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects a wrong token on every route', async () => {
    for (const [m, p] of [['GET', '/v1/status'], ['POST', '/v1/convert'], ['POST', '/v1/drafts'], ['GET', '/v1/drafts/current'], ['GET', '/nope']]) {
      expect((await api(m, p, m === 'POST' ? { markdown: 'x' } : undefined, 'wrong')).status).toBe(401);
    }
    expect((await api('GET', '/v1/status', undefined, TOKEN + 'x')).status).toBe(401);
  });

  it('answers 404 for unknown routes with a valid token', async () => {
    expect((await api('GET', '/v1/unknown')).status).toBe(404);
  });
});

describe('HTTP without extension', () => {
  beforeEach(() => start());

  it('reports status with extension null', async () => {
    const res = await api('GET', '/v1/status');
    expect(res).toEqual({ status: 200, body: { bridge: { version: '9.9.9', protocol: PROTOCOL_VERSION }, extension: null } });
  });

  it('converts in Node without the extension', async () => {
    const res = await api('POST', '/v1/convert', { markdown: '# hi', options: { embedTweets: false } });
    expect(res.status).toBe(200);
    expect(res.body.warnings[0].message).toBe('# hi');
    expect(res.body.options).toEqual({ embedTweets: false });
  });

  it('validates input with 400', async () => {
    expect((await api('POST', '/v1/convert', '{bad json')).status).toBe(400);
    expect((await api('POST', '/v1/convert', { markdown: 1 })).status).toBe(400);
    expect((await api('POST', '/v1/convert', [1])).status).toBe(400);
    expect((await api('POST', '/v1/drafts', { markdown: '' })).status).toBe(400);
    expect((await api('POST', '/v1/drafts', { markdown: 'x', mode: 'append' })).status).toBe(400);
    expect((await api('POST', '/v1/drafts', { markdown: 'x', articleId: 'abc' })).status).toBe(400);
    expect((await api('POST', '/v1/drafts', { markdown: 'x', articleId: '1', mode: 'publish' })).status).toBe(400);
  });

  it('rejects bodies over 20 MB with 413', async () => {
    const res = await api('POST', '/v1/convert', { markdown: 'a'.repeat(21 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('too-large');
  });

  it('answers 503 for drafts and snapshot', async () => {
    const draft = await api('POST', '/v1/drafts', { markdown: '# hi' });
    expect(draft.status).toBe(503);
    expect(draft.body.error.code).toBe('not-connected');
    expect((await api('GET', '/v1/drafts/current')).status).toBe(503);
  });
});

describe('WebSocket handshake', () => {
  beforeEach(() => start({ hello: 500 }));

  it('rejects a non chrome-extension Origin', async () => {
    expect(await connectExtension({ origin: 'https://evil.example' }).result).toEqual({ rejected: true, status: 403 });
    expect(server.connected).toBe(false);
  });

  it('rejects a missing Origin', async () => {
    expect(await connectExtension({ origin: null }).result).toEqual({ rejected: true, status: 403 });
  });

  it('rejects a wrong token', async () => {
    expect(await connectExtension({ token: 'wrong' }).result).toMatchObject({ closed: true, code: 4003 });
    expect(server.connected).toBe(false);
  });

  it('rejects a protocol mismatch', async () => {
    expect(await connectExtension({ protocol: 99 }).result).toMatchObject({ closed: true, code: 4004 });
  });

  it('closes when no hello arrives', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin: ORIGIN });
    const code = await new Promise((resolve) => ws.on('close', resolve));
    expect(code).toBe(4001);
  });

  it('accepts a valid hello and keeps only the newest connection', async () => {
    const first = connectExtension();
    expect(await first.result).toEqual({ welcome: true });
    const firstClosed = new Promise((resolve) => first.ws.on('close', resolve));
    const second = connectExtension();
    expect(await second.result).toEqual({ welcome: true });
    expect(await firstClosed).toBe(4000);
    expect(server.connected).toBe(true);
    second.ws.close();
  });
});

describe('forwarding to the extension', () => {
  it('forwards status and snapshot', async () => {
    await start();
    const ext = connectExtension({
      handler: (cmd, ws) => respond(ws, cmd.id, cmd.method === 'status' ? { version: '1.2.3', busy: false } : { articleId: '42', editorReady: true }),
    });
    await ext.result;
    expect((await api('GET', '/v1/status')).body.extension).toEqual({ version: '1.2.3', busy: false });
    expect((await api('GET', '/v1/drafts/current')).body).toEqual({ articleId: '42', editorReady: true });
    ext.ws.close();
  });

  it('forwards a draft with progress and returns the WriteResult', async () => {
    await start();
    let received;
    const ext = connectExtension({
      handler: (cmd, ws) => {
        received = cmd;
        ws.send(JSON.stringify({ type: 'progress', id: cmd.id, progress: { runId: 'r', phase: 'text', message: 'writing' } }));
        respond(ws, cmd.id, { ok: true, runId: 'r', url: 'https://x.com/compose/articles/edit/1' });
      },
    });
    await ext.result;
    const res = await api('POST', '/v1/drafts', { markdown: '# hi', articleId: '1' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://x.com/compose/articles/edit/1');
    expect(received.method).toBe('draft');
    expect(received.params).toMatchObject({ markdown: '# hi', articleId: '1', mode: 'append' });
    ext.ws.close();
  });

  it('answers 409 while a draft is in flight and maps extension busy to 409', async () => {
    await start();
    let first;
    const ext = connectExtension({
      handler: (cmd, ws) => {
        if (!first) first = cmd;
        else ws.send(JSON.stringify({ type: 'response', id: cmd.id, ok: false, error: { code: 'busy', message: 'busy' } }));
      },
    });
    await ext.result;
    const pending = api('POST', '/v1/drafts', { markdown: 'a' });
    await vi.waitFor(() => expect(first).toBeDefined());
    const second = await api('POST', '/v1/drafts', { markdown: 'b' });
    expect(second.status).toBe(409);
    respond(ext.ws, first.id, { ok: true });
    expect((await pending).status).toBe(200);
    const third = await api('POST', '/v1/drafts', { markdown: 'c' });
    expect(third).toEqual({ status: 409, body: { error: { code: 'busy', message: 'busy' } } });
    ext.ws.close();
  });

  it('answers 504 when the extension does not answer in time', async () => {
    await start({ draft: 200 });
    const ext = connectExtension({ handler: () => {} });
    await ext.result;
    const res = await api('POST', '/v1/drafts', { markdown: 'a' });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('timeout');
    ext.ws.close();
  });

  it('answers 503 when the extension disconnects mid-draft', async () => {
    await start();
    const ext = connectExtension({ handler: (_cmd, ws) => ws.close() });
    await ext.result;
    const res = await api('POST', '/v1/drafts', { markdown: 'a' });
    expect(res.status).toBe(503);
  });

  it('pings the extension', async () => {
    await start({ ping: 50 });
    const ext = connectExtension({ handler: () => {} });
    await ext.result;
    await vi.waitFor(() => expect(ext.messages.some((m) => m.type === 'ping')).toBe(true));
    ext.ws.close();
  });
});

describe('token file', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(TMP, 'token-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('creates a 0600 token once and reuses it', async () => {
    const file = path.join(dir, 'nested', 'token');
    const a = await ensureToken(file);
    expect(a.created).toBe(true);
    expect(a.token.length).toBeGreaterThanOrEqual(40);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const b = await ensureToken(file);
    expect(b).toEqual({ token: a.token, created: false });
    expect(await readToken(path.join(dir, 'missing'))).toBeNull();
  });

  it('tightens permissions of an existing token file', async () => {
    const file = path.join(dir, 'token');
    await writeFile(file, 'abc\n', { mode: 0o644 });
    expect((await ensureToken(file)).token).toBe('abc');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('compares and masks tokens', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', '')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
    expect(maskToken(TOKEN)).not.toContain(TOKEN.slice(4, -2));
  });
});

describe('CLI and client', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(TMP, 'cli-'));
    vi.stubEnv('XAP_TOKEN_FILE', path.join(dir, 'token'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a stopped bridge clearly', async () => {
    await expect(callApi({ port: 1, token: 'x', method: 'GET', path: '/v1/status' })).rejects.toMatchObject({ code: 'bridge-down' });
  });

  it('runs token, status, convert and draft against a live server', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['token'])).toBe(0);
    const token = out.mock.calls[0][0];
    server = createBridgeServer({ token, version: '9.9.9', loadConvert: async () => fakeConvert });
    port = await server.listen(0);
    const md = path.join(dir, 'a.md');
    await writeFile(md, '# hello');

    expect(await main(['status', '--port', String(port), '--json'])).toBe(0);
    expect(JSON.parse(out.mock.calls.at(-1)[0]).extension).toBeNull();
    expect(await main(['convert', md, '--port', String(port)])).toBe(0);
    expect(out.mock.calls.map((c) => c[0]).join('\n')).toContain('# hello');
    expect(await main(['draft', md, '--port', String(port)])).toBe(1);
    expect(err.mock.calls.at(-1)[0]).toContain('not-connected');
    expect(await main(['draft', md, '--mode', 'replace', '--port', String(port)])).toBe(1);
    expect(await main(['nope'])).toBe(1);
  });
});
