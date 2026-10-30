import type { InlineStyle, LinkRange, StyleRange, TextBlock, TextBlockType } from '../shared/types';

/** Marks a hard line break while building; soft breaks stay '\n' until finish(). */
export const HARD_BREAK = '\u2028';

const STYLES: InlineStyle[] = ['BOLD', 'ITALIC', 'STRIKETHROUGH'];

// East Asian wide characters: soft line breaks between two of them vanish (goldmark eastAsianLineBreaks).
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;

function charBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const code = text.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index >= 2 ? text.slice(index - 2, index) : text[index - 1];
}

function charAt(text: string, index: number): string {
  const cp = text.codePointAt(index);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/** Accumulates inline text with style/link ranges (UTF-16 offsets) for one TextBlock. */
export class TextBuilder {
  text = '';
  private ranges: StyleRange[] = [];
  private links: LinkRange[] = [];
  private openLinks: { offset: number; url: string }[] = [];
  readonly active: Record<InlineStyle, number> = { BOLD: 0, ITALIC: 0, STRIKETHROUGH: 0 };
  /** Written before the first finished segment only (list markers, footnote numbers). */
  prefix = '';

  constructor(public type: TextBlockType) {}

  append(value: string) {
    if (!value) return;
    const offset = this.text.length;
    this.text += value;
    for (const style of STYLES) {
      if (this.active[style] > 0) this.ranges.push({ offset, length: value.length, style });
    }
  }

  push(style: InlineStyle) {
    this.active[style]++;
  }

  pop(style: InlineStyle) {
    if (this.active[style] > 0) this.active[style]--;
  }

  openLink(url: string) {
    this.openLinks.push({ offset: this.text.length, url });
  }

  closeLink() {
    const link = this.openLinks.pop();
    if (link && this.text.length > link.offset) {
      this.links.push({ offset: link.offset, length: this.text.length - link.offset, url: link.url });
    }
  }

  hardBreak() {
    this.append(HARD_BREAK);
  }

  /** True when nothing but whitespace was appended. */
  isBlank(): boolean {
    return !/[^\s\u2028]/.test(this.text);
  }

  /** Start a fresh segment after a block was split out (e.g. an image inside a paragraph). */
  reset(type: TextBlockType = this.type) {
    this.text = '';
    this.ranges = [];
    this.links = [];
    this.type = type;
    // Keep links that are still open so the rest of their text stays linked.
    for (const link of this.openLinks) link.offset = 0;
  }

  /** Resolve soft/hard breaks, trim, and return the finished block (null when empty). */
  finish(): TextBlock | null {
    const src = this.text;
    const map = new Array<number>(src.length + 1);
    let out = '';
    for (let i = 0; i < src.length; ) {
      const ch = src[i];
      if (ch === '\n' || ch === '\r') {
        // Soft break: drop surrounding spaces, then join CJK or insert a space.
        let j = i;
        while (j < src.length && /[\s]/.test(src[j]) && src[j] !== HARD_BREAK) j++;
        let k = out.length;
        while (k > 0 && (out[k - 1] === ' ' || out[k - 1] === '\t')) k--;
        out = out.slice(0, k);
        const prev = charBefore(out, out.length);
        const next = charAt(src, j);
        const joiner = (WIDE.test(prev) && WIDE.test(next)) || !prev || !next || prev === '\n' || next === HARD_BREAK ? '' : ' ';
        for (let x = i; x < j; x++) map[x] = out.length;
        out += joiner;
        i = j;
        continue;
      }
      map[i] = out.length;
      out += ch === HARD_BREAK ? '\n' : ch;
      i++;
    }
    map[src.length] = out.length;

    // Trim whitespace at both ends.
    const lead = out.length - out.replace(/^\s+/, '').length;
    const body = out.trim();
    if (!body) return null;
    const clamp = (n: number) => Math.min(Math.max(n - lead, 0), body.length);
    const remap = <T extends { offset: number; length: number }>(r: T): T => {
      const start = clamp(map[r.offset]);
      const end = clamp(map[r.offset + r.length]);
      return { ...r, offset: start, length: end - start };
    };
    const styles = mergeRanges(this.ranges.map(remap).filter((r) => r.length > 0));
    const links = this.links.map(remap).filter((r) => r.length > 0);
    const prefix = this.prefix;
    this.prefix = '';
    return prefixBlock({ kind: 'text', type: this.type, text: body, styles, links }, prefix);
  }
}

function mergeRanges(ranges: StyleRange[]): StyleRange[] {
  const out: StyleRange[] = [];
  for (const style of STYLES) {
    const list = ranges.filter((r) => r.style === style).sort((a, b) => a.offset - b.offset);
    let cur: StyleRange | null = null;
    for (const r of list) {
      if (cur && r.offset <= cur.offset + cur.length) {
        cur.length = Math.max(cur.length, r.offset + r.length - cur.offset);
      } else {
        cur = { ...r };
        out.push(cur);
      }
    }
  }
  return out.sort((a, b) => a.offset - b.offset || STYLES.indexOf(a.style) - STYLES.indexOf(b.style));
}

/** Prefix a finished block's text, shifting its ranges. */
export function prefixBlock(block: TextBlock, prefix: string): TextBlock {
  if (!prefix) return block;
  const shift = <T extends { offset: number }>(r: T): T => ({ ...r, offset: r.offset + prefix.length });
  return { ...block, text: prefix + block.text, styles: block.styles.map(shift), links: block.links.map(shift) };
}
