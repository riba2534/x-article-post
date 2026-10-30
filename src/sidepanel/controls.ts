// Small form controls in the panel's style: switch, segmented control, labelled row.
import { h } from './dom';

export function switchControl(label: string, checked: boolean, onToggle: (next: boolean) => void): HTMLButtonElement {
  const btn = h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': String(checked), 'aria-label': label }, h('span', { class: 'switch-knob' }));
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    onToggle(next);
  });
  return btn;
}

export function setSwitch(btn: HTMLButtonElement, checked: boolean): void {
  btn.setAttribute('aria-checked', String(checked));
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(value: T): void;
  setDisabled(value: T, disabled: boolean, title?: string): void;
}

/** Radio-group semantics: one tab stop, arrow keys move the selection. */
export function segmented<T extends string>(label: string, options: SegmentOption<T>[], value: T, onSelect: (v: T) => void, cls = ''): Segmented<T> {
  const el = h('div', { class: `seg ${cls}`, role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) =>
    h('button', { type: 'button', role: 'radio', class: 'seg-item', 'data-value': o.value, title: o.title, onclick: () => choose(o.value, true) }, o.label),
  );
  el.append(...buttons);
  const enabled = () => buttons.filter((b) => !b.disabled);
  const set = (v: T) => {
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  const choose = (v: T, notify: boolean) => {
    set(v);
    if (notify) onSelect(v);
  };
  el.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = list[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length];
    next.focus();
    choose(next.dataset.value as T, true);
  });
  set(value);
  options.forEach((o, i) => {
    buttons[i].disabled = !!o.disabled;
  });
  return {
    el,
    set,
    setDisabled(v, disabled, title) {
      const b = buttons.find((x) => x.dataset.value === v);
      if (!b) return;
      b.disabled = disabled;
      if (title !== undefined) b.title = title;
    },
  };
}

export function row(label: string, control: Node, hint?: string): HTMLElement {
  return h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-label' }, label), hint ? h('div', { class: 'row-hint' }, hint) : null), control);
}

export function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id, class: 'row-label' }, label), input, hint ? h('div', { class: 'row-hint' }, hint) : null);
}
