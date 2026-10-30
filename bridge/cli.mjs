// `xap` command line: serve the bridge or call its HTTP API.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { callApi, ApiError } from './client.mjs';
import { createBridgeServer, DEFAULT_PORT, PROTOCOL_VERSION } from './server.mjs';
import { ensureToken, maskToken, readToken, tokenPath } from './token.mjs';

/* global __XAP_VERSION__ */
export const VERSION = typeof __XAP_VERSION__ !== 'undefined' ? __XAP_VERSION__ : 'dev';

const HELP = `xap ${VERSION} - local agent bridge for the X Article Post extension (drafts only, never publishes)

Usage:
  xap serve [--port N]            Start the bridge on 127.0.0.1 (default port ${DEFAULT_PORT})
  xap token                       Print the pairing token (creates it if missing)
  xap status [--json]             Show bridge and extension state
  xap convert <file.md> [--json]  Convert Markdown locally and list warnings
  xap draft <file.md|-> [--title T] [--article-id ID --mode append|replace] [--json]
                                  Write Markdown into a new or existing X Article draft

Options:
  --port N    Bridge port (also XAP_PORT; default ${DEFAULT_PORT})
  -h, --help  Show this help

Token file: ${tokenPath()}`;

const OPTIONS = {
  port: { type: 'string' },
  json: { type: 'boolean' },
  title: { type: 'string' },
  'article-id': { type: 'string' },
  mode: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

class UsageError extends Error {}

function parsePort(value) {
  const raw = value ?? process.env.XAP_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port: ${raw}`);
  return port;
}

async function clientToken() {
  const token = await readToken();
  if (!token) throw new UsageError(`No token at ${tokenPath()}. Run "xap serve" once to create it.`);
  return token;
}

async function readInput(file) {
  if (!file) throw new UsageError('Missing Markdown file (use "-" for stdin)');
  if (file !== '-') return readFile(file, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function printDoc(doc) {
  const s = doc.stats ?? {};
  print(`title: ${doc.title || '(none)'}`);
  print(`blocks: ${s.blocks ?? doc.blocks?.length ?? 0}  images: ${s.images ?? 0}  mermaid: ${s.mermaid ?? 0}  code: ${s.codeBlocks ?? 0}  tables: ${s.tables ?? 0}  latex: ${s.latex ?? 0}  tweets: ${s.tweets ?? 0}  chars: ${s.characters ?? 0}`);
  const warnings = doc.warnings ?? [];
  print(warnings.length ? `warnings (${warnings.length}):` : 'warnings: none');
  for (const w of warnings) print(`  - [${w.code}]${w.line ? ` line ${w.line}:` : ''} ${w.message}`);
}

function printResult(r) {
  print(r.ok ? `draft written: ${r.url ?? r.articleId ?? ''}` : `draft failed: ${r.error ?? 'unknown error'}`);
  print(`blocks: ${r.blocksWritten}  images: ${r.imagesOk} ok, ${r.imagesFailed?.length ?? 0} failed  title: ${r.titleSet ? 'set' : 'not set'}  cover: ${r.coverSet ? 'set' : 'not set'}`);
  for (const f of r.imagesFailed ?? []) print(`  image ${f.imageId}: ${f.error}`);
  for (const w of r.warnings ?? []) print(`  warning: ${w}`);
}

/** Loads the converter lazily so client commands do not pay for it. */
const loadConvert = async () => (await import('./convert.mjs')).convertMarkdown;

async function serve(port) {
  const { token, created } = await ensureToken();
  const server = createBridgeServer({
    token,
    version: VERSION,
    loadConvert,
    log: (line) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`),
  });
  const bound = await server.listen(port);
  print(`xap bridge ${VERSION} (protocol ${PROTOCOL_VERSION})`);
  print(`  HTTP API   http://127.0.0.1:${bound}/v1`);
  print(`  Extension  ws://127.0.0.1:${bound}/ext`);
  print(`  Token      ${maskToken(token)} ${created ? '(new) ' : ''}stored in ${tokenPath()}`);
  print('Pair the extension: side panel → 设置 → Agent 桥接 → turn it on,');
  print(`  URL ws://127.0.0.1:${bound}/ext, Token = output of "xap token". Ctrl+C to stop.`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/** Returns the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [command, ...rest] = positionals;
    if (values.version || values.help || !command || command === 'help') {
      print(values.version ? VERSION : HELP);
      return 0;
    }
    const port = parsePort(values.port);

    switch (command) {
      case 'serve':
        await serve(port);
        return 0;
      case 'token':
        print((await ensureToken()).token);
        return 0;
      case 'status': {
        const status = await callApi({ port, token: await clientToken(), method: 'GET', path: '/v1/status', timeoutMs: 30_000 });
        if (values.json) print(status);
        else {
          const ext = status.extension;
          print(`bridge: v${status.bridge.version} protocol ${status.bridge.protocol} on 127.0.0.1:${port}`);
          print(ext ? `extension: connected v${ext.version}${ext.busy ? ' (busy)' : ''}` : 'extension: not connected');
          if (ext) print(ext.xTab ? `x tab: ${ext.xTab.url} editor ${ext.xTab.editorReady ? 'ready' : 'not ready'}` : 'x tab: none');
        }
        return 0;
      }
      case 'convert': {
        const markdown = await readInput(rest[0]);
        const doc = await callApi({ port, token: await clientToken(), method: 'POST', path: '/v1/convert', body: { markdown }, timeoutMs: 60_000 });
        if (values.json) print(doc);
        else printDoc(doc);
        return 0;
      }
      case 'draft': {
        const markdown = await readInput(rest[0]);
        const articleId = values['article-id'];
        if (values.mode && !articleId) throw new UsageError('--mode requires --article-id');
        if (values.mode && values.mode !== 'append' && values.mode !== 'replace') throw new UsageError('--mode must be append or replace');
        const body = { markdown, title: values.title, articleId, mode: articleId ? (values.mode ?? 'append') : undefined };
        const result = await callApi({ port, token: await clientToken(), method: 'POST', path: '/v1/drafts', body });
        if (values.json) print(result);
        else printResult(result);
        return result.ok ? 0 : 1;
      }
      default:
        throw new UsageError(`Unknown command "${command}". Run "xap --help".`);
    }
  } catch (err) {
    if (err instanceof ApiError) console.error(`error ${err.status || ''} ${err.code}: ${err.message}`.replace('  ', ' '));
    else if (err instanceof UsageError || err?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || err?.code === 'ENOENT') console.error(`error: ${err.message}`);
    else console.error(err);
    return 1;
  }
}
