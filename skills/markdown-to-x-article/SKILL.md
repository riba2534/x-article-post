---
name: markdown-to-x-article
description: Create X (Twitter) Article drafts from Markdown through the local Markdown to X Article Chrome extension and its `xap` bridge (127.0.0.1:17345). Use when the user wants to post, publish, send or sync a Markdown file, blog post or article to X / Twitter as an Article, create or fill an X Article draft, write into an existing X draft, check how Markdown will look on X, or mentions Markdown to X Article, markdown-to-x-article, x-article-post, xap, X Article 草稿. 中文触发：把文章/Markdown 发到 X、发到推特、发成 X 长文、创建 X Article 草稿、写入 X 草稿、同步博客到 X、xap 桥接。Only creates and writes drafts; publishing stays a manual step for the user.
---

# Markdown to X Article

The Markdown to X Article extension converts Markdown (headings, lists, code, tables, LaTeX, Mermaid, images) into X's Article editor and writes it into a **draft**. A small local process, `xap`, exposes an HTTP API on `127.0.0.1:17345`; the extension's background connects to it over WebSocket. You talk only to the HTTP API (or the `xap` CLI).

Scope: create a new draft or write into an existing draft. There is no publish endpoint, and you should not try to publish through the browser either. When the draft is ready, give the user the draft URL and let them review and publish it themselves; X Article publishing is public and hard to undo.

## Prerequisites

Items 1–3 must hold before a draft can be written; item 4 is needed for remote images. Check them in order and tell the user exactly which one is missing; setup steps 1 and 3 need the user.

1. The extension is installed in Chrome (from the project's release zip, loaded on `chrome://extensions`) and the user is logged in to x.com in that browser.
2. The bridge is running: `node xap.mjs serve` (release asset `xap.mjs`, Node ≥ 22; inside the repo `node bridge/xap.mjs serve` or `npm run bridge`). It keeps running in a terminal; start it in the background if you start it yourself. The first run creates the token file `~/.config/x-article-post/token` (mode 0600).
3. The extension is paired: side panel → 设置 → Agent 桥接 → turn it on, URL `ws://127.0.0.1:17345/ext`, Token = output of `xap token`. The user pastes the token; never print it into chat or logs beyond what pairing needs.
4. For Markdown with remote images: side panel → 设置 → 图片 → 「允许读取所有网站图片」 is on. Agent-started writes cannot show Chrome's permission prompt, so without it images and the cover are skipped and listed in `warnings` (`图片未能准备：… Failed to fetch`).

Every HTTP request needs `Authorization: Bearer <token>`; the CLI and `scripts/xap_api.mjs` read the token file automatically.

## Tools

Prefer whichever is available, in this order:

- `xap` CLI (`node <path>/xap.mjs <command>`): `status`, `convert <file.md> [--json]`, `draft <file.md|-> [--title T] [--article-id ID --mode append|replace] [--json]`. Exit codes: 0 success, 1 request failed or the draft returned `ok:false`, 2 usage error.
- `scripts/xap_api.mjs` in this skill (zero-dependency Node): `status`, `current`, `convert <file>`, `draft <file> [--title T] [--article-id ID --mode append|replace]`. Prints the JSON response; same exit codes and error format as the CLI.
- `curl` against the HTTP API, see `references/api.md` for every endpoint, field and error.

Drafts with images can take several minutes (uploads run 10–90 s each). Run draft commands with a timeout of at least 11 minutes, and do not retry while one is still running.

## Workflow

### 1. Check the connection

```bash
node xap.mjs status            # or: node scripts/xap_api.mjs status
```

- Connection refused → the bridge is not running; start `xap serve`.
- `extension: not connected` (`"extension": null` in JSON) → the extension is not paired or Chrome is closed. Ask the user to open Chrome and check 设置 → Agent 桥接 (enabled, URL, token). The extension retries every few seconds and at least once a minute, so re-check after the user confirms.
- `busy: true` → another write is in progress; wait and re-check.

### 2. Preflight the conversion

`convert` runs the converter inside the bridge (the extension is not needed) and returns the `ArticleDoc` that would be written:

```bash
node xap.mjs convert article.md          # summary + warnings
node xap.mjs convert article.md --json   # full ArticleDoc
```

Read `warnings` before writing. They describe what X cannot render and how it was adapted, for example `heading-demoted` (H3+ become bold paragraphs), `inline-code`, `inline-math`, `footnote`, `alert`, `details`, `relative-link`, `html-dropped`, `code-split` (code longer than 10,000 chars split), `latex-invalid`. Report meaningful ones to the user in one or two lines; fix the Markdown only when the user wants that (for example a relative link that needs `options.siteBaseUrl`). Check that `title` is what the user expects; if it is empty, pass `--title`.

Images are not fetched during `convert`; they are prepared by the extension during the draft step, and failures there show up in the draft result.

### 3. Create a new draft

```bash
node xap.mjs draft article.md --title "Optional title override"
```

The extension opens (or reuses) an x.com tab, creates a draft, writes text, uploads images and sets the title and cover. Chrome must stay open and the X tab visible while it runs; ask the user not to close it.

The result is a `WriteResult`:

- `ok: true` → report `url` (`https://x.com/compose/articles/edit/<id>`), `blocksWritten`, `imagesOk`, and any `imagesFailed` / `warnings`. Remind the user to review and publish in X themselves.
- `ok: false` → report `error`. A draft may already exist (check `url`/`articleId`); prefer writing into it with `--mode replace` over creating another one.

### 4. Write into an existing draft

Use this when the user gives a draft URL or id, or after a partial failure. The id is the number in `https://x.com/compose/articles/edit/<id>`.

```bash
node xap.mjs draft article.md --article-id 1234567890 --mode append    # add to the end
node xap.mjs draft article.md --article-id 1234567890 --mode replace   # overwrite the body
```

`replace` discards the current draft body. Use it only when the user asked to overwrite or when you are redoing a draft you just created; otherwise use `append` or ask.

To find the draft that is open in the browser right now: `node scripts/xap_api.mjs current` → `{articleId?, url?, editorReady}`.

## Errors

HTTP errors are `{"error":{"code","message"}}`; the CLI and `scripts/xap_api.mjs` print `error <status> <code>: <message>` to stderr and exit 1.

| Status | Code | Meaning | What to do |
|---|---|---|---|
| — | bridge-down / ECONNREFUSED | Bridge not running | Start `xap serve` |
| 400 | bad-request | Invalid body (empty markdown, `mode` without `articleId`, non-numeric `articleId`) | Fix the request |
| 401 | unauthorized | Missing or wrong token | Re-read `~/.config/x-article-post/token`; if the user rotated it, re-pair the extension |
| 409 | busy | Another write is running | Wait for it to finish (`status` → `busy:false`), then retry once |
| 413 | too-large | Body over 20 MB | Shrink the Markdown (inline data: images are the usual cause) |
| 500 | prepare-failed / internal | Pipeline or extension error | Report the message; retry once only if it looks transient |
| 503 | not-connected | Extension not connected, or disconnected mid-write | Ask the user to open Chrome / check pairing; for a mid-write drop, check `current` before retrying so you do not create a duplicate draft |
| 504 | timeout | No answer within 10 minutes (drafts) or 15 s (status) | Check `current` and the X tab; the draft may be partially written |

Do not loop on retries. One retry for 409 or a transient 500 is enough; otherwise stop and tell the user what happened.

## Boundaries

- Drafts only. Never click Publish, never call X's GraphQL or private APIs, never automate x.com directly; the extension is the only writer.
- The bridge listens on 127.0.0.1 only. Do not expose it (no tunnels, no `0.0.0.0` proxies).
- Treat the token like a password: read it from the file, do not paste it into commits, issues or chat.
- One write at a time. Sequential writes for several articles are fine; parallel writes return 409.

## Reference

- `references/api.md` — endpoints, request and response shapes, `ConvertOptions`, `WriteResult`, curl examples.
- `scripts/xap_api.mjs` — dependency-free client for the API.
