// Tiny HTML tokenizer for the raw HTML found in Markdown (no DOM: core must run in Node).

export type HtmlToken =
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean; raw: string }
  | { kind: 'close'; name: string; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'text'; value: string };

const TAG = /<!--[\s\S]*?(?:-->|$)|<\/([A-Za-z][A-Za-z0-9-]*)\s*>|<([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Elements whose content is not rendered text. */
export const RAW_TEXT_TAGS = new Set(['style', 'script', 'textarea', 'title', 'template', 'noscript']);

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let last = 0;
  let lower: string | undefined;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    if (m.index > last) tokens.push({ kind: 'text', value: html.slice(last, m.index) });
    last = TAG.lastIndex;
    if (m[0].startsWith('<!--')) {
      tokens.push({ kind: 'comment', raw: m[0] });
    } else if (m[1]) {
      tokens.push({ kind: 'close', name: m[1].toLowerCase(), raw: m[0] });
    } else {
      const name = m[2].toLowerCase();
      const attrs: Record<string, string> = {};
      ATTR.lastIndex = 0;
      for (let a = ATTR.exec(m[3]); a; a = ATTR.exec(m[3])) {
        attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      }
      tokens.push({ kind: 'open', name, attrs, selfClosing: m[4] === '/', raw: m[0] });
      if (RAW_TEXT_TAGS.has(name)) {
        // Swallow everything up to the matching close tag.
        lower ??= html.toLowerCase();
        const close = lower.indexOf(`</${name}`, last);
        const end = close < 0 ? html.length : html.indexOf('>', close) + 1 || html.length;
        tokens.push({ kind: 'close', name, raw: html.slice(close < 0 ? end : close, end) });
        last = end;
        TAG.lastIndex = end;
      }
    }
  }
  if (last < html.length) tokens.push({ kind: 'text', value: html.slice(last) });
  return tokens;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', divide: '÷',
  deg: '°', plusmn: '±', micro: 'µ', para: '¶', sect: '§', cent: '¢', pound: '£', yen: '¥', euro: '€',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', sum: '∑', minus: '−', radic: '√', zwj: '\u200d', zwnj: '\u200c',
  shy: '', iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', check: '✓',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
  });
}
