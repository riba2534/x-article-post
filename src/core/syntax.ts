// micromark/mdast extensions that align remark with the blog's Hugo goldmark setup:
// - `\( \)` inline and `\[ \]` / `$$ $$` display math (goldmark passthrough; CommonMark would eat `\(` as an escape);
// - CJK-friendly `*` emphasis flanking (bold right next to full-width punctuation and CJK letters).
// Types are kept local and loose on purpose: micromark's typings are transitive dependencies.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Code = number | null;
type State = (code: Code) => State | undefined;
interface Effects {
  enter(type: string): any;
  exit(type: string): any;
  consume(code: Code): void;
}
type Event = [string, any, any];

const BACKSLASH = 92;
const ASTERISK = 42;
const UNDERSCORE = 95;
const DOLLAR = 36;

/** micromark line ending codes (CR, LF, CRLF) are negative. */
function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

// ---------------------------------------------------------------------------
// Math passthrough: `\(...\)` inline, `\[...\]` and `$$...$$` display. Parsed at text level like a code
// span, so the content may share lines with the delimiters and span lines within one paragraph.

function createMathTokenizer(kind: 'tex' | 'dollar') {
  return function tokenizeMath(this: any, effects: Effects, ok: State, nok: State): State {
    let close = 0;
    let size = 0;
    let inData = false;

    // Content goes into data tokens; line endings get their own token (micromark requires it).
    const take = (code: Code) => {
      if (isLineEnding(code)) {
        if (inData) effects.exit('texMathData');
        inData = false;
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return;
      }
      if (!inData) effects.enter('texMathData');
      inData = true;
      effects.consume(code);
    };
    const finish = (code: Code) => {
      take(code);
      effects.exit('texMathData');
      effects.exit('texMath');
      return ok;
    };

    const start: State = (code) => {
      effects.enter('texMath');
      effects.consume(code);
      return open;
    };
    const open: State = (code) => {
      if (kind === 'dollar') {
        if (code !== DOLLAR) return nok(code);
      } else if (code === 40 || code === 91) {
        close = code === 40 ? 41 : 93;
      } else {
        return nok(code);
      }
      effects.consume(code);
      return inside;
    };
    const inside: State = (code) => {
      if (code === null) return nok(code);
      take(code);
      if (code === BACKSLASH) return escaped;
      if (code === DOLLAR && kind === 'dollar') return closing;
      size++;
      return inside;
    };
    // After a backslash: `\)`/`\]` closes TeX math; any other escaped char (`\\`, `\$`) is content.
    const escaped: State = (code) => {
      if (code === null) return nok(code);
      if (kind === 'tex' && code === close && size > 0) return finish(code);
      take(code);
      size++;
      return inside;
    };
    const closing: State = (code) => {
      if (code === DOLLAR && size > 0) return finish(code);
      size++;
      return inside(code);
    };
    return start;
  };
}

const texMathConstruct = { name: 'texMath', tokenize: createMathTokenizer('tex') };
const dollarMathConstruct = { name: 'dollarMath', tokenize: createMathTokenizer('dollar') };

const texMathFromMarkdown = {
  enter: {
    texMath(this: any, token: any) {
      this.enter({ type: 'texMath', value: '', display: false }, token);
    },
  },
  exit: {
    texMath(this: any, token: any) {
      const raw: string = this.sliceSerialize(token);
      const node = this.stack[this.stack.length - 1];
      node.display = raw[1] !== '(';
      node.value = raw.slice(2, -2);
      this.exit(token);
    },
  },
};

// ---------------------------------------------------------------------------
// Attention with CJK-friendly flanking. Adapted from micromark-core-commonmark (MIT, Titus Wormer).

function isCjk(code: Code): boolean {
  if (code === null) return false;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0xd800 && code <= 0xdfff)
  );
}

const PUNCT = /[\p{P}\p{S}]/u;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const SPACE = /\s/u;

/** 1 = whitespace, 2 = punctuation, undefined = other (same as micromark's classifyCharacter). */
function classify(code: Code): 1 | 2 | undefined {
  if (code === null || code < 0 || code === 32) return 1;
  if (code < 128) return code < 33 || code === 127 ? 1 : ASCII_PUNCT.test(String.fromCharCode(code)) ? 2 : undefined;
  const ch = String.fromCharCode(code);
  if (SPACE.test(ch)) return 1;
  if (PUNCT.test(ch)) return 2;
  return undefined;
}

function tokenizeAttention(this: any, effects: Effects, ok: State): State {
  const attentionMarkers: Code[] = this.parser.constructs.attentionMarkers.null;
  const previous: Code = this.previous;
  let marker: Code = null;
  const inside: State = (code) => {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    const token = effects.exit('attentionSequence');
    token._marker = marker;
    let before = classify(previous);
    let after = classify(code);
    if (marker === ASTERISK) {
      // CJK punctuation counts as a letter; ASCII punctuation next to CJK does not block flanking.
      if (isCjk(previous)) before = undefined;
      if (isCjk(code)) after = undefined;
      if (before === 2 && isCjk(code)) before = undefined;
      if (after === 2 && isCjk(previous)) after = undefined;
    }
    const open = !after || (after === 2 && before) || (attentionMarkers.includes(code) && code !== ASTERISK && code !== UNDERSCORE);
    const close = !before || (before === 2 && after) || (attentionMarkers.includes(previous) && previous !== ASTERISK && previous !== UNDERSCORE);
    token._open = Boolean(marker === ASTERISK ? open : open && (before || !close));
    token._close = Boolean(marker === ASTERISK ? close : close && (after || !open));
    return ok(code);
  };
  return (code) => {
    marker = code;
    effects.enter('attentionSequence');
    return inside(code);
  };
}

function len(token: any): number {
  return token.end.offset - token.start.offset;
}

function movePoint(point: any, offset: number) {
  point.column += offset;
  point.offset += offset;
  point._bufferIndex += offset;
}

function resolveInsideSpan(constructs: any[], events: Event[], context: any): Event[] {
  const called: unknown[] = [];
  for (const construct of constructs) {
    const resolve = construct.resolveAll;
    if (resolve && !called.includes(resolve)) {
      events = resolve(events, context);
      called.push(resolve);
    }
  }
  return events;
}

function resolveAllAttention(events: Event[], context: any): Event[] {
  let index = -1;
  while (++index < events.length) {
    if (events[index][0] !== 'enter' || events[index][1].type !== 'attentionSequence' || !events[index][1]._close) continue;
    let open = index;
    while (open--) {
      const opener = events[open][1];
      const closer = events[index][1];
      if (
        events[open][0] !== 'exit' ||
        opener.type !== 'attentionSequence' ||
        !opener._open ||
        opener._marker !== closer._marker
      ) {
        continue;
      }
      if ((opener._close || closer._open) && len(closer) % 3 && !((len(opener) + len(closer)) % 3)) continue;

      const use = len(opener) > 1 && len(closer) > 1 ? 2 : 1;
      const start = { ...opener.end };
      const end = { ...closer.start };
      movePoint(start, -use);
      movePoint(end, use);
      const kind = use > 1 ? 'strong' : 'emphasis';
      const openingSequence = { type: `${kind}Sequence`, start, end: { ...opener.end } };
      const closingSequence = { type: `${kind}Sequence`, start: { ...closer.start }, end };
      const text = { type: `${kind}Text`, start: { ...opener.end }, end: { ...closer.start } };
      const group = { type: kind, start: { ...openingSequence.start }, end: { ...closingSequence.end } };
      opener.end = { ...openingSequence.start };
      closer.start = { ...closingSequence.end };

      const next: Event[] = [];
      if (len(opener)) next.push(['enter', opener, context], ['exit', opener, context]);
      next.push(['enter', group, context], ['enter', openingSequence, context], ['exit', openingSequence, context], ['enter', text, context]);
      for (const event of resolveInsideSpan(context.parser.constructs.insideSpan.null, events.slice(open + 1, index), context)) next.push(event);
      next.push(['exit', text, context], ['enter', closingSequence, context], ['exit', closingSequence, context], ['exit', group, context]);
      let offset = 0;
      if (len(closer)) {
        offset = 2;
        next.push(['enter', closer, context], ['exit', closer, context]);
      }
      events.splice(open - 1, index - open + 3, ...next);
      index = open + next.length - offset - 2;
      break;
    }
  }
  for (const event of events) {
    if (event[1].type === 'attentionSequence') event[1].type = 'data';
  }
  return events;
}

const attentionConstruct = { name: 'attention', tokenize: tokenizeAttention, resolveAll: resolveAllAttention };

const syntax = {
  text: {
    [BACKSLASH]: texMathConstruct,
    [DOLLAR]: dollarMathConstruct,
    [ASTERISK]: attentionConstruct,
    [UNDERSCORE]: attentionConstruct,
  },
};

/** unified plugin registering both extensions (placed before the built-in constructs). */
export function remarkGoldmarkCompat(this: any) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(texMathFromMarkdown);
}
