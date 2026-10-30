#!/usr/bin/env node
// Zero-dependency client for the local x-article-post bridge (Node >= 18).
// Usage:
//   node xap_api.mjs status
//   node xap_api.mjs convert <file.md|->
//   node xap_api.mjs draft <file.md|-> [--title T] [--article-id ID] [--mode append|replace]
//   node xap_api.mjs current
// Env: XAP_PORT (default 17345), XAP_TOKEN (else read from XAP_TOKEN_FILE or ~/.config/x-article-post/token).
// Prints the JSON response; exits 1 on HTTP errors (body {"error":{code,message}} goes to stderr).
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

function fail(message) {
  console.error(message);
  process.exit(1);
}

function token() {
  if (process.env.XAP_TOKEN) return process.env.XAP_TOKEN.trim();
  const file = process.env.XAP_TOKEN_FILE || path.join(os.homedir(), '.config', 'x-article-post', 'token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return fail(`No token at ${file}. Start the bridge once with "xap serve".`);
  }
}

function markdownInput() {
  const file = positionals[0];
  if (!file) fail('Missing Markdown file (use "-" for stdin)');
  return readFileSync(file === '-' ? 0 : file, 'utf8');
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
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) fail(`HTTP ${res.statusCode} ${text}`);
        console.log(text);
      });
    },
  );
  // Drafts with images can take several minutes; the bridge itself gives up after 10.
  req.setTimeout(11 * 60 * 1000, () => req.destroy(new Error('timed out waiting for the bridge')));
  req.on('error', (err) => fail(err.code === 'ECONNREFUSED' ? `Bridge not running on 127.0.0.1:${port}. Start it with "xap serve".` : err.message));
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
    if (flags['article-id']) {
      body.articleId = flags['article-id'];
      body.mode = flags.mode || 'append';
    }
    call('POST', '/v1/drafts', body);
    break;
  }
  default:
    fail('Usage: node xap_api.mjs status | current | convert <file> | draft <file> [--title T] [--article-id ID --mode append|replace]');
}
