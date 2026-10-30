// X-like rendering of an ArticleDoc. Loaded lazily on first preview (KaTeX + unified are heavy).
import 'katex/dist/katex.min.css';
import katex from 'katex';
import type { ArticleDoc, Block, ImageBlock, MarkdownBlock, TextBlock } from '../shared/types';
import { isSafeUrl, markdownToHtml } from '../pipeline/markdown-html';
import { renderMermaidSvg } from '../pipeline/mermaid';
import { h, icon } from './dom';
import { degradeLabels, segmentInline } from './model';

function renderTex(tex: string, displayMode: boolean): HTMLElement {
  const el = h(displayMode ? 'div' : 'span', { class: displayMode ? 'x-math' : 'x-math-inline' });
  el.innerHTML = katex.renderToString(tex, { displayMode, throwOnError: false, output: 'htmlAndMathml' });
  return el;
}

function textWithBreaks(text: string): (Node | string)[] {
  return text.split('\n').flatMap((part, i) => (i ? [h('br'), part] : [part]));
}

function renderInline(block: TextBlock): Node[] {
  return segmentInline(block).map((seg) => {
    let node: Node = h('span', null, textWithBreaks(seg.text));
    if (seg.styles.includes('STRIKETHROUGH')) node = h('s', null, node);
    if (seg.styles.includes('ITALIC')) node = h('em', null, node);
    if (seg.styles.includes('BOLD')) node = h('strong', null, node);
    if (seg.url && isSafeUrl(seg.url, 'href')) node = h('a', { href: seg.url, target: '_blank', rel: 'noopener noreferrer' }, node);
    return node;
  });
}

function renderText(block: TextBlock): HTMLElement {
  const inline = renderInline(block);
  switch (block.type) {
    case 'header-one':
      return h('h2', { class: 'x-h1' }, inline);
    case 'header-two':
      return h('h3', { class: 'x-h2' }, inline);
    case 'blockquote':
      return h('blockquote', { class: 'x-quote' }, inline);
    case 'unordered-list-item':
    case 'ordered-list-item':
      return h('li', null, inline);
    default:
      return h('p', { class: 'x-p' }, inline);
  }
}

function enhanceMath(root: HTMLElement): void {
  root.querySelectorAll('code.language-math').forEach((code) => {
    const display = code.classList.contains('math-display');
    const target = display && code.parentElement?.tagName === 'PRE' ? code.parentElement : code;
    target.replaceWith(renderTex(code.textContent ?? '', display));
  });
}

function renderMarkdown(block: MarkdownBlock): HTMLElement {
  const body = h('div', { class: `x-md x-md-${block.role}` });
  body.innerHTML = markdownToHtml(block.markdown);
  if (block.role === 'code') return h('div', { class: 'x-code' }, h('div', { class: 'x-code-lang' }, block.language || '纯文本'), body);
  enhanceMath(body);
  body.querySelectorAll('table').forEach((t) => {
    const wrap = h('div', { class: 'x-table-wrap' });
    t.replaceWith(wrap);
    wrap.append(t);
  });
  return body;
}

function renderImage(block: ImageBlock): HTMLElement {
  const figure = h('figure', { class: 'x-figure' });
  const { source } = block;
  if (source.type === 'url') {
    if (isSafeUrl(source.url, 'src')) {
      const img = h('img', { src: source.url, alt: block.alt, loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.replaceWith(h('div', { class: 'x-img-error' }, block.alt || '图片无法加载')));
      figure.append(img);
    } else {
      figure.append(h('div', { class: 'x-img-error' }, block.alt || '图片地址无效'));
    }
  } else if (source.type === 'mermaid') {
    const box = h('div', { class: 'x-mermaid', 'aria-busy': 'true' }, h('span', { class: 'x-muted' }, '正在渲染 Mermaid'));
    renderMermaidSvg(source.code).then(
      (svg) => {
        box.innerHTML = svg;
        box.removeAttribute('aria-busy');
      },
      (err: Error) => {
        box.replaceChildren(h('div', { class: 'x-img-error' }, err.message));
        box.removeAttribute('aria-busy');
      },
    );
    figure.append(box);
  } else {
    const table = renderMarkdown({ kind: 'markdown', role: 'table', markdown: source.markdown });
    table.classList.add('x-table-image');
    figure.append(table);
  }
  if (block.alt && source.type === 'url') figure.append(h('figcaption', null, block.alt));
  return figure;
}

function renderBlock(block: Block): HTMLElement {
  switch (block.kind) {
    case 'text':
      return renderText(block);
    case 'markdown':
      return renderMarkdown(block);
    case 'latex':
      return renderTex(block.tex, true);
    case 'divider':
      return h('hr', { class: 'x-hr' });
    case 'tweet':
      return h(
        'a',
        { class: 'x-tweet', href: block.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `嵌入的帖子 ${block.tweetId}` },
        h('span', { class: 'x-tweet-logo', 'aria-hidden': 'true' }, '𝕏'),
        h('span', { class: 'x-tweet-body' }, h('strong', null, '嵌入帖子'), h('span', { class: 'x-muted' }, block.url)),
      );
    case 'image':
      return renderImage(block);
  }
}

/** Changed blocks get a quiet 2px rule on the left; the details live in the report. */
function markChanged(el: HTMLElement, label: string | undefined): HTMLElement {
  if (!label) return el;
  el.classList.add('x-changed');
  el.title = `${label}（详见报告）`;
  return el;
}

export function renderPreview(doc: ArticleDoc, root: HTMLElement): void {
  const labels = degradeLabels(doc);
  const article = h('article', { class: 'x-article', 'aria-label': '文章预览' });
  if (doc.cover && isSafeUrl(doc.cover, 'src')) {
    article.append(h('img', { class: 'x-cover', src: doc.cover, alt: '封面', referrerpolicy: 'no-referrer' }));
  }
  article.append(h('h1', { class: doc.title ? 'x-title' : 'x-title x-title-empty' }, doc.title || '未命名文章'));

  let list: HTMLElement | null = null;
  doc.blocks.forEach((block, i) => {
    const el = markChanged(renderBlock(block), labels.get(i));
    if (block.kind === 'text' && (block.type === 'unordered-list-item' || block.type === 'ordered-list-item')) {
      const tag = block.type === 'ordered-list-item' ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag, { class: 'x-list' });
        article.append(list);
      }
      list.append(el);
      return;
    }
    list = null;
    article.append(el);
  });

  if (!doc.blocks.length) {
    article.append(h('div', { class: 'empty' }, icon('doc', 28), h('p', null, '编辑器里还没有内容')));
  }
  root.replaceChildren(article);
}
