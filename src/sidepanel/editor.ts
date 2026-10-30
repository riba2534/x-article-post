// CodeMirror 6 Markdown editor with a light theme.
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, drawSelection, keymap, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags as t } from '@lezer/highlight';

// Colours and font stacks come from the panel's CSS variables (styles.css :root).
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.18em', color: 'var(--text)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.1em', color: 'var(--text)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '650', color: 'var(--text)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: '#0066cc' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--text-1)' },
  { tag: t.quote, color: 'var(--text-1)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-2)' },
  { tag: t.list, color: 'var(--accent)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--card)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 16px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-meta-line': { color: 'var(--text-2)', fontSize: '13px' },
  // Lezer reads the closing front-matter fence as a setext heading; keep those lines plain.
  '.cm-meta-line span': { color: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', fontStyle: 'normal' },
  '.cm-code-line': { fontFamily: 'var(--mono)', fontSize: '13px', backgroundColor: 'var(--code-bg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(0,113,227,.18) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: '#a1a1a6' },
});

const codeLine = Decoration.line({ class: 'cm-code-line' });
const metaLine = Decoration.line({ class: 'cm-meta-line' });
/** Block nodes that can contain fenced code; other nodes are skipped without descending. */
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/** Last line number of a leading YAML front matter block, or 0. */
function frontMatterEnd(state: EditorState): number {
  const { doc } = state;
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return 0;
  for (let n = 2; n <= Math.min(doc.lines, 200); n++) if (doc.line(n).text.trim() === '---') return n;
  return 0;
}

function lineDecorations(view: EditorView, fmEnd: number): DecorationSet {
  const { doc } = view.state;
  const builder = new RangeSetBuilder<Decoration>();
  const mark = (fromLine: number, toLine: number, deco: Decoration) => {
    for (let n = fromLine; n <= toLine; n++) {
      const { from } = doc.line(n);
      builder.add(from, from, deco);
    }
  };
  mark(doc.lineAt(view.viewport.from).number, Math.min(fmEnd, doc.lineAt(view.viewport.to).number), metaLine);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'FencedCode') {
          const first = doc.lineAt(Math.max(node.from, from)).number;
          if (first > fmEnd) mark(first, doc.lineAt(Math.min(node.to, to)).number, codeLine);
          return false;
        }
        return CONTAINERS.has(node.name);
      },
    });
  }
  return builder.finish();
}

/** Fenced code stays monospace while prose uses the system font; front matter is dimmed. */
const fencedCode = ViewPlugin.fromClass(
  class {
    fmEnd: number;
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.fmEnd = frontMatterEnd(view.state);
      this.decorations = lineDecorations(view, this.fmEnd);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.fmEnd = frontMatterEnd(u.state);
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = lineDecorations(u.view, this.fmEnd);
    }
  },
  { decorations: (v) => v.decorations },
);

export interface Editor {
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
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        fencedCode,
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
