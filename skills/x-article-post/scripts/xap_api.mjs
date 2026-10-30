#!/usr/bin/env node
// Zero-dependency client for the local x-article-post bridge (Node >= 18).
// Usage:
//   node xap_api.mjs status
//   node xap_api.mjs convert <file.md|->
//   node xap_api.mjs draft <file.md|-> [--title T] [--article-id ID] [--mode append|replace]
//   node xap_api.mjs current
// Env: XAP_PORT (default 17345), XAP_TOKEN (else read from XAP_TOKEN_FILE or ~/.config/x-article-post/token).
// Prints the JSON response. Exit codes (same as the xap CLI): 0 ok, 1 request failed or
// WriteResult ok:false, 2 usage error. Errors go to stderr as "error <status> <code>: <message>".
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positionals = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else positionals.push(rest[i]);
}

function fail(code, message, status) {
  console.error(status ? `error ${status} ${code}: ${message}` : `error ${code}: ${message}`);
  process.exit(1);
}

function usage(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function token() {
  if (process.env.XAP_TOKEN) return process.env.XAP_TOKEN.trim();
  const file = process.env.XAP_TOKEN_FILE || path.join(os.homedir(), '.config', 'x-article-post', 'token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return usage(`No token at ${file}. Start the bridge once with "xap serve".`);
  }
}

function markdownInput() {
  const file = positionals[0];
  if (!file) usage('Missing Markdown file (use "-" for stdin)');
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    return usage(err.message);
  }
}

function call(method, pathname, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const port = Number(process.env.XAP_PORT || 17345);
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { authorization: `Bearer ${token()}`, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 500;
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return fail('bad-response', 'Bridge returned non-JSON', status);
        }
        if (status >= 400) return fail(data?.error?.code ?? 'error', data?.error?.message ?? 'Request failed', status);
        console.log(JSON.stringify(data, null, 2));
        // A draft that ran but failed comes back as 200 with ok:false.
        if (data?.ok === false) process.exitCode = 1;
      });
    },
  );
  // Drafts with images can take several minutes; the bridge itself gives up after 10.
  req.setTimeout(11 * 60 * 1000, () => fail('timeout', 'No answer from the bridge', 504));
  req.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') fail('bridge-down', `Bridge is not running on 127.0.0.1:${port}. Start it with "xap serve".`);
    fail('error', err.message);
  });
  req.end(payload);
}

switch (command) {
  case 'status':
    call('GET', '/v1/status');
    break;
  case 'current':
    call('GET', '/v1/drafts/current');
    break;
  case 'convert':
    call('POST', '/v1/convert', { markdown: markdownInput() });
    break;
  case 'draft': {
    const body = { markdown: markdownInput() };
    if (flags.title) body.title = flags.title;
    if (flags.mode && !flags['article-id']) usage('--mode requires --article-id');
    if (flags.mode && flags.mode !== 'append' && flags.mode !== 'replace') usage('--mode must be append or replace');
    if (flags['article-id']) {
      body.articleId = flags['article-id'];
      body.mode = flags.mode || 'append';
    }
    call('POST', '/v1/drafts', body);
    break;
  }
  default:
    usage('Usage: node xap_api.mjs status | current | convert <file> | draft <file> [--title T] [--article-id ID --mode append|replace]');
}
