// Corpus check against a real Hugo blog: BLOG_DIR=~/airepo/blog/content npx vitest run tests/core
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertMarkdown } from '../../src/core';
import type { ArticleDoc } from '../../src/shared/types';

const BLOG_DIR = process.env.BLOG_DIR;

function listMarkdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listMarkdown(full);
    return name.endsWith('.md') ? [full] : [];
  });
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

function countCjk(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of text.match(CJK) ?? []) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return counts;
}

/** Visible source text: front matter, HTML comments and <style>/<script> bodies are not content. */
function sourceText(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    // URLs are not visible text (link destinations, src/href attributes).
    .replace(/\]\((?:[^()\s]|\([^()\s]*\))*\)/g, ']')
    .replace(/\b(?:src|href)\s*=\s*"[^"]*"/gi, '');
}

function outputText(doc: ArticleDoc): string {
  const parts = [doc.title];
  for (const block of doc.blocks) {
    if (block.kind === 'text') parts.push(block.text);
    else if (block.kind === 'markdown') parts.push(block.markdown);
    else if (block.kind === 'latex') parts.push(block.tex);
    else if (block.kind === 'image') parts.push(block.alt, block.fallbackText);
  }
  return parts.join('\n');
}

/** $$ formulas in the source outside fenced code and code spans. */
function dollarFormulas(md: string): string[] {
  const prose = md.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/(`+)[^`]*?\1/g, '');
  return [...prose.matchAll(/\$\$([\s\S]+?)\$\$/g)].map((m) => m[1].trim());
}

/** TeX of LaTeX blocks and of formulas that KaTeX rejected (written as latex code). */
function outputFormulas(doc: ArticleDoc): string[] {
  return doc.blocks.flatMap((b) => {
    if (b.kind === 'latex') return [b.tex];
    if (b.kind === 'markdown' && b.language === 'latex') return [b.markdown.replace(/^`+latex\n|\n`+$/g, '')];
    return [];
  });
}

const RESIDUE: [string, RegExp][] = [
  // `char **argv` is a literal pointer declaration, not an emphasis delimiter.
  ['bold marker', /\*\*(?<![A-Za-z] \*\*(?=[A-Za-z]))/],
  ['link syntax', /\]\(https?:/],
  ['image syntax', /!\[/],
  ['heading marker', /^#{1,6} /m],
  ['display math', /\$\$/],
  ['inline math', /\\\(|\\\)/],
  ['details tag', /<\/?(details|summary)\b/i],
  ['footnote syntax', /\[\^[^\]\s]+\]/],
  ['br tag', /<br\s*\/?>/i],
  ['img tag', /<img\b/i],
  ['alert syntax', /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/],
];

describe.skipIf(!BLOG_DIR)('blog corpus', () => {
  it('converts every post without leftover Markdown syntax or lost text', () => {
    const files = listMarkdown(BLOG_DIR!);
    expect(files.length).toBeGreaterThan(0);
    const residues: string[] = [];
    const lostFormulas: string[] = [];
    let formulas = 0;
    let invalid = 0;
    const retention: { file: string; ratio: number; missing: number }[] = [];

    for (const file of files) {
      const md = readFileSync(file, 'utf8');
      const doc = convertMarkdown(md);
      // The other option combinations must not throw either.
      convertMarkdown(md, { nestedLists: 'flatten', inlineCode: 'plain', embedTweets: false, siteBaseUrl: 'https://example.com', titleFromHeading: false, includeDescription: true });

      const rel = path.relative(BLOG_DIR!, file);
      for (const block of doc.blocks) {
        if (block.kind !== 'text') continue;
        // Inline code keeps its literal content; strip it before looking for syntax.
        const text = block.text.replace(/(`+)[\s\S]*?\1/g, '');
        for (const [name, re] of RESIDUE) {
          if (re.test(text)) residues.push(`${rel}: ${name}: ${JSON.stringify(block.text.slice(0, 120))}`);
        }
      }

      const tex = outputFormulas(doc);
      invalid += doc.warnings.filter((w) => w.code === 'latex-invalid').length;
      for (const formula of dollarFormulas(md)) {
        formulas++;
        if (!tex.includes(formula)) lostFormulas.push(`${rel}: ${JSON.stringify(formula.slice(0, 80))}`);
      }

      const src = countCjk(sourceText(md));
      const out = countCjk(outputText(doc));
      let total = 0;
      let kept = 0;
      for (const [ch, n] of src) {
        total += n;
        kept += Math.min(n, out.get(ch) ?? 0);
      }
      if (total) retention.push({ file: rel, ratio: kept / total, missing: total - kept });
    }

    retention.sort((a, b) => a.ratio - b.ratio);
    console.log(
      `corpus: ${files.length} files; worst CJK retention:\n` +
        retention.slice(0, 5).map((r) => `  ${(r.ratio * 100).toFixed(2)}% (-${r.missing}) ${r.file}`).join('\n'),
    );
    console.log(`corpus: ${formulas} $$ formulas, ${invalid} latex-invalid`);
    expect(residues).toEqual([]);
    expect(lostFormulas).toEqual([]);
    expect(retention.filter((r) => r.ratio < 0.98)).toEqual([]);
  });
});

describe.skipIf(BLOG_DIR)('blog corpus (skipped)', () => {
  it.skip('set BLOG_DIR to a directory of Markdown posts to run the corpus check', () => {});
});
