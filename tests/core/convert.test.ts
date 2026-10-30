import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_BLOCK_LIMIT, type ImageBlock, type LatexBlock, type MarkdownBlock, type TweetBlock } from '../../src/shared/types';
import { blocks, codes, convert, linked, shape, styled, text, textBlocks } from './helpers';

describe('front matter and title', () => {
  it('reads title, cover and description', () => {
    const doc = convert('---\ntitle: "Hello"\nfeatured_image: https://img.example.com/c.png\ndescription: Summary\n---\n\nBody');
    expect(doc.title).toBe('Hello');
    expect(doc.cover).toBe('https://img.example.com/c.png');
    expect(doc.description).toBe('Summary');
    expect(shape(doc.blocks)).toEqual(['unstyled:Body']);
  });

  it('accepts cover/image keys and resolves relative covers', () => {
    expect(convert('---\ncover: /a.png\n---\n', { siteBaseUrl: 'https://blog.example.com' }).cover).toBe('https://blog.example.com/a.png');
    expect(convert('---\nimage: https://x.test/b.png\n---\n').cover).toBe('https://x.test/b.png');
    const doc = convert('---\ncover: a.png\n---\n');
    expect(doc.cover).toBeUndefined();
    expect(codes(doc)).toContain('image-unsupported');
  });

  it('uses the first H1 as title and drops it from the body', () => {
    const doc = convert('# My Title\n\ntext');
    expect(doc.title).toBe('My Title');
    expect(shape(doc.blocks)).toEqual(['unstyled:text']);
  });

  it('drops the body H1 equal to the front matter title only', () => {
    const doc = convert('---\ntitle: T\n---\n# T\n\n# Other\n\nx');
    expect(doc.title).toBe('T');
    expect(shape(doc.blocks)).toEqual(['header-one:Other', 'unstyled:x']);
  });

  it('keeps H1s when titleFromHeading is off', () => {
    const doc = convert('# A\n\nx', { titleFromHeading: false });
    expect(doc.title).toBe('');
    expect(shape(doc.blocks)).toEqual(['header-one:A', 'unstyled:x']);
  });

  it('inserts the description as a leading quote when asked', () => {
    const doc = convert('---\ndescription: D\n---\nx', { includeDescription: true });
    expect(shape(doc.blocks)).toEqual(['blockquote:D', 'unstyled:x']);
  });

  it('survives invalid YAML', () => {
    const doc = convert('---\ntitle: [oops\n---\nx');
    expect(doc.title).toBe('');
    expect(codes(doc)).toContain('other');
  });
});

describe('headings', () => {
  it('maps the highest level present to header-one and the next to header-two', () => {
    const doc = convert('## A\n\n### B\n\n#### C\n\n##### D', { titleFromHeading: false });
    expect(shape(doc.blocks)).toEqual(['header-one:A', 'header-two:B', 'unstyled:C', 'unstyled:D']);
    expect(styled(doc.blocks[2] as never)).toEqual(['BOLD:C']);
    expect(doc.warnings.filter((w) => w.code === 'heading-demoted')).toHaveLength(1);
  });

  it('keeps links and inline styles inside headings', () => {
    const block = text('## See [docs](https://d.test) *now*');
    expect(block.type).toBe('header-one');
    expect(linked(block)).toEqual(['docs->https://d.test']);
    expect(styled(block)).toEqual(['ITALIC:now']);
  });
});

describe('inline styles', () => {
  it('maps bold, italic, bold italic and strikethrough with UTF-16 offsets', () => {
    const block = text('😀 **b** *i* ***bi*** ~~s~~');
    expect(block.text).toBe('😀 b i bi s');
    expect(styled(block)).toEqual(['BOLD:b', 'ITALIC:i', 'BOLD:bi', 'ITALIC:bi', 'STRIKETHROUGH:s']);
    expect(block.styles[0].offset).toBe(3);
  });

  it('recognizes CJK bold next to full-width punctuation', () => {
    const block = text('前文**中文（标点）**紧贴文字，**“引号”**后文');
    expect(block.text).toBe('前文中文（标点）紧贴文字，“引号”后文');
    expect(styled(block)).toEqual(['BOLD:中文（标点）', 'BOLD:“引号”']);
  });

  it('recognizes bold with ASCII punctuation next to CJK', () => {
    expect(styled(text('这是**重点(注意)**内容'))).toEqual(['BOLD:重点(注意)']);
  });

  it('treats ****x**** as bold', () => {
    const block = text('前****kv****后');
    expect(block.text).toBe('前kv后');
    expect(styled(block)).toEqual(['BOLD:kv']);
  });

  it('keeps intraword underscores literal', () => {
    expect(text('snake_case_name 和 中文_x_中文').text).toBe('snake_case_name 和 中文_x_中文');
  });

  it('writes inline code with backticks or plain, without styles', () => {
    expect(text('run `ls -la` now').text).toBe('run `ls -la` now');
    expect(text('a `` x`y `` b').text).toBe('a ``x`y`` b');
    const plain = text('run `ls` now', { inlineCode: 'plain' });
    expect(plain.text).toBe('run ls now');
    expect(plain.styles).toEqual([]);
  });

  it('decodes entities and emoji shortcodes', () => {
    expect(text('a &amp; b &copy; :smile: :rocket: 12:30:45 :nope:').text).toBe('a & b © 😄 🚀 12:30:45 :nope:');
  });
});

describe('line breaks', () => {
  it('joins soft breaks between CJK and turns other soft breaks into spaces', () => {
    expect(text('第一行\n第二行，\n第三行\nEnglish\nwords').text).toBe('第一行第二行，第三行 English words');
  });

  it('joins CJK soft breaks across styled text', () => {
    const block = text('中文\n**粗体**\n结尾');
    expect(block.text).toBe('中文粗体结尾');
    expect(styled(block)).toEqual(['BOLD:粗体']);
  });

  it('keeps hard breaks (two spaces, backslash, <br>) as \\n', () => {
    expect(text('a  \nb\\\nc<br>d<br/>e').text).toBe('a\nb\nc\nd\ne');
  });
});

describe('links', () => {
  it('creates link ranges for links, bare URLs and autolinks', () => {
    const block = text('[a](https://a.test) https://b.test/x <https://c.test>');
    expect(linked(block)).toEqual(['a->https://a.test', 'https://b.test/x->https://b.test/x', 'https://c.test->https://c.test']);
  });

  it('resolves reference links', () => {
    expect(linked(text('see [docs][d]\n\n[d]: https://d.test'))).toEqual(['docs->https://d.test']);
  });

  it('resolves relative links with siteBaseUrl, otherwise keeps text only', () => {
    expect(linked(text('[p](/posts/x)', { siteBaseUrl: 'https://blog.test' }))).toEqual(['p->https://blog.test/posts/x']);
    const doc = convert('[p](/posts/x) [q](../y)');
    expect(doc.blocks).toEqual([{ kind: 'text', type: 'unstyled', text: 'p q', styles: [], links: [] }]);
    expect(doc.warnings.filter((w) => w.code === 'relative-link')).toHaveLength(1);
  });

  it('turns anchor links into plain text', () => {
    const doc = convert('[jump](#section)');
    expect(doc.blocks[0]).toMatchObject({ text: 'jump', links: [] });
    expect(codes(doc)).toEqual(['anchor-link']);
  });

  it('percent-encodes non-ASCII URLs without double encoding', () => {
    expect(linked(text('[w](https://zh.wikipedia.org/wiki/中文 "t") [e](https://a.test/a%2Fb)'))).toEqual([
      'w->https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87',
      'e->https://a.test/a%2Fb',
    ]);
  });

  it('keeps only link text for badges (link around image)', () => {
    const doc = convert('[![build](https://img.test/b.svg)](https://ci.test)');
    expect(doc.blocks).toEqual([{ kind: 'text', type: 'unstyled', text: 'build', styles: [], links: [{ offset: 0, length: 5, url: 'https://ci.test' }] }]);
  });
});

describe('tweets', () => {
  it('embeds a status link alone in a paragraph', () => {
    const [block] = blocks('https://x.com/jack/status/20');
    expect(block).toEqual<TweetBlock>({ kind: 'tweet', tweetId: '20', url: 'https://x.com/jack/status/20' });
    expect(blocks('<https://twitter.com/a_b/status/123?s=20>')[0]).toMatchObject({ kind: 'tweet', tweetId: '123' });
  });

  it('keeps tweet links inside text or when disabled', () => {
    expect(blocks('see https://x.com/jack/status/20')[0].kind).toBe('text');
    expect(blocks('https://x.com/jack/status/20', { embedTweets: false })[0].kind).toBe('text');
  });
});

describe('lists', () => {
  it('maps flat lists to list items', () => {
    expect(shape(blocks('- a\n- b\n\n1. x\n2. y'))).toEqual([
      'unordered-list-item:a',
      'unordered-list-item:b',
      'ordered-list-item:x',
      'ordered-list-item:y',
    ]);
  });

  it('writes numbers when an ordered list does not start at 1', () => {
    expect(shape(blocks('3. a\n4. b'))).toEqual(['unstyled:3. a', 'unstyled:4. b']);
  });

  it('writes numbers after a list is interrupted by a split-out block', () => {
    expect(shape(blocks('1. a\n\n   ```\n   code\n   ```\n2. b\n3. c'))).toEqual(['ordered-list-item:a', 'md-code', 'unstyled:2. b', 'unstyled:3. c']);
  });

  it('writes numbers for an ordered list directly after another one', () => {
    expect(shape(blocks('1. a\n2. b\n\n<!-- -->\n\n1. c'))).toEqual(['ordered-list-item:a', 'ordered-list-item:b', 'unstyled:1. c']);
  });

  it('joins multiple paragraphs of an item with a line break', () => {
    expect(shape(blocks('- a\n\n  more\n- b'))).toEqual(['unordered-list-item:a\nmore', 'unordered-list-item:b']);
  });

  it('prefixes task list items', () => {
    expect(shape(blocks('- [ ] todo\n- [x] done'))).toEqual(['unordered-list-item:☐ todo', 'unordered-list-item:☑ done']);
  });

  it('outputs nested lists as one Markdown block by default', () => {
    const doc = convert('- a\n  - b \\(x^2\\)\n- c');
    expect(doc.blocks).toEqual<MarkdownBlock[]>([{ kind: 'markdown', role: 'list', markdown: '- a\n  - b x²\n- c' }]);
    expect(codes(doc)).toEqual(['nested-list']);
  });

  it('flattens nested lists with markers when asked', () => {
    expect(shape(blocks('- a\n  - b\n    - c\n  1. d\n- e', { nestedLists: 'flatten' }))).toEqual([
      'unordered-list-item:a',
      'unordered-list-item:◦ b',
      'unordered-list-item:▪ c',
      'unordered-list-item:a. d',
      'unordered-list-item:e',
    ]);
  });

  it('flattens nested ordered lists with written numbers', () => {
    expect(shape(blocks('1. a\n   - b\n2. c', { nestedLists: 'flatten' }))).toEqual(['unstyled:1. a', 'unstyled:◦ b', 'unstyled:2. c']);
  });
});

describe('blockquotes and alerts', () => {
  it('outputs one blockquote block per paragraph', () => {
    expect(shape(blocks('> a\n> b\n>\n> c'))).toEqual(['blockquote:a b', 'blockquote:c']);
  });

  it('prefixes list items inside quotes and splits out code, images and tables', () => {
    expect(shape(blocks('> - x\n> 1. y\n>\n> ```js\n> q\n> ```\n>\n> ![i](https://i.test/a.png)\n>\n> | a |\n> | - |\n> | 1 |'))).toEqual([
      'blockquote:• x',
      'blockquote:1. y',
      'md-code',
      'image-url',
      'md-table',
    ]);
  });

  it('turns GitHub alerts into a quote with a bold label', () => {
    const doc = convert('> [!WARNING]\n> Be **careful**.\n>\n> Second.');
    expect(shape(doc.blocks)).toEqual(['blockquote:⚠️ 警告\nBe careful.', 'blockquote:Second.']);
    expect(styled(doc.blocks[0] as never)).toEqual(['BOLD:⚠️ 警告', 'BOLD:careful']);
    expect(codes(doc)).toEqual(['alert']);
  });

  it('maps every alert type', () => {
    const labels = ['NOTE', 'TIP', 'IMPORTANT', 'CAUTION'].map((t) => text(`> [!${t}]\n> x`).text.split('\n')[0]);
    expect(labels).toEqual(['ℹ️ 注意', '💡 提示', '❗ 重要', '🛑 小心']);
  });

  it('pulls a separate first paragraph into the alert block', () => {
    expect(shape(blocks('> [!TIP]\n>\n> body'))).toEqual(['blockquote:💡 提示\nbody']);
  });
});

describe('code blocks', () => {
  it('outputs fenced and indented code as Markdown code blocks', () => {
    expect(blocks('```Go {linenos=true}\nfunc main() {}\n```\n\n    plain')).toEqual<MarkdownBlock[]>([
      { kind: 'markdown', role: 'code', markdown: '```go\nfunc main() {}\n```', language: 'go' },
      { kind: 'markdown', role: 'code', markdown: '```\nplain\n```', language: '' },
    ]);
  });

  it('uses a longer fence when the code contains backtick fences', () => {
    const [block] = blocks('````md\n```js\nx\n```\n````') as MarkdownBlock[];
    expect(block.markdown).toBe('````markdown\n```js\nx\n```\n````');
  });

  it('splits code over the size limit by lines', () => {
    const line = 'x'.repeat(99);
    const code = Array.from({ length: 250 }, () => line).join('\n');
    const doc = convert('```\n' + code + '\n```');
    expect(doc.blocks.length).toBe(3);
    for (const b of doc.blocks as MarkdownBlock[]) expect(b.markdown.length).toBeLessThanOrEqual(MARKDOWN_BLOCK_LIMIT);
    const joined = (doc.blocks as MarkdownBlock[]).map((b) => b.markdown.slice(4, -4)).join('\n');
    expect(joined).toBe(code);
    expect(codes(doc)).toEqual(['code-split']);
  });

  it('splits a single overlong line', () => {
    const doc = convert('```\n' + 'y'.repeat(MARKDOWN_BLOCK_LIMIT * 2) + '\n```');
    expect(doc.blocks.length).toBe(3);
  });

  it('turns mermaid into an image block with the code as fallback', () => {
    const [block] = blocks('```mermaid\ngraph TD\nA-->B\n```') as ImageBlock[];
    expect(block).toEqual<ImageBlock>({ kind: 'image', source: { type: 'mermaid', code: 'graph TD\nA-->B' }, alt: 'Mermaid 图表', fallbackText: '```mermaid\ngraph TD\nA-->B\n```' });
  });
});

describe('math', () => {
  it('outputs $$ and \\[ \\] blocks as LaTeX blocks', () => {
    expect(blocks('$$\n E = mc^2 \n$$\n\n\\[ a+b \\]\n\n$$x$$')).toEqual<LatexBlock[]>([
      { kind: 'latex', tex: 'E = mc^2' },
      { kind: 'latex', tex: 'a+b' },
      { kind: 'latex', tex: 'x' },
    ]);
  });

  it('splits a paragraph around display math', () => {
    expect(shape(blocks('易得：\n$$s=k$$\n移项得：'))).toEqual(['unstyled:易得：', 'latex', 'unstyled:移项得：']);
  });

  it('falls back to a latex code block when KaTeX rejects the formula', () => {
    const doc = convert('$$\n\\frac{a}{\n$$');
    expect(doc.blocks[0]).toMatchObject({ kind: 'markdown', role: 'code', language: 'latex' });
    expect(codes(doc)).toEqual(['latex-invalid']);
  });

  it('converts inline math to Unicode when possible', () => {
    const doc = convert('设 \\(x_1^2 \\le \\alpha\\) 且 \\(O(n \\log n)\\)，\\(\\frac{a}{b}\\)');
    expect(doc.blocks[0]).toMatchObject({ text: '设 x₁² ≤ α 且 O(n log n)，`\\frac{a}{b}`' });
    expect(doc.warnings.filter((w) => w.code === 'inline-math')).toHaveLength(1);
  });

  it('writes unconvertible inline math as plain TeX in plain mode', () => {
    expect(text('\\(\\frac{a}{b}\\)', { inlineCode: 'plain' }).text).toBe('\\frac{a}{b}');
  });

  it('does not treat single dollars or code as math', () => {
    expect(text('cost $5 and $6, `\\(x\\)`').text).toBe('cost $5 and $6, `\\(x\\)`');
    expect(blocks('```sh\necho \\(a\\) $$\n```')[0]).toMatchObject({ kind: 'markdown', role: 'code' });
  });

  it('keeps math content verbatim (no emphasis inside)', () => {
    expect(text('\\(a*b*c\\)').text).toBe('a*b*c');
  });
});

describe('tables', () => {
  it('re-serializes GFM tables with alignment and inline formatting', () => {
    const md = '| L | C | R | N |\n|:--|:-:|--:|---|\n| **b** | [l](https://l.test) | `a\\|b` | x<br>y |\n| a\\|b | <sup>2</sup> | H<sub>2</sub>O | <sup>ab~</sup> |';
    const [block] = blocks(md) as MarkdownBlock[];
    expect(block.role).toBe('table');
    expect(block.markdown).toBe(
      '| L | C | R | N |\n| :--- | :---: | ---: | --- |\n| **b** | [l](https://l.test) | `a\\|b` | x；y |\n| a\\|b | ² | H₂O | ^ab\\~ |',
    );
  });

  it('escapes Markdown characters in cell text but keeps snake_case', () => {
    const [block] = blocks('| a |\n|---|\n| info\\_hash \\*x\\* _y_ \$5 |') as MarkdownBlock[];
    expect(block.markdown.split('\n')[2]).toBe('| info_hash \\*x\\* *y* \\$5 |');
  });

  it('turns tables with images into a table image block', () => {
    const [block] = blocks('| a |\n|---|\n| ![x](https://i.test/x.png) |') as ImageBlock[];
    expect(block.kind).toBe('image');
    expect(block.source).toEqual({ type: 'table', markdown: '| a |\n| --- |\n| ![x](https://i.test/x.png) |' });
  });

  it('splits very long tables, repeating the header', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| ${'r'.repeat(40)}${i} |`).join('\n');
    const doc = convert(`| h |\n|---|\n${rows}`);
    expect(doc.blocks.length).toBeGreaterThan(1);
    for (const b of doc.blocks as MarkdownBlock[]) {
      expect(b.markdown.startsWith('| h |\n| --- |\n')).toBe(true);
      expect(b.markdown.length).toBeLessThanOrEqual(MARKDOWN_BLOCK_LIMIT);
    }
  });
});

describe('images', () => {
  it('outputs Markdown and HTML images as image blocks', () => {
    expect(blocks('![alt](https://i.test/a.png "t")\n\n<img src="https://i.test/b.png" alt="B" width="100%">')).toEqual<ImageBlock[]>([
      { kind: 'image', source: { type: 'url', url: 'https://i.test/a.png' }, alt: 'alt', fallbackText: '![alt](https://i.test/a.png)' },
      { kind: 'image', source: { type: 'url', url: 'https://i.test/b.png' }, alt: 'B', fallbackText: '![B](https://i.test/b.png)' },
    ]);
  });

  it('splits images out of paragraphs', () => {
    expect(shape(blocks('before ![i](https://i.test/a.png) after'))).toEqual(['unstyled:before', 'image-url', 'unstyled:after']);
  });

  it('resolves relative images with siteBaseUrl or falls back to text', () => {
    expect(blocks('![i](images/a.png)', { siteBaseUrl: 'https://blog.test/' })[0]).toMatchObject({ source: { url: 'https://blog.test/images/a.png' } });
    const doc = convert('![图](images/a.png)');
    expect(shape(doc.blocks)).toEqual(['unstyled:[图片：图]']);
    expect(codes(doc)).toEqual(['image-unsupported']);
  });

  it('drops small HTML icons', () => {
    const doc = convert('<img src="https://i.test/a.png" width="30px" height="30px"/>\nHi');
    expect(shape(doc.blocks)).toEqual(['unstyled:Hi']);
    expect(codes(doc)).toContain('html-dropped');
  });

  it('keeps data: URIs', () => {
    expect(blocks('![d](data:image/png;base64,AAAA)')[0]).toMatchObject({ source: { url: 'data:image/png;base64,AAAA' } });
  });
});

describe('dividers, footnotes, details', () => {
  it('maps thematic breaks to dividers', () => {
    expect(shape(blocks('a\n\n---\n\nb\n\n***'))).toEqual(['unstyled:a', 'divider', 'unstyled:b', 'divider']);
  });

  it('numbers footnotes by first reference and lists them at the end', () => {
    const doc = convert('B[^b] then A[^a] and B again[^b].\n\n[^a]: Note **A** [l](https://l.test)\n[^b]: Note B\n[^unused]: x');
    expect(shape(doc.blocks)).toEqual(['unstyled:B[1] then A[2] and B again[1].', 'header-two:注释', 'unstyled:[1] Note B', 'unstyled:[2] Note A l']);
    expect(styled(doc.blocks[3] as never)).toEqual(['BOLD:A']);
    expect(linked(doc.blocks[3] as never)).toEqual(['l->https://l.test']);
    expect(codes(doc)).toEqual(['footnote']);
  });

  it('expands <details> with a bold summary and converts its Markdown body', () => {
    const doc = convert('<details>\n<summary>Show code</summary>\n\n```go\nx := 1\n```\n\n</details>');
    expect(shape(doc.blocks)).toEqual(['unstyled:Show code', 'md-code']);
    expect(styled(doc.blocks[0] as never)).toEqual(['BOLD:Show code']);
    expect(codes(doc)).toContain('details');
  });
});

describe('raw HTML', () => {
  it('converts inline formatting tags', () => {
    const block = text('<b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <s>x</s> <del>d</del> <a href="https://a.test">a</a> <font color="red">f</font> <span>sp</span>');
    expect(block.text).toBe('b s i e x d a f sp');
    expect(styled(block)).toEqual(['BOLD:b', 'BOLD:s', 'ITALIC:i', 'ITALIC:e', 'STRIKETHROUGH:x', 'STRIKETHROUGH:d']);
    expect(linked(block)).toEqual(['a->https://a.test']);
  });

  it('converts HTML blocks to text blocks', () => {
    const doc = convert('<center>\n<b>Big</b> title\n</center>\n\n<div>one</div><div>two &amp; three</div>\n\n<h2>Head</h2>');
    expect(shape(doc.blocks)).toEqual(['unstyled:Big title', 'unstyled:one', 'unstyled:two & three', 'unstyled:Head']);
    expect(codes(doc)).toContain('html-converted');
  });

  it('turns iframes into an embed link and drops style, script and comments', () => {
    const doc = convert('<style>\n.a{}\n</style>\n\n<script>alert(1)</script>\n\n<!-- hidden -->\n\n<div>\n  <iframe\n    src="https://e.test/map"\n    title="x"></iframe>\n</div>');
    expect(doc.blocks).toEqual([
      { kind: 'text', type: 'unstyled', text: '🔗 嵌入内容：https://e.test/map', styles: [], links: [{ offset: 8, length: 18, url: 'https://e.test/map' }] },
    ]);
    expect(codes(doc)).toEqual(['html-dropped', 'html-converted']);
  });

  it('keeps HTML-looking text', () => {
    expect(text('a <service> b <List<Integer> c <bits/stdc++.h> d').text).toBe('a <service> b <List<Integer> c <bits/stdc++.h> d');
    expect(text('<service>\nname\n</service>').text).toBe('<service> name </service>');
  });

  it('does not carry unclosed inline HTML into the next block', () => {
    const doc = convert('a <a href="https://a.test">x\n\nnext\n\nH<sup>2\n\nplain 3');
    expect(shape(doc.blocks)).toEqual(['unstyled:a x', 'unstyled:next', 'unstyled:H²', 'unstyled:plain 3']);
    expect(doc.blocks[1]).toMatchObject({ links: [] });
  });

  it('converts inline <sup>/<sub> to Unicode', () => {
    expect(text('x<sup>2</sup> H<sub>2</sub>O e<sup>iπ</sup>').text).toBe('x² H₂O e^iπ');
  });
});

describe('document level', () => {
  it('skips empty blocks', () => {
    expect(blocks('\n\n<!-- a -->\n\n&nbsp;\n\n<b> </b>\n\n<p></p>\n\n')).toEqual([]);
  });

  it('fills stats', () => {
    const doc = convert('# T\n\nhello\n\n![a](https://i.test/a.png)\n\n```mermaid\nA\n```\n\n```js\nx\n```\n\n| a |\n|---|\n| 1 |\n\n$$x$$\n\nhttps://x.com/a/status/1');
    expect(doc.stats).toEqual({ blocks: 7, images: 1, mermaid: 1, codeBlocks: 1, tables: 1, latex: 1, tweets: 1, characters: 5 + '```javascript\nx\n```'.length + '| a |\n| --- |\n| 1 |'.length + 1 });
  });

  it('reports warning lines', () => {
    const doc = convert('a\n\n[x](#y)');
    expect(doc.warnings[0]).toMatchObject({ code: 'anchor-link', line: 3 });
  });

  it('converts a 200 KB document in under 300 ms', () => {
    const post = readFileSync(new URL('../fixtures/sample.md', import.meta.url), 'utf8').replace(/^---[\s\S]*?---\n/, '');
    let md = '';
    while (Buffer.byteLength(md) < 200_000) md += post;
    convert(md);
    const times = [0, 1, 2].map(() => {
      const start = performance.now();
      convert(md);
      return performance.now() - start;
    });
    expect(times.sort((a, b) => a - b)[1]).toBeLessThan(300);
  });
});

describe('fixture', () => {
  it('converts the sample post', () => {
    const md = readFileSync(new URL('../fixtures/sample.md', import.meta.url), 'utf8');
    const doc = convert(md, { siteBaseUrl: 'https://blog.example.com' });
    expect(doc.title).toBe('示例文章');
    expect(textBlocks(md).length).toBeGreaterThan(0);
    expect(shape(doc.blocks)).toMatchSnapshot();
  });
});
