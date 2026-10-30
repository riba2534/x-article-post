// Block-level display math (goldmark passthrough): a line whose content starts with `$$` or `\[` opens a
// formula that runs, verbatim, to the next line ending with the closing `$$` / `\]` — blank lines and
// lines that look like Markdown (`- x`, `# x`, `> x`) included. CommonMark block parsing would break
// such formulas apart, so they are swapped for one-line placeholders before parsing and restored after.

/** Placeholder content; the text-level `$$` construct turns `$$<placeholder>$$` into a display math node. */
const PLACEHOLDER = /^\ue000(\d+)\ue001$/;

export interface MathExtraction {
  /** Source with every display math block replaced by a single `$$<placeholder>$$` line. */
  text: string;
  formulas: string[];
  /** 1-based line in `text` -> 1-based line in the original source. */
  lineMap: number[];
}

// Container prefix (block quotes, list markers) then up to 3 spaces of indentation.
// Marker spaces are taken greedily (`(?![ ])`) so the pattern cannot backtrack exponentially.
const OPEN = /^((?:[ ]{0,3}(?:>|(?:[-+*]|\d{1,9}[.)])[ ]+(?![ ])))*)[ ]{0,3}(\$\$|\\\[)/;
// Every repetition consumes a marker character, so this stays linear on long runs of spaces.
const FENCE = /^(?:[ ]*(?:>|[-+*][ ]|\d{1,9}[.)][ ]))*[ ]*(`{3,}|~{3,})/;

/** Index of the first unescaped closer at or after `from`, or -1. Code spans on the line are skipped. */
function findCloser(line: string, closer: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    const ch = line[i];
    if (ch === '`') {
      const run = /^`+/.exec(line.slice(i))![0];
      const end = line.indexOf(run, i + run.length);
      if (end >= 0) {
        i = end + run.length - 1;
        continue;
      }
    }
    if (ch === '\\' && closer === '$$') {
      i++; // `\$` is a literal dollar
      continue;
    }
    if (line.startsWith(closer, i)) {
      if (closer === '\\]') {
        let slashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
        if (slashes % 2) continue; // `\\]` is a TeX line break followed by `]`
      }
      return i;
    }
    // Inside `\[`, `\\` is one TeX token; do not read its second backslash as the start of `\]`.
    if (ch === '\\' && line[i + 1] === '\\') i++;
  }
  return -1;
}

/** Strip the container prefix of the opening line (`>` markers, list indentation) from a continuation line. */
function stripContainer(line: string, prefix: string): string {
  const quotes = (prefix.match(/>/g) ?? []).length;
  let rest = line;
  for (let q = 0; q < quotes; q++) rest = rest.replace(/^[ ]{0,3}>[ ]?/, '');
  const indent = prefix.replace(/[ ]{0,3}>[ ]?/g, '').length;
  return rest.replace(new RegExp(`^[ ]{0,${indent}}`), '');
}

export function extractDisplayMath(source: string): MathExtraction {
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMap: number[] = [0];
  const formulas: string[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keep = () => {
      out.push(line);
      lineMap.push(i + 1);
    };

    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      keep();
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      keep();
      continue;
    }

    const open = OPEN.exec(line);
    if (!open) {
      keep();
      continue;
    }
    const prefix = open[1];
    const closer = open[2] === '$$' ? '$$' : '\\]';
    const start = open[0].length;

    // Find the closer on this or a following line; it must end its line.
    let end = -1;
    let endLine = i;
    for (let j = i; j < lines.length; j++) {
      const text = j === i ? line : stripContainer(lines[j], prefix);
      if (j > i && FENCE.test(lines[j])) break;
      const at = findCloser(text, closer, j === i ? start : 0);
      if (at >= 0) {
        if (text.slice(at + closer.length).trim() === '') {
          end = at;
          endLine = j;
        }
        break;
      }
    }
    if (end < 0) {
      keep();
      continue;
    }

    const body: string[] = [];
    for (let j = i; j <= endLine; j++) {
      let text = j === i ? line.slice(start) : stripContainer(lines[j], prefix);
      if (j === endLine) text = text.slice(0, j === i ? end - start : end);
      body.push(text);
    }
    const tex = body.join('\n').trim();
    if (!tex) {
      keep();
      continue;
    }
    out.push(`${prefix}$$\ue000${formulas.length}\ue001$$`);
    lineMap.push(i + 1);
    formulas.push(tex);
    i = endLine;
  }
  return { text: out.join('\n'), formulas, lineMap };
}

/** Formula for a placeholder value, or undefined when `value` is not a placeholder. */
export function restoreFormula(value: string, formulas: string[]): string | undefined {
  const m = PLACEHOLDER.exec(value);
  return m ? formulas[Number(m[1])] : undefined;
}
