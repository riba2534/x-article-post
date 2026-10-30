// Shared contracts between the converter, the side panel/pipeline, the writer and the agent bridge.
// Leader-owned: change only through the integration branch.

/** Inline styles X Article keeps server-side. CODE/UNDERLINE are dropped by X, so they never appear here. */
export type InlineStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH';

/** Offsets and lengths are in UTF-16 code units, the same unit Draft.js uses. */
export interface StyleRange {
  offset: number;
  length: number;
  style: InlineStyle;
}

export interface LinkRange {
  offset: number;
  length: number;
  url: string;
}

/** Text block types X Article renders natively (verified 2026-10-30). */
export type TextBlockType =
  | 'header-one'
  | 'header-two'
  | 'unstyled'
  | 'blockquote'
  | 'unordered-list-item'
  | 'ordered-list-item';

export interface TextBlock {
  kind: 'text';
  type: TextBlockType;
  /** May contain '\n' for soft line breaks inside the block. */
  text: string;
  styles: StyleRange[];
  links: LinkRange[];
}

/**
 * Rendered by X through its MARKDOWN entity: fenced code (highlight.js names), GFM tables,
 * nested lists, `$$` math. Max MARKDOWN_BLOCK_LIMIT characters.
 */
export interface MarkdownBlock {
  kind: 'markdown';
  role: 'code' | 'table' | 'list' | 'other';
  markdown: string;
  /** For role 'code': highlight.js language ('' = plain text). */
  language?: string;
}

/** X LATEX entity; `tex` becomes the atomic block text and X renders it with KaTeX (display mode). */
export interface LatexBlock {
  kind: 'latex';
  tex: string;
}

export interface DividerBlock {
  kind: 'divider';
}

export interface TweetBlock {
  kind: 'tweet';
  tweetId: string;
  url: string;
}

export type ImageSource =
  /** http(s) URL or data: URI. */
  | { type: 'url'; url: string }
  /** Mermaid source to render to PNG. */
  | { type: 'mermaid'; code: string }
  /** Markdown table to render to PNG (used when cells contain images). */
  | { type: 'table'; markdown: string };

export interface ImageBlock {
  kind: 'image';
  source: ImageSource;
  alt: string;
  /** Text written instead when the image cannot be prepared or uploaded. */
  fallbackText: string;
}

export type Block = TextBlock | MarkdownBlock | LatexBlock | DividerBlock | TweetBlock | ImageBlock;

export type WarningCode =
  | 'heading-demoted'
  | 'inline-code'
  | 'inline-math'
  | 'nested-list'
  | 'html-dropped'
  | 'html-converted'
  | 'footnote'
  | 'alert'
  | 'details'
  | 'anchor-link'
  | 'relative-link'
  | 'image-unsupported'
  | 'code-split'
  | 'latex-invalid'
  | 'other';

export interface Warning {
  code: WarningCode;
  message: string;
  /** 1-based source line when known. */
  line?: number;
}

export interface ConvertStats {
  blocks: number;
  images: number;
  mermaid: number;
  codeBlocks: number;
  tables: number;
  latex: number;
  tweets: number;
  characters: number;
}

export interface ArticleDoc {
  title: string;
  /** Cover image URL or data: URI (front matter featured_image/cover/image). */
  cover?: string;
  description?: string;
  blocks: Block[];
  warnings: Warning[];
  stats: ConvertStats;
}

export interface ConvertOptions {
  /** Base for relative links, e.g. https://blog.riba2534.cn. Empty = keep text only. */
  siteBaseUrl: string;
  /** How inline code is written: keep backticks or plain text. */
  inlineCode: 'backtick' | 'plain';
  /** Insert front matter description as a leading blockquote. */
  includeDescription: boolean;
  /** Use the first H1 as title when front matter has none; drop body H1 equal to the title. */
  titleFromHeading: boolean;
  /** Render nested lists with a MARKDOWN block (keeps nesting) instead of flattening. */
  nestedLists: 'markdown' | 'flatten';
  /** Turn single-line x.com/twitter.com status links into embedded posts. */
  embedTweets: boolean;
}

export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = {
  siteBaseUrl: '',
  inlineCode: 'backtick',
  includeDescription: false,
  titleFromHeading: true,
  nestedLists: 'markdown',
  embedTweets: true,
};

/** X flag responsive_web_twitter_article_markdown_block_limit (10) * 1000. */
export const MARKDOWN_BLOCK_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Write request: what the pipeline hands to the writer after images are ready.

export interface PreparedImage {
  id: string;
  base64: string;
  mime: string;
  fileName: string;
  width?: number;
  height?: number;
}

export type WriteBlock =
  | TextBlock
  | MarkdownBlock
  | LatexBlock
  | DividerBlock
  | TweetBlock
  | { kind: 'image'; imageId: string; alt: string; fallbackText: string };

export type WriteTarget =
  /** Create a new draft. */
  | { type: 'new' }
  /** Write into an existing draft. */
  | { type: 'existing'; articleId: string; mode: 'append' | 'replace' };

export interface WriteRequest {
  runId: string;
  title: string;
  blocks: WriteBlock[];
  images: Record<string, PreparedImage>;
  /** Image id to set as the article cover. */
  coverImageId?: string;
  target: WriteTarget;
}

export type WritePhase = 'prepare' | 'tab' | 'text' | 'title' | 'image' | 'cover' | 'cleanup' | 'done' | 'error';

export interface WriteProgress {
  runId: string;
  phase: WritePhase;
  message: string;
  current?: number;
  total?: number;
}

export interface WriteResult {
  ok: boolean;
  runId: string;
  articleId?: string;
  /** https://x.com/compose/articles/edit/<id> */
  url?: string;
  blocksWritten: number;
  imagesOk: number;
  imagesFailed: { imageId: string; error: string }[];
  titleSet: boolean;
  coverSet: boolean;
  warnings: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Extension runtime messages (side panel <-> background <-> content script).

export type RuntimeMessage =
  | { type: 'xap:write'; request: WriteRequest }
  | { type: 'xap:cancel'; runId: string }
  | { type: 'xap:progress'; progress: WriteProgress }
  | { type: 'xap:result'; result: WriteResult }
  | { type: 'xap:status' }
  /** Background -> offscreen: run the pipeline for an agent request. */
  | { type: 'xap:prepare'; requestId: string; markdown: string; options: Partial<ConvertOptions>; target: WriteTarget; title?: string };

export interface ExtensionStatus {
  version: string;
  bridge: { enabled: boolean; connected: boolean; url: string };
  xTab: { tabId: number; url: string; articleId?: string; editorReady: boolean } | null;
  busy: boolean;
}

// ---------------------------------------------------------------------------
// Agent bridge protocol (WebSocket between the local `xap` bridge and the extension background).

export const BRIDGE_DEFAULT_PORT = 17345;
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Bridge -> extension. */
export interface BridgeCommand {
  id: string;
  method: 'status' | 'draft' | 'snapshot';
  params: Record<string, unknown>;
}

/** Extension -> bridge. */
export type BridgeMessage =
  | { type: 'hello'; token: string; protocol: number; version: string }
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: { code: string; message: string } }
  | { type: 'progress'; id: string; progress: WriteProgress };

/** `draft` params (also the body of POST /v1/drafts). */
export interface DraftParams {
  markdown: string;
  title?: string;
  /** Existing draft id; omit to create a new draft. */
  articleId?: string;
  mode?: 'append' | 'replace';
  options?: Partial<ConvertOptions>;
}
