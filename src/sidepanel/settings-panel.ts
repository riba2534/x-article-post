// Settings sheet: ConvertOptions, image host permission, agent bridge. Every change is saved to
// storage right away; the background watches storage for bridge changes.
import { saveSettings, type Settings } from '../shared/settings';
import type { ConvertOptions, ExtensionStatus } from '../shared/types';
import { field, row, segmented, setSwitch, switchControl } from './controls';
import { h, icon } from './dom';
import { openSheet } from './sheet';

// The manifest's optional host permissions are exactly the "all sites" grant.
const ALL_SITES = chrome.runtime.getManifest().optional_host_permissions ?? [];

export interface SettingsContext {
  settings: Settings;
  status: ExtensionStatus | null;
  onSaved(settings: Settings): void;
}

function bridgeLabel(settings: Settings, status: ExtensionStatus | null): { text: string; tone: string } {
  if (!settings.bridge.enabled) return { text: '未开启', tone: 'muted' };
  if (status?.bridge.connected) return { text: '已连接', tone: 'ok' };
  return { text: '未连接', tone: 'warn' };
}

export function openSettings(ctx: SettingsContext): { updateStatus(status: ExtensionStatus | null): void } {
  let settings = ctx.settings;
  let status = ctx.status;

  // Saves are serialized and patches applied to the latest settings, so quick toggles don't race.
  let queue = Promise.resolve();
  const save = (patch: (s: Settings) => Partial<Settings>) => {
    queue = queue
      .then(async () => {
        settings = await saveSettings(patch(settings));
        ctx.onSaved(settings);
        renderBridgeState();
      })
      .catch((err) => console.warn('[xap] save settings failed', err));
  };
  const saveConvert = (patch: Partial<ConvertOptions>) => save((s) => ({ convert: { ...s.convert, ...patch } }));
  const saveBridge = (patch: Partial<Settings['bridge']>) => save((s) => ({ bridge: { ...s.bridge, ...patch } }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => void) | null = null;
  const flush = () => {
    clearTimeout(timer);
    pending?.();
    pending = null;
  };
  const debounced = (fn: () => void) => {
    clearTimeout(timer);
    pending = fn;
    timer = setTimeout(flush, 400);
  };

  const c = settings.convert;
  const siteInput = h('input', { type: 'url', class: 'input', placeholder: 'https://example.com', value: c.siteBaseUrl, autocomplete: 'off', spellcheck: 'false' });
  siteInput.addEventListener('input', () => debounced(() => saveConvert({ siteBaseUrl: siteInput.value.trim() })));

  const convertGroup = h(
    'section',
    { class: 'group', 'aria-label': '转换' },
    h('h3', { class: 'group-title' }, '转换'),
    h(
      'div',
      { class: 'card list' },
      field('站点地址', siteInput, '用于补全相对链接，留空则只保留文字'),
      row(
        '行内代码',
        segmented('行内代码', [{ value: 'backtick', label: '保留反引号' }, { value: 'plain', label: '纯文本' }], c.inlineCode, (v) => saveConvert({ inlineCode: v }), 'seg-sm').el,
      ),
      row(
        '嵌套列表',
        segmented('嵌套列表', [{ value: 'markdown', label: '保留层级' }, { value: 'flatten', label: '展平' }], c.nestedLists, (v) => saveConvert({ nestedLists: v }), 'seg-sm').el,
        '保留层级时写成 Markdown 块',
      ),
      row('用一级标题作标题', switchControl('用一级标题作标题', c.titleFromHeading, (v) => saveConvert({ titleFromHeading: v })), 'Front matter 没有 title 时生效'),
      row('插入摘要', switchControl('插入摘要', c.includeDescription, (v) => saveConvert({ includeDescription: v })), '把 description 作为开头引用'),
      row('嵌入帖子', switchControl('嵌入帖子', c.embedTweets, (v) => saveConvert({ embedTweets: v })), '单独一行的 x.com 帖子链接转为嵌入'),
    ),
  );

  const allSites = switchControl('允许读取所有网站图片', false, (next) => {
    // Must run inside the click handler: permissions.request needs the user gesture.
    const op = next ? chrome.permissions.request({ origins: ALL_SITES }) : chrome.permissions.remove({ origins: ALL_SITES });
    op.then(refreshPermission, refreshPermission);
  });
  const refreshPermission = () =>
    chrome.permissions.contains({ origins: ALL_SITES }).then(
      (granted) => setSwitch(allSites, granted),
      () => setSwitch(allSites, false),
    );
  void refreshPermission();

  const imageGroup = h(
    'section',
    { class: 'group', 'aria-label': '图片' },
    h('h3', { class: 'group-title' }, '图片'),
    h('div', { class: 'card list' }, row('允许读取所有网站图片', allSites, '关闭时会在写入前按图片域名单独申请')),
  );

  const b = settings.bridge;
  const urlInput = h('input', { type: 'text', class: 'input', value: b.url, autocomplete: 'off', spellcheck: 'false' });
  urlInput.addEventListener('input', () => debounced(() => saveBridge({ url: urlInput.value.trim() })));
  const tokenInput = h('input', { type: 'password', class: 'input', value: b.token, autocomplete: 'off', spellcheck: 'false', placeholder: '运行 xap token 查看' });
  tokenInput.addEventListener('input', () => debounced(() => saveBridge({ token: tokenInput.value.trim() })));
  const reveal = h('button', { type: 'button', class: 'icon-btn input-addon', 'aria-label': '显示配对令牌', 'aria-pressed': 'false' }, icon('eye', 16));
  reveal.addEventListener('click', () => {
    const show = tokenInput.type === 'password';
    tokenInput.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', show ? '隐藏配对令牌' : '显示配对令牌');
  });
  const tokenField = field('配对令牌', tokenInput, undefined, h('div', { class: 'input-group' }, tokenInput, reveal));

  const stateDot = h('span', { class: 'dot' });
  const stateText = h('span');
  const renderBridgeState = () => {
    const s = bridgeLabel(settings, status);
    stateDot.className = `dot dot-${s.tone}`;
    stateText.textContent = s.text;
  };
  renderBridgeState();

  const bridgeGroup = h(
    'section',
    { class: 'group', 'aria-label': 'Agent 桥接' },
    h('h3', { class: 'group-title' }, 'Agent 桥接'),
    h(
      'div',
      { class: 'card list' },
      row('开启桥接', switchControl('开启桥接', b.enabled, (v) => saveBridge({ enabled: v })), '让本机的 xap 命令通过插件创建草稿'),
      field('桥接地址', urlInput),
      tokenField,
      row('连接状态', h('span', { class: 'state', role: 'status' }, stateDot, stateText)),
    ),
    h('p', { class: 'foot-note' }, '在终端运行 xap serve 启动桥接，令牌只保存在本机。'),
  );

  openSheet('设置', h('div', { class: 'settings' }, convertGroup, imageGroup, bridgeGroup), { onClose: flush });
  return {
    updateStatus(next) {
      status = next;
      renderBridgeState();
    },
  };
}
