// Executes BridgeCommands from the local `xap` bridge. Pure: every side effect is injected.
import type {
  ArticleDoc,
  BridgeCommand,
  BridgeMessage,
  ConvertOptions,
  DraftParams,
  ExtensionStatus,
  RuntimeMessage,
  WriteProgress,
  WriteRequest,
  WriteResult,
  WriteTarget,
} from '../../shared/types';

const PREPARE_WARNINGS = new Set(['image-unsupported', 'limit']);

export type PrepareMessage = Extract<RuntimeMessage, { type: 'xap:prepare' }>;
export type PrepareReply = { ok: true; request: WriteRequest; doc: ArticleDoc } | { ok: false; error: string };

export interface CommandDeps {
  version: string;
  bridgeStatus(): ExtensionStatus['bridge'];
  isBusy(): boolean;
  getXTabStatus(): Promise<ExtensionStatus['xTab']>;
  ensureOffscreen(): Promise<void>;
  /** Sends `xap:prepare` to the offscreen document. */
  prepare(message: PrepareMessage): Promise<PrepareReply | undefined>;
  runWrite(request: WriteRequest, onProgress: (p: WriteProgress) => void): Promise<WriteResult>;
}

export type Send = (message: BridgeMessage) => void;

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseDraft(params: Record<string, unknown>): DraftParams {
  const { markdown, title, articleId, mode, options } = params;
  if (typeof markdown !== 'string' || !markdown.trim()) throw new CommandError('bad-request', 'markdown must be a non-empty string');
  if (title !== undefined && typeof title !== 'string') throw new CommandError('bad-request', 'title must be a string');
  if (articleId !== undefined && (typeof articleId !== 'string' || !/^\d+$/.test(articleId))) throw new CommandError('bad-request', 'articleId must be a numeric string');
  if (mode !== undefined && mode !== 'append' && mode !== 'replace') throw new CommandError('bad-request', 'mode must be append or replace');
  if (mode !== undefined && articleId === undefined) throw new CommandError('bad-request', 'mode requires articleId');
  if (options !== undefined && !isObject(options)) throw new CommandError('bad-request', 'options must be an object');
  return { markdown, title, articleId, mode, options: options as Partial<ConvertOptions> | undefined };
}

export function createCommandHandler(deps: CommandDeps) {
  async function status(): Promise<ExtensionStatus> {
    return { version: deps.version, bridge: deps.bridgeStatus(), xTab: await deps.getXTabStatus(), busy: deps.isBusy() };
  }

  async function draft(id: string, params: Record<string, unknown>, send: Send): Promise<WriteResult> {
    const p = parseDraft(params);
    if (deps.isBusy()) throw new CommandError('busy', 'The extension is already writing a draft');
    const target: WriteTarget = p.articleId ? { type: 'existing', articleId: p.articleId, mode: p.mode ?? 'append' } : { type: 'new' };
    await deps.ensureOffscreen();
    const reply = await deps.prepare({ type: 'xap:prepare', requestId: id, markdown: p.markdown, options: p.options ?? {}, target, title: p.title });
    if (!reply) throw new CommandError('prepare-failed', 'Offscreen document did not answer xap:prepare');
    if (!reply.ok) throw new CommandError('prepare-failed', reply.error);
    const result = await deps.runWrite(reply.request, (progress) => send({ type: 'progress', id, progress }));
    if (!result.ok && result.error === 'busy') throw new CommandError('busy', 'The extension is already writing a draft');
    // Images that could not be prepared never reach the writer; surface them to the agent too.
    const prepared = reply.doc.warnings.filter((w) => PREPARE_WARNINGS.has(w.code)).map((w) => w.message);
    return prepared.length ? { ...result, warnings: [...prepared, ...result.warnings] } : result;
  }

  async function run(cmd: BridgeCommand, send: Send): Promise<unknown> {
    const params = isObject(cmd.params) ? cmd.params : {};
    switch (cmd.method) {
      case 'status':
        return status();
      case 'draft':
        return draft(cmd.id, params, send);
      case 'snapshot': {
        const tab = await deps.getXTabStatus();
        return tab ? { articleId: tab.articleId, url: tab.url, editorReady: tab.editorReady } : { editorReady: false };
      }
      default:
        throw new CommandError('bad-request', `Unknown method ${String((cmd as { method: unknown }).method)}`);
    }
  }

  /** Runs one command and always answers with exactly one `response`. */
  return async function handle(cmd: BridgeCommand, send: Send): Promise<void> {
    try {
      send({ type: 'response', id: cmd.id, ok: true, result: await run(cmd, send) });
    } catch (err) {
      const code = err instanceof CommandError ? err.code : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      send({ type: 'response', id: cmd.id, ok: false, error: { code, message } });
    }
  };
}
