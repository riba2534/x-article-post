// A hand-written ArticleDoc that covers every Block kind (core's converter is developed in parallel).
import type { ArticleDoc } from '../../src/shared/types';

export function sampleDoc(): ArticleDoc {
  return {
    title: '用 Markdown 写 X 长文',
    cover: 'https://img.example.com/cover.png',
    blocks: [
      { kind: 'text', type: 'header-one', text: '为什么要写长文', styles: [], links: [] },
      {
        kind: 'text',
        type: 'unstyled',
        text: '长文适合讲清楚一件事，支持加粗、斜体、删除线和链接。',
        styles: [
          { offset: 13, length: 2, style: 'BOLD' },
          { offset: 16, length: 2, style: 'ITALIC' },
          { offset: 19, length: 3, style: 'STRIKETHROUGH' },
        ],
        links: [{ offset: 23, length: 2, url: 'https://x.com' }],
      },
      { kind: 'text', type: 'header-two', text: '基本元素', styles: [], links: [] },
      { kind: 'text', type: 'unstyled', text: '三级标题', styles: [{ offset: 0, length: 4, style: 'BOLD' }], links: [] },
      { kind: 'text', type: 'blockquote', text: '好的排版让读者愿意读完。', styles: [], links: [] },
      { kind: 'text', type: 'unordered-list-item', text: '第一点', styles: [], links: [] },
      { kind: 'text', type: 'unordered-list-item', text: '第二点', styles: [], links: [] },
      { kind: 'text', type: 'ordered-list-item', text: '步骤一', styles: [], links: [] },
      { kind: 'text', type: 'ordered-list-item', text: '步骤二', styles: [], links: [] },
      { kind: 'markdown', role: 'code', language: 'typescript', markdown: '```typescript\nconst answer: number = 42;\nconsole.log(answer);\n```' },
      { kind: 'markdown', role: 'table', markdown: '| 功能 | 支持 |\n| --- | --- |\n| **表格** | 是 |\n| 公式 | 是 |' },
      { kind: 'markdown', role: 'list', markdown: '- 外层\n  - 内层\n    - 更深' },
      { kind: 'latex', tex: 'E = mc^2' },
      { kind: 'divider' },
      { kind: 'image', source: { type: 'url', url: 'https://img.example.com/a.png' }, alt: '示意图', fallbackText: '[图片：示意图]' },
      { kind: 'image', source: { type: 'mermaid', code: 'graph TD\n  A[开始] --> B[结束]' }, alt: 'Mermaid 图', fallbackText: '[Mermaid 图]' },
      {
        kind: 'image',
        source: { type: 'table', markdown: '| 图 | 说明 |\n| --- | --- |\n| ![logo](https://cdn.example.org/logo.png) | 标志 |' },
        alt: '表格',
        fallbackText: '[表格]',
      },
      { kind: 'tweet', tweetId: '1850000000000000000', url: 'https://x.com/jack/status/1850000000000000000' },
    ],
    warnings: [
      { code: 'heading-demoted', message: '三级标题已改为加粗段落', line: 7 },
      { code: 'inline-code', message: '行内代码保留反引号', line: 12 },
      { code: 'inline-code', message: '行内代码保留反引号', line: 14 },
    ],
    stats: { blocks: 18, images: 2, mermaid: 1, codeBlocks: 1, tables: 2, latex: 1, tweets: 1, characters: 120 },
  };
}
