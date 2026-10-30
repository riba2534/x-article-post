// CodeMirror 6 Markdown editor with a light theme.
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags as t } from '@lezer/highlight';

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.18em', color: '#1d1d1f' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.1em', color: '#1d1d1f' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '650', color: '#1d1d1f' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: '#0066cc' },
  { tag: t.monospace, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', color: '#b4235a' },
  { tag: t.quote, color: '#6e6e73', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: '#86868b' },
  { tag: t.list, color: '#0071e3' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: '#fff', color: '#1d1d1f' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "PingFang SC", monospace',
    lineHeight: '1.7',
    padding: '6px 0',
  },
  '.cm-content': { padding: '8px 16px', caretColor: '#0071e3' },
  '.cm-line': { padding: '0' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,113,227,.04)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(0,113,227,.18) !important' },
  '.cm-cursor': { borderLeftColor: '#0071e3', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: '#a1a1a6' },
});

export interface Editor {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  goToLine(line: number): void;
}

export function createEditor(parent: HTMLElement, initial: string, onChange: () => void): Editor {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        placeholder('在这里写 Markdown，或拖入 .md 文件'),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 编辑器' }),
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange();
        }),
      ],
    }),
  });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    goToLine(line) {
      const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      view.focus();
    },
  };
}

