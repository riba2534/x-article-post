// Modal bottom sheet: focus moves in on open, Escape closes (when allowed), focus returns on close.
import { h, icon } from './dom';

export interface Sheet {
  el: HTMLElement;
  body: HTMLElement;
  setTitle(title: string): void;
  setClosable(closable: boolean): void;
  close(): void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function openSheet(title: string, content: Node, opts: { closable?: boolean; onClose?: () => void } = {}): Sheet {
  let closable = opts.closable ?? true;
  const previous = document.activeElement as HTMLElement | null;
  const titleId = `sheet-title-${Math.random().toString(36).slice(2, 8)}`;
  const heading = h('h2', { id: titleId, class: 'sheet-title' }, title);
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭' }, icon('close'));
  const body = h('div', { class: 'sheet-body' }, content);
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, h('div', { class: 'sheet-head' }, heading, closeBtn), body);
  const layer = h('div', { class: 'sheet-layer' }, h('div', { class: 'sheet-backdrop' }), panel);

  const close = () => {
    if (!layer.isConnected) return;
    layer.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
    previous?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && closable) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  closeBtn.addEventListener('click', () => closable && close());
  layer.firstElementChild!.addEventListener('click', () => closable && close());
  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  (panel.querySelector<HTMLElement>(`.sheet-body ${FOCUSABLE.split(',')[0]}`) ?? closeBtn).focus();

  const setClosable = (value: boolean) => {
    closable = value;
    closeBtn.hidden = !value;
  };
  setClosable(closable);
  return { el: layer, body, setTitle: (t) => (heading.textContent = t), setClosable, close };
}
