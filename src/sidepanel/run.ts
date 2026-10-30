// Write run UI: progress sheet, cancel, result card.
import type { WriteProgress, WriteResult } from '../shared/types';
import { h, icon } from './dom';
import { PHASE_LABELS } from './model';
import { openSheet, type Sheet } from './sheet';

export interface RunView {
  update(p: Pick<WriteProgress, 'phase' | 'message' | 'current' | 'total'>): void;
  setCancelling(): void;
  showResult(result: WriteResult, actions: ResultActions): void;
}

export interface ResultActions {
  imagesTotal: number;
  prepareWarnings: string[];
  onOpen(url: string, articleId?: string): void;
  onRetry(): void;
}

const ERROR_TEXT: Record<string, string> = {
  busy: '另一个写入任务正在进行，请稍后再试',
  cancelled: '已取消写入',
};

function errorText(error: string | undefined): string {
  if (!error) return '写入失败，原因未知';
  return ERROR_TEXT[error] ?? error;
}

export function openRunView(onCancel: () => void): RunView {
  const phase = h('div', { class: 'progress-phase' }, PHASE_LABELS.prepare);
  const message = h('div', { class: 'progress-message' }, '整理内容');
  const fill = h('div', { class: 'progress-fill' });
  const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-label': '写入进度', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const cancel = h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: onCancel }, '取消');
  const live = h('div', { class: 'progress-view', 'aria-live': 'polite' }, phase, message, bar, cancel);
  const sheet: Sheet = openSheet('正在写入草稿', live, { closable: false });

  const update: RunView['update'] = (p) => {
    phase.textContent = PHASE_LABELS[p.phase] ?? p.phase;
    message.textContent = p.message;
    const pct = p.total ? Math.round(((p.current ?? 0) / p.total) * 100) : null;
    bar.classList.toggle('indeterminate', pct === null);
    fill.style.width = pct === null ? '' : `${pct}%`;
    if (pct === null) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(pct));
  };

  return {
    update,
    setCancelling() {
      cancel.disabled = true;
      cancel.textContent = '正在取消';
    },
    showResult(result, actions) {
      sheet.setClosable(true);
      const failedImages = result.imagesFailed.length;
      if (result.ok) {
        sheet.setTitle('草稿已创建');
        const rows: [string, string][] = [
          ['正文', `${result.blocksWritten} 个段落`],
          ['图片', actions.imagesTotal || result.imagesOk || failedImages ? `${result.imagesOk} 张成功${failedImages ? `，${failedImages} 张失败` : ''}` : '无'],
          ['标题', result.titleSet ? '已设置' : '未设置'],
        ];
        if (result.coverSet) rows.push(['封面', '已设置']);
        const notes = [...actions.prepareWarnings, ...result.warnings, ...result.imagesFailed.map((f) => `${f.imageId}：${f.error}`)];
        const open = result.url
          ? h('a', { class: 'btn btn-primary btn-block', href: result.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), '打开草稿')
          : null;
        open?.addEventListener('click', (e) => {
          e.preventDefault();
          actions.onOpen(result.url!, result.articleId);
        });
        sheet.body.replaceChildren(
          h(
            'div',
            { class: 'result result-ok', role: 'status' },
            h('div', { class: 'result-icon' }, icon('check', 40)),
            h('p', { class: 'result-lead' }, '内容已写入 X 草稿，发布前请在 X 上检查一遍。'),
            h('dl', { class: 'result-rows' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { class: k === '图片' && failedImages ? 'warn-text' : '' }, v)])),
            notes.length
              ? h('details', { class: 'result-notes' }, h('summary', null, `${notes.length} 条提示`), h('ul', null, notes.map((n) => h('li', null, n))))
              : null,
            h('div', { class: 'result-actions' }, open, h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: () => sheet.close() }, '完成')),
          ),
        );
      } else {
        const cancelled = result.error === 'cancelled';
        sheet.setTitle(cancelled ? '已取消' : '写入失败');
        sheet.body.replaceChildren(
          h(
            'div',
            { class: `result ${cancelled ? 'result-muted' : 'result-error'}`, role: 'alert' },
            h('div', { class: 'result-icon' }, icon(cancelled ? 'close' : 'error', 40)),
            h('p', { class: 'result-lead' }, errorText(result.error)),
            result.articleId ? h('p', { class: 'row-hint' }, '部分内容可能已写入草稿，可在 X 上查看。') : null,
            h(
              'div',
              { class: 'result-actions' },
              h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => (sheet.close(), actions.onRetry()) }, icon('retry', 16), '重试'),
              h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: () => sheet.close() }, '关闭'),
            ),
          ),
        );
      }
      sheet.body.querySelector<HTMLElement>('.btn')?.focus();
    },
  };
}
