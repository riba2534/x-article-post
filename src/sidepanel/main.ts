// Side panel app: editor, preview, report, write flow, settings.
import 'katex/dist/katex.min.css';
import './styles.css';
import { convertMarkdown } from '../core/index';
import { collectPermissionOrigins, prepareWrite } from '../pipeline/prepare';
import { DEFAULT_SETTINGS, DRAFT_KEY, loadSettings, type Settings } from '../shared/settings';
import type { ArticleDoc, ExtensionStatus, RuntimeMessage, WriteResult, WriteTarget } from '../shared/types';
import { segmented } from './controls';
import { h, icon } from './dom';
import { createEditor } from './editor';
import { buildTarget, countWords, groupWarnings, type TargetMode } from './model';
import { renderPreview } from './preview';
import { openRunView, type RunView } from './run';
import { openSettings } from './settings-panel';
import { openSheet } from './sheet';

type View = 'edit' | 'preview' | 'report';

interface Run {
  runId?: string;
  view: RunView;
  stage: 'prepare' | 'write' | 'done';
  cancelled: boolean;
  imagesTotal: number;
  prepareWarnings: string[];
}

const state = {
  settings: DEFAULT_SETTINGS as Settings,
  status: null as ExtensionStatus | null,
  doc: convertMarkdown(''),
  view: 'edit' as View,
  mode: 'new' as TargetMode,
  run: null as Run | null,
  previewStale: true,
};

let settingsSheet: ReturnType<typeof openSettings> | null = null;

function safeConvert(markdown: string): ArticleDoc {
  try {
    return convertMarkdown(markdown, state.settings.convert);
  } catch (err) {
    const doc = convertMarkdown('');
    doc.warnings.push({ code: 'other', message: `转换出错：${err instanceof Error ? err.message : String(err)}` });
    return doc;
  }
}

// ---------------------------------------------------------------------------
// Layout

const xCapsule = h('span', { class: 'capsule', role: 'status' });
const agentCapsule = h('span', { class: 'capsule capsule-agent', role: 'status', hidden: true });
const settingsBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '设置', onclick: () => showSettings() }, icon('gear', 19));

const header = h(
  'header',
  { class: 'topbar' },
  h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '𝕏'), h('span', { class: 'brand-name' }, 'Article Post')),
  h('div', { class: 'capsules' }, xCapsule, agentCapsule),
  settingsBtn,
);

const reportCount = h('span', { class: 'count', hidden: true });
const tabs: Record<View, HTMLButtonElement> = {
  edit: h('button', { type: 'button', role: 'tab', id: 'tab-edit', 'aria-controls': 'panel-edit', class: 'tab' }, '编辑'),
  preview: h('button', { type: 'button', role: 'tab', id: 'tab-preview', 'aria-controls': 'panel-preview', class: 'tab' }, '预览'),
  report: h('button', { type: 'button', role: 'tab', id: 'tab-report', 'aria-controls': 'panel-report', class: 'tab' }, '报告', reportCount),
};
const tabList = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '视图' }, Object.values(tabs));

const fileInput = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', hidden: true, tabindex: '-1' });
const fileName = h('span', { class: 'file-name' });
const wordCount = h('span', { class: 'word-count', 'aria-live': 'polite' });
const editorHost = h('div', { class: 'editor-host' });
const dropHint = h('div', { class: 'drop-hint', 'aria-hidden': 'true' }, icon('upload', 28), h('span', null, '松开以打开文件'));
const editorCard = h(
  'div',
  { class: 'card editor-card' },
  h(
    'div',
    { class: 'editor-toolbar' },
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': '打开 Markdown 文件', onclick: () => fileInput.click() }, icon('file', 16), '打开'),
    fileName,
    wordCount,
  ),
  editorHost,
  dropHint,
  fileInput,
);

const panels: Record<View, HTMLElement> = {
  edit: h('section', { class: 'panel panel-edit', id: 'panel-edit', role: 'tabpanel', 'aria-labelledby': 'tab-edit' }, editorCard),
  preview: h('section', { class: 'panel panel-scroll', id: 'panel-preview', role: 'tabpanel', 'aria-labelledby': 'tab-preview', tabindex: '0' }),
  report: h('section', { class: 'panel panel-scroll', id: 'panel-report', role: 'tabpanel', 'aria-labelledby': 'tab-report', tabindex: '0' }),
};

const targetSeg = segmented<TargetMode>(
  '写入目标',
  [
    { value: 'new', label: '新建草稿' },
    { value: 'append', label: '追加' },
    { value: 'replace', label: '替换' },
  ],
  'new',
  (mode) => {
    state.mode = mode;
    renderFooter();
  },
  'seg-target',
);
const footerMeta = h('div', { class: 'footer-meta' });
const primaryBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => onPrimary() }, '创建草稿');
const footer = h(
  'footer',
  { class: 'actionbar' },
  h('div', { class: 'actionbar-row' }, h('span', { class: 'actionbar-label', id: 'target-label' }, '写入到'), targetSeg.el),
  h('div', { class: 'actionbar-row' }, footerMeta, primaryBtn),
);

document.getElementById('app')!.append(header, h('div', { class: 'tabs-wrap' }, tabList), h('main', { class: 'main' }, Object.values(panels)), footer);

// ---------------------------------------------------------------------------
// Views

function setView(view: View, focus = false) {
  state.view = view;
  for (const [key, tab] of Object.entries(tabs) as [View, HTMLButtonElement][]) {
    const on = key === view;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    panels[key].hidden = !on;
  }
  if (focus) tabs[view].focus();
  refreshVisible();
}

for (const [key, tab] of Object.entries(tabs) as [View, HTMLButtonElement][]) tab.addEventListener('click', () => setView(key));
tabList.addEventListener('keydown', (e) => {
  const order: View[] = ['edit', 'preview', 'report'];
  const i = order.indexOf(state.view);
  if (e.key === 'ArrowRight') setView(order[(i + 1) % 3], true);
  else if (e.key === 'ArrowLeft') setView(order[(i + 2) % 3], true);
  else return;
  e.preventDefault();
});

function refreshVisible() {
  if (state.view === 'preview' && state.previewStale) {
    renderPreview(state.doc, panels.preview);
    state.previewStale = false;
  }
  if (state.view === 'report') renderReport();
}

const STAT_LABELS: [keyof ArticleDoc['stats'], string][] = [
  ['blocks', '段落'],
  ['images', '图片'],
  ['codeBlocks', '代码块'],
  ['tables', '表格'],
  ['latex', '公式'],
  ['mermaid', 'Mermaid'],
  ['tweets', '帖子'],
  ['characters', '字符'],
];

function renderReport() {
  const { doc } = state;
  const stats = h(
    'div',
    { class: 'card stats' },
    STAT_LABELS.map(([key, label]) => h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, doc.stats[key].toLocaleString('zh-CN')), h('div', { class: 'stat-label' }, label))),
  );
  const groups = groupWarnings(doc.warnings);
  const body = groups.length
    ? groups.map((g) =>
        h(
          'section',
          { class: 'card report-group', 'aria-label': g.label },
          h('div', { class: 'report-head' }, icon('alert', 16), h('span', { class: 'report-label' }, g.label), h('span', { class: 'count count-warn' }, g.items.length)),
          h(
            'ul',
            { class: 'report-items' },
            g.items.map((w) =>
              h(
                'li',
                null,
                h('span', { class: 'report-msg' }, w.message),
                w.line
                  ? h('button', { type: 'button', class: 'line-link', 'aria-label': `跳到第 ${w.line} 行`, onclick: () => jumpToLine(w.line!) }, `第 ${w.line} 行`)
                  : null,
              ),
            ),
          ),
        ),
      )
    : [h('div', { class: 'card empty' }, icon('check', 28), h('p', null, '没有需要注意的转换'))];
  panels.report.replaceChildren(h('div', { class: 'report' }, h('h2', { class: 'section-title' }, '转换概览'), stats, groups.length ? h('h2', { class: 'section-title' }, `提示（${doc.warnings.length}）`) : null, body));
}

function jumpToLine(line: number) {
  setView('edit');
  editor.goToLine(line);
}

// ---------------------------------------------------------------------------
// Editor

let convertTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function onText(text: string) {
  wordCount.textContent = `${countWords(text).toLocaleString('zh-CN')} 字`;
  clearTimeout(convertTimer);
  convertTimer = setTimeout(() => updateDoc(text), 250);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void chrome.storage.local.set({ [DRAFT_KEY]: text }).catch(() => undefined), 500);
}

function updateDoc(text = editor.getText()) {
  state.doc = safeConvert(text);
  state.previewStale = true;
  const n = state.doc.warnings.length;
  reportCount.hidden = n === 0;
  reportCount.textContent = String(n);
  tabs.report.setAttribute('aria-label', n ? `报告，${n} 条提示` : '报告');
  renderFooter();
  refreshVisible();
}

const editor = createEditor(editorHost, '', onText);

async function openFile(file: File) {
  const text = await file.text();
  editor.setText(text);
  fileName.textContent = file.name;
  fileName.title = file.name;
  setView('edit');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
  fileInput.value = '';
});

let dragDepth = 0;
editorCard.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  editorCard.classList.add('dragging');
});
editorCard.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
editorCard.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) editorCard.classList.remove('dragging');
});
editorCard.addEventListener('drop', (e) => {
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.(md|markdown|txt)$/i.test(f.name) || f.type.startsWith('text/'));
  dragDepth = 0;
  editorCard.classList.remove('dragging');
  if (!file) return;
  e.preventDefault();
  e.stopPropagation();
  void openFile(file);
});

// ---------------------------------------------------------------------------
// Status

function renderStatus() {
  const s = state.status;
  const x = s?.xTab;
  let tone = 'muted';
  let text = '未打开 X';
  if (!s) text = '插件未就绪';
  else if (s.busy) [tone, text] = ['accent', '正在写入'];
  else if (x?.editorReady) [tone, text] = ['ok', 'X 草稿页已就绪'];
  else if (x) [tone, text] = ['warn', '未打开草稿页'];
  xCapsule.className = `capsule capsule-${tone}`;
  xCapsule.replaceChildren(h('span', { class: 'dot' }), h('span', { class: 'capsule-text' }, text));
  xCapsule.setAttribute('aria-label', `X 状态：${text}`);

  const bridge = s?.bridge;
  agentCapsule.hidden = !bridge?.enabled;
  if (bridge?.enabled) {
    const label = bridge.connected ? 'Agent 已连接' : 'Agent 未连接';
    agentCapsule.className = `capsule capsule-agent capsule-${bridge.connected ? 'ok' : 'muted'}`;
    agentCapsule.replaceChildren(icon('agent', 14), h('span', { class: 'capsule-text' }, label));
    agentCapsule.setAttribute('aria-label', label);
    agentCapsule.title = label;
  }
  renderFooter();
  settingsSheet?.updateStatus(s);
}

async function pollStatus() {
  try {
    state.status = ((await chrome.runtime.sendMessage({ type: 'xap:status' } satisfies RuntimeMessage)) as ExtensionStatus | undefined) ?? null;
  } catch {
    state.status = null;
  }
  renderStatus();
}

// ---------------------------------------------------------------------------
// Footer + write flow

const PRIMARY_LABEL: Record<TargetMode, string> = { new: '创建草稿', append: '追加到草稿', replace: '替换草稿' };

function renderFooter() {
  const articleId = state.status?.xTab?.articleId;
  const noDraft = '先在 X 打开一篇草稿';
  targetSeg.setDisabled('append', !articleId, articleId ? '' : noDraft);
  targetSeg.setDisabled('replace', !articleId, articleId ? '' : noDraft);
  if (!articleId && state.mode !== 'new') {
    state.mode = 'new';
    targetSeg.set('new');
  }
  const images = state.doc.stats.images + state.doc.stats.mermaid + (state.doc.cover ? 1 : 0);
  const parts = [state.mode === 'new' ? '新建一篇草稿' : `当前草稿 …${articleId!.slice(-6)}`];
  if (images) parts.push(`${images} 张图片`);
  footerMeta.textContent = parts.join(' · ');
  primaryBtn.textContent = PRIMARY_LABEL[state.mode];
  const empty = !editor.getText().trim();
  primaryBtn.disabled = empty || !!state.run || !!state.status?.busy;
  primaryBtn.title = empty ? '编辑器里还没有内容' : state.status?.busy ? '另一个写入任务正在进行' : '';
}

function onPrimary() {
  if (state.mode !== 'replace') return startRun();
  const confirmBtn = h('button', { type: 'button', class: 'btn btn-danger btn-block' }, '替换草稿');
  const sheet = openSheet(
    '替换当前草稿',
    h(
      'div',
      { class: 'confirm' },
      h('p', null, '会先清空当前草稿的正文，再写入编辑器里的内容。清空的内容无法在插件里恢复。'),
      h('div', { class: 'result-actions' }, confirmBtn, h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: () => sheet.close() }, '取消')),
    ),
  );
  confirmBtn.addEventListener('click', () => {
    // startRun requests host permissions, so it must run inside this click handler.
    startRun();
    sheet.close();
  });
}

function startRun() {
  if (state.run) return;
  const markdown = editor.getText();
  const target = buildTarget(state.mode, state.status?.xTab?.articleId);
  if (!markdown.trim() || !target) return;
  // Before any await: permissions.request needs the user gesture of this click.
  const doc = safeConvert(markdown);
  const origins = collectPermissionOrigins(doc);
  const granted = origins.length ? chrome.permissions.request({ origins }).catch(() => false) : Promise.resolve(true);
  void runWrite(markdown, target, granted, doc.warnings.length);
}

function failure(runId: string | undefined, error: string): WriteResult {
  return { ok: false, runId: runId ?? '', blocksWritten: 0, imagesOk: 0, imagesFailed: [], titleSet: false, coverSet: false, warnings: [], error };
}

function finishRun(run: Run, result: WriteResult) {
  if (run.stage === 'done') return;
  run.stage = 'done';
  run.view.showResult(result, {
    imagesTotal: run.imagesTotal,
    prepareWarnings: run.prepareWarnings,
    onOpen: openDraft,
    onRetry: startRun,
  });
  state.run = null;
  renderFooter();
  void pollStatus();
}

async function runWrite(markdown: string, target: WriteTarget, granted: Promise<boolean>, convertWarnings: number) {
  const run: Run = {
    stage: 'prepare',
    cancelled: false,
    imagesTotal: 0,
    prepareWarnings: [],
    view: openRunView(() => cancelRun(run)),
  };
  state.run = run;
  renderFooter();
  try {
    await granted;
    const { request, doc } = await prepareWrite(markdown, state.settings.convert, target, (p) => {
      run.runId ??= p.runId;
      if (!run.cancelled) run.view.update(p);
    });
    if (run.cancelled) return finishRun(run, failure(request.runId, 'cancelled'));
    run.runId = request.runId;
    run.imagesTotal = Object.keys(request.images).length;
    run.prepareWarnings = doc.warnings.slice(convertWarnings).map((w) => w.message);
    run.stage = 'write';
    run.view.update({ phase: 'tab', message: '正在连接 X 草稿页' });
    const result = (await chrome.runtime.sendMessage({ type: 'xap:write', request } satisfies RuntimeMessage)) as WriteResult | undefined;
    finishRun(run, result ?? failure(run.runId, '后台没有返回结果'));
  } catch (err) {
    finishRun(run, failure(run.runId, err instanceof Error ? err.message : String(err)));
  }
}

function cancelRun(run: Run) {
  if (run.stage === 'prepare') {
    run.cancelled = true;
    run.view.setCancelling();
  } else if (run.stage === 'write' && run.runId) {
    run.view.setCancelling();
    void chrome.runtime.sendMessage({ type: 'xap:cancel', runId: run.runId } satisfies RuntimeMessage).catch(() => undefined);
  }
}

async function openDraft(url: string, articleId?: string) {
  const x = state.status?.xTab;
  try {
    if (x && articleId && x.articleId === articleId) {
      const tab = await chrome.tabs.update(x.tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  const run = state.run;
  if (!run || !run.runId) return false;
  if (msg?.type === 'xap:progress' && msg.progress.runId === run.runId && run.stage === 'write') run.view.update(msg.progress);
  else if (msg?.type === 'xap:result' && msg.result.runId === run.runId) finishRun(run, msg.result);
  return false;
});

// ---------------------------------------------------------------------------
// Settings

function showSettings() {
  settingsSheet = openSettings({
    settings: state.settings,
    status: state.status,
    onSaved(next) {
      state.settings = next;
      updateDoc();
    },
  });
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  setView('edit');
  renderStatus();
  const [settings, stored] = await Promise.all([
    loadSettings().catch(() => DEFAULT_SETTINGS),
    chrome.storage.local.get(DRAFT_KEY).catch(() => ({}) as Record<string, unknown>),
  ]);
  state.settings = settings;
  const draft = (stored as Record<string, unknown>)[DRAFT_KEY];
  if (typeof draft === 'string' && draft) editor.setText(draft);
  else onText('');
  updateDoc();
  void pollStatus();
  setInterval(() => void pollStatus(), 2000);
}

void boot().catch((err) => console.error('[xap] side panel failed to start', err));

