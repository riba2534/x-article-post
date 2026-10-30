// Pure view-model helpers for the side panel (no DOM, unit-tested).
import type { ArticleDoc, InlineStyle, TextBlock, Warning, WarningCode, WritePhase, WriteTarget } from '../shared/types';

/** CJK characters count one each; runs of Latin letters/digits count as words. */
export function countWords(text: string): number {
  const cjk = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  const chars = text.match(cjk)?.length ?? 0;
  const words = text.replace(cjk, ' ').match(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return chars + words;
}

export interface InlineSegment {
  text: string;
  styles: InlineStyle[];
  url?: string;
}

/** Splits a text block at every style/link boundary. */
export function segmentInline(block: Pick<TextBlock, 'text' | 'styles' | 'links'>): InlineSegment[] {
  const len = block.text.length;
  const clamp = (n: number) => Math.min(Math.max(0, n), len);
  const cuts = new Set([0, len]);
  for (const r of [...block.styles, ...block.links]) {
    cuts.add(clamp(r.offset));
    cuts.add(clamp(r.offset + r.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: InlineSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const covers = (r: { offset: number; length: number }) => r.offset <= a && r.offset + r.length >= b;
    const styles = [...new Set(block.styles.filter(covers).map((s) => s.style))];
    const url = block.links.find(covers)?.url;
    out.push({ text: block.text.slice(a, b), styles, ...(url ? { url } : {}) });
  }
  return out;
}

/**
 * Badges for blocks the converter changed on the way to X. Demoted headings are not marked in
 * the doc, so they are matched heuristically: fully bold single-line paragraphs, at most as many
 * as there are 'heading-demoted' warnings.
 */
export function degradeLabels(doc: ArticleDoc): Map<number, string> {
  const labels = new Map<number, string>();
  let demoted = doc.warnings.filter((w) => w.code === 'heading-demoted').length;
  doc.blocks.forEach((b, i) => {
    if (b.kind === 'image' && b.source.type !== 'url') labels.set(i, '转为图片');
    else if (b.kind === 'markdown' && b.role === 'other') labels.set(i, 'Markdown 块');
    else if (
      demoted > 0 &&
      b.kind === 'text' &&
      b.type === 'unstyled' &&
      b.text.length > 0 &&
      !b.text.includes('\n') &&
      b.styles.some((s) => s.style === 'BOLD' && s.offset === 0 && s.length >= b.text.length)
    ) {
      labels.set(i, '降级为加粗');
      demoted--;
    }
  });
  return labels;
}

const WARNING_LABELS: Record<WarningCode, string> = {
  'heading-demoted': '标题降级',
  'inline-code': '行内代码',
  'inline-math': '行内公式',
  'nested-list': '嵌套列表',
  'html-dropped': 'HTML 已移除',
  'html-converted': 'HTML 已转换',
  footnote: '脚注',
  alert: '提示块',
  details: '折叠块',
  'anchor-link': '页内链接',
  'relative-link': '相对链接',
  'image-unsupported': '图片',
  'code-split': '代码块拆分',
  'latex-invalid': '公式无效',
  other: '其他',
};

export interface WarningGroup {
  code: WarningCode;
  label: string;
  items: Warning[];
}

/** Groups warnings by code, largest group first, keeping source order inside a group. */
export function groupWarnings(warnings: Warning[]): WarningGroup[] {
  const groups = new Map<WarningCode, WarningGroup>();
  for (const w of warnings) {
    const g = groups.get(w.code) ?? { code: w.code, label: WARNING_LABELS[w.code] ?? w.code, items: [] };
    g.items.push(w);
    groups.set(w.code, g);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

export const PHASE_LABELS: Record<WritePhase, string> = {
  prepare: '准备内容',
  tab: '打开草稿页',
  text: '写入正文',
  title: '设置标题',
  image: '上传图片',
  cover: '设置封面',
  cleanup: '收尾',
  done: '完成',
  error: '出错',
};

export type TargetMode = 'new' | 'append' | 'replace';

export function buildTarget(mode: TargetMode, articleId: string | undefined): WriteTarget | null {
  if (mode === 'new') return { type: 'new' };
  return articleId ? { type: 'existing', articleId, mode } : null;
}
