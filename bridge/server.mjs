// Local agent bridge: HTTP API for agents, WebSocket endpoint for the extension background.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { tokenMatches } from './token.mjs';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 17345;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

const HOST = '127.0.0.1';
const DRAFT_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15 * 1000;
const PING_INTERVAL_MS = 20 * 1000;
const HELLO_TIMEOUT_MS = 5 * 1000;

/** Error codes the extension may return, mapped to HTTP statuses. */
const CODE_STATUS = { 'bad-request': 400, busy: 409 };

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {number} [opts.port] 0 = random
 * @param {string} opts.version
 * @param {() => Promise<(markdown: string, options?: object) => unknown>} opts.loadConvert
 * @param {(line: string) => void} [opts.log]
 * @param {{ draft?: number, command?: number, ping?: number, hello?: number }} [opts.timeouts]
 */
export function createBridgeServer(opts) {
  const { token, version, loadConvert } = opts;
  const log = opts.log ?? (() => {});
  const t = {
    draft: opts.timeouts?.draft ?? DRAFT_TIMEOUT_MS,
    command: opts.timeouts?.command ?? COMMAND_TIMEOUT_MS,
    ping: opts.timeouts?.ping ?? PING_INTERVAL_MS,
    hello: opts.timeouts?.hello ?? HELLO_TIMEOUT_MS,
  };

  /** @type {import('ws').WebSocket | null} */
  let ext = null;
  let draftInFlight = false;
  /** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  function rejectAll(err) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
      pending.delete(id);
    }
  }

  function sendCommand(method, params, timeoutMs) {
    if (!ext) return Promise.reject(new BridgeError(503, 'not-connected', 'Extension is not connected to the bridge'));
    const id = randomUUID();
    const socket = ext;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError(504, 'timeout', `Extension did not answer "${method}" within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function onExtensionMessage(msg) {
    if (msg.type === 'pong') return;
    if (msg.type === 'progress') {
      const p = msg.progress;
      if (p && pending.has(msg.id)) log(`  [${p.phase}] ${p.message}${p.total ? ` (${p.current ?? 0}/${p.total})` : ''}`);
      return;
    }
    if (msg.type !== 'response') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else {
      const code = String(msg.error?.code ?? 'error');
      p.reject(new BridgeError(CODE_STATUS[code] ?? 500, code, String(msg.error?.message ?? 'Extension error')));
    }
  }

  // --- WebSocket (extension) ---------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES * 2 });

  wss.on('connection', (socket) => {
    let authed = false;
    let lastSeen = Date.now();
    const helloTimer = setTimeout(() => socket.close(4001, 'hello timeout'), t.hello);
    let pingTimer;

    socket.on('message', (data) => {
      lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!authed) {
        if (msg?.type !== 'hello') return socket.close(4001, 'expected hello');
        if (!tokenMatches(token, msg.token)) {
          log('extension rejected: bad token');
          return socket.close(4003, 'bad token');
        }
        if (msg.protocol !== PROTOCOL_VERSION) {
          log(`extension rejected: protocol ${msg.protocol}, bridge speaks ${PROTOCOL_VERSION}`);
          return socket.close(4004, 'protocol mismatch');
        }
        clearTimeout(helloTimer);
        authed = true;
        if (ext && ext !== socket) ext.close(4000, 'replaced by a newer connection');
        ext = socket;
        log(`extension connected (v${String(msg.version ?? '')})`);
        socket.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, version }));
        pingTimer = setInterval(() => {
          if (Date.now() - lastSeen > t.ping * 3) return socket.terminate();
          socket.send(JSON.stringify({ type: 'ping' }));
        }, t.ping);
        return;
      }
      if (socket === ext) onExtensionMessage(msg);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      if (socket === ext) {
        ext = null;
        log('extension disconnected');
        rejectAll(new BridgeError(503, 'not-connected', 'Extension disconnected before answering'));
      }
    });
    socket.on('error', () => {});
  });

  // --- HTTP (agents) -----------------------------------------------------

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_BODY_BYTES) return reject(new BridgeError(413, 'too-large', 'Request body exceeds 20 MB'));
      const chunks = [];
      let size = 0;
      const onData = (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // Stop buffering and drain the rest so the 413 can still be delivered.
          req.off('data', onData);
          req.resume();
          reject(new BridgeError(413, 'too-large', 'Request body exceeds 20 MB'));
          return;
        }
        chunks.push(chunk);
      };
      req.on('data', onData);
      req.on('end', () => {
        if (!size) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new BridgeError(400, 'bad-request', 'Body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  function requireObject(body) {
    if (!isObject(body)) throw new BridgeError(400, 'bad-request', 'Body must be a JSON object');
    return body;
  }

  function checkOptions(options) {
    if (options !== undefined && !isObject(options)) throw new BridgeError(400, 'bad-request', '"options" must be an object');
  }

  function validateDraft(body) {
    const { markdown, title, articleId, mode, options } = requireObject(body);
    if (typeof markdown !== 'string' || !markdown.trim()) throw new BridgeError(400, 'bad-request', '"markdown" must be a non-empty string');
    if (title !== undefined && typeof title !== 'string') throw new BridgeError(400, 'bad-request', '"title" must be a string');
    if (articleId !== undefined && (typeof articleId !== 'string' || !/^\d+$/.test(articleId)))
      throw new BridgeError(400, 'bad-request', '"articleId" must be a numeric string');
    if (mode !== undefined && mode !== 'append' && mode !== 'replace') throw new BridgeError(400, 'bad-request', '"mode" must be "append" or "replace"');
    if (mode !== undefined && articleId === undefined) throw new BridgeError(400, 'bad-request', '"mode" requires "articleId"');
    checkOptions(options);
    return { markdown, title, articleId, mode: articleId ? (mode ?? 'append') : undefined, options };
  }

  const routes = {
    'GET /v1/status': async () => {
      let extension = null;
      if (ext) extension = await sendCommand('status', {}, t.command).catch(() => null);
      return { bridge: { version, protocol: PROTOCOL_VERSION }, extension };
    },
    'POST /v1/convert': async (req) => {
      const { markdown, options } = requireObject(await readJson(req));
      if (typeof markdown !== 'string') throw new BridgeError(400, 'bad-request', '"markdown" must be a string');
      checkOptions(options);
      const convert = await loadConvert();
      return convert(markdown, options ?? {});
    },
    'POST /v1/drafts': async (req) => {
      const params = validateDraft(await readJson(req));
      // Also guards the prepare phase, before the writer reports busy.
      if (draftInFlight) throw new BridgeError(409, 'busy', 'Another draft is being written');
      draftInFlight = true;
      try {
        log(`draft: ${params.articleId ? `${params.mode} into ${params.articleId}` : 'new'} (${params.markdown.length} chars)`);
        const result = await sendCommand('draft', params, t.draft);
        log(`draft: ${result?.ok ? `ok ${result.url ?? ''}` : `failed: ${result?.error ?? 'unknown'}`}`);
        return result;
      } finally {
        draftInFlight = false;
      }
    },
    'GET /v1/drafts/current': () => sendCommand('snapshot', {}, t.command),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const auth = req.headers.authorization ?? '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!tokenMatches(token, given)) throw new BridgeError(401, 'unauthorized', 'Missing or invalid bearer token');
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new BridgeError(404, 'not-found', `No route ${req.method} ${url.pathname}`);
      sendJson(res, 200, await handler(req));
    } catch (err) {
      const e = err instanceof BridgeError ? err : new BridgeError(500, 'internal', err instanceof Error ? err.message : String(err));
      if (e.status >= 500 && e.status !== 503) log(`${req.method} ${url.pathname}: ${e.code} ${e.message}`);
      if (!res.headersSent) sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      req.resume();
    }
  });
  server.requestTimeout = t.draft + 60_000;

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const origin = String(req.headers.origin ?? '');
    const reject = (status, text) => {
      log(`websocket rejected: ${text}`);
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (pathname !== '/ext') return reject(404, 'Not Found');
    if (!origin.startsWith('chrome-extension://')) return reject(403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return {
    /** Resolves with the bound port. */
    listen(port = opts.port ?? DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
        });
      });
    },
    get connected() {
      return ext !== null;
    },
    close() {
      rejectAll(new BridgeError(503, 'not-connected', 'Bridge is shutting down'));
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
