# xap bridge HTTP API

Base URL `http://127.0.0.1:17345` (change with `xap serve --port N`; clients read `XAP_PORT`). JSON in and out. Every request needs `Authorization: Bearer <token>` where the token is the content of `~/.config/x-article-post/token`.

```bash
TOKEN=$(cat ~/.config/x-article-post/token)
H="Authorization: Bearer $TOKEN"
```

Errors always look like `{"error":{"code":"busy","message":"..."}}`.

| Status | Code | When |
|---|---|---|
| 400 | bad-request | Invalid JSON or fields |
| 401 | unauthorized | Missing or wrong token (checked before routing) |
| 404 | not-found | Unknown route |
| 409 | busy | A draft is already being written |
| 413 | too-large | Body over 20 MB |
| 500 | prepare-failed, internal | Pipeline or extension failure |
| 503 | not-connected | Extension not connected, or it disconnected before answering |
| 504 | timeout | Extension did not answer (drafts: 10 min, other commands: 15 s) |

## GET /v1/status

```bash
curl -s -H "$H" http://127.0.0.1:17345/v1/status
```

```json
{
  "bridge": { "version": "1.0.0", "protocol": 1 },
  "extension": {
    "version": "1.0.0",
    "bridge": { "enabled": true, "connected": true, "url": "ws://127.0.0.1:17345/ext" },
    "xTab": { "tabId": 12, "url": "https://x.com/compose/articles/edit/123", "articleId": "123", "editorReady": true },
    "busy": false
  }
}
```

`extension` is `null` when no extension is connected. `xTab` is `null` when no X tab is open.

## POST /v1/convert

Runs the converter in the bridge; the extension is not needed. Body: `{"markdown": string, "options"?: Partial<ConvertOptions>}`. Returns an `ArticleDoc`.

```bash
jq -n --rawfile md article.md '{markdown:$md}' |
  curl -s -H "$H" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:17345/v1/convert
```

`ArticleDoc`:

```ts
{
  title: string;
  cover?: string;              // front matter featured_image / cover / image
  description?: string;
  blocks: Block[];             // text | markdown (code/table/list) | latex | divider | tweet | image
  warnings: { code: string; message: string; line?: number }[];
  stats: { blocks, images, mermaid, codeBlocks, tables, latex, tweets, characters };
}
```

`ConvertOptions` (all optional in requests):

| Field | Default | Meaning |
|---|---|---|
| `siteBaseUrl` | `""` | Base for relative links, e.g. `https://blog.example.com`; empty keeps link text only |
| `inlineCode` | `"backtick"` | `backtick` keeps backticks, `plain` writes plain text |
| `includeDescription` | `false` | Insert front matter `description` as a leading quote |
| `titleFromHeading` | `true` | Use the first H1 as title when front matter has none |
| `nestedLists` | `"markdown"` | `markdown` keeps nesting in a Markdown block, `flatten` flattens |
| `embedTweets` | `true` | Single-line x.com status links become embedded posts |

Warning codes: `heading-demoted`, `inline-code`, `inline-math`, `nested-list`, `html-dropped`, `html-converted`, `footnote`, `alert`, `details`, `anchor-link`, `relative-link`, `image-unsupported`, `code-split`, `latex-invalid`, `other`.

## POST /v1/drafts

Writes a draft through the extension. Body (`DraftParams`):

```ts
{
  markdown: string;                 // required, non-empty
  title?: string;                   // overrides the converted title
  articleId?: string;               // numeric id of an existing draft; omit to create a new one
  mode?: 'append' | 'replace';      // only with articleId; default append
  options?: Partial<ConvertOptions>;
}
```

```bash
jq -n --rawfile md article.md --arg title "My title" '{markdown:$md, title:$title}' |
  curl -s --max-time 660 -H "$H" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:17345/v1/drafts
```

The request blocks until the write finishes (up to 10 minutes) and returns a `WriteResult`:

```ts
{
  ok: boolean;
  runId: string;
  articleId?: string;
  url?: string;                     // https://x.com/compose/articles/edit/<id>
  blocksWritten: number;
  imagesOk: number;
  imagesFailed: { imageId: string; error: string }[];
  titleSet: boolean;
  coverSet: boolean;
  warnings: string[];
  error?: string;                   // set when ok is false
}
```

A write that ran but failed returns HTTP 200 with `ok:false`; only transport and state problems use the error statuses above. Only one draft request runs at a time; a second one gets 409.

## GET /v1/drafts/current

The draft open in the browser's X tab.

```bash
curl -s -H "$H" http://127.0.0.1:17345/v1/drafts/current
# {"articleId":"123","url":"https://x.com/compose/articles/edit/123","editorReady":true}
```

Returns `{"editorReady": false}` when no X tab is open.

## Extension WebSocket (for reference)

`ws://127.0.0.1:17345/ext`, used only by the extension. The handshake requires an `Origin: chrome-extension://…` header; the first message must be `{"type":"hello","token","protocol":1,"version"}`. Wrong token closes with 4003, wrong protocol with 4004, missing hello within 5 s with 4001. A newer connection replaces the older one (4000). The bridge sends `{"type":"ping"}` every 20 s; the extension answers `{"type":"pong"}`.
