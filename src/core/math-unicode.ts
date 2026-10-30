// Best-effort conversion of simple inline TeX to plain Unicode text. Returns null when any
// construct cannot be represented faithfully, so the caller can fall back to the TeX source.

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', ' ': ' ',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ',
  n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  A: 'ᴬ', B: 'ᴮ', D: 'ᴰ', E: 'ᴱ', G: 'ᴳ', H: 'ᴴ', I: 'ᴵ', J: 'ᴶ', K: 'ᴷ', L: 'ᴸ', M: 'ᴹ', N: 'ᴺ',
  O: 'ᴼ', P: 'ᴾ', R: 'ᴿ', T: 'ᵀ', U: 'ᵁ', V: 'ⱽ', W: 'ᵂ',
  'α': 'ᵅ', 'β': 'ᵝ', 'γ': 'ᵞ', 'δ': 'ᵟ', 'θ': 'ᶿ', 'φ': 'ᵠ', 'χ': 'ᵡ', '′': '′', '*': '*', '∗': '*',
};

const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', ' ': ' ',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
  s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ', 'β': 'ᵦ', 'γ': 'ᵧ', 'ρ': 'ᵨ', 'φ': 'ᵩ', 'χ': 'ᵪ',
};

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', lt: '<', gt: '>', ll: '≪', gg: '≫',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔', implies: '⇒', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
  emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧', wedge: '∧',
  lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗', sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇',
  approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', mid: '|', parallel: '∥', perp: '⊥',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|',
  vert: '|', Vert: '‖', ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', prime: '′', angle: '∠', deg: 'deg',
  degree: '°', triangle: '△', square: '□', checkmark: '✓', top: '⊤', bot: '⊥', aleph: 'ℵ', hbar: 'ℏ', ell: 'ℓ',
  log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan', max: 'max', min: 'min',
  lim: 'lim', sup: 'sup', inf: 'inf', gcd: 'gcd', det: 'det', arg: 'arg', mod: 'mod', bmod: 'mod',
  quad: '  ', qquad: '    ', ',': ' ', ';': ' ', ':': ' ', ' ': ' ', '!': '', '%': '%', '&': '&', '#': '#',
  _: '_', '{': '{', '}': '}', $: '$', '|': '‖', '\\': '\n',
};

/** Commands whose single argument is copied as text. */
const TEXT_ARG = new Set(['text', 'mathrm', 'textrm', 'mathit', 'textit', 'mathbf', 'textbf', 'operatorname', 'mbox', 'mathsf', 'texttt', 'mathtt', 'boldsymbol', 'bm']);
/** Sizing/spacing commands that are dropped. */
const DROP = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'displaystyle', 'textstyle', 'limits', 'nolimits']);

class Fail extends Error {}

const COMMAND = /[A-Za-z]+/y;

export function texToUnicode(tex: string): string | null {
  const src = tex.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
  if (!src) return null;
  let pos = 0;

  const readCommand = (): string => {
    // At a backslash.
    pos++;
    COMMAND.lastIndex = pos;
    const m = COMMAND.exec(src);
    if (m) {
      pos += m[0].length;
      return m[0];
    }
    if (pos >= src.length) throw new Fail();
    return src[pos++];
  };

  const skipSpaces = () => {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
  };

  // Parse one argument: a group or a single token.
  const readArg = (): string => {
    skipSpaces();
    if (pos >= src.length) throw new Fail();
    const ch = src[pos];
    if (ch === '{') {
      pos++;
      const out = parseSeq('}');
      pos++;
      return out;
    }
    if (ch === '\\') return command(readCommand());
    if (ch === '}' || ch === '^' || ch === '_') throw new Fail();
    pos++;
    return ch;
  };

  const readRawGroup = (): string => {
    skipSpaces();
    if (src[pos] !== '{') throw new Fail();
    let depth = 0;
    const start = pos + 1;
    for (; pos < src.length; pos++) {
      if (src[pos] === '{') depth++;
      else if (src[pos] === '}' && --depth === 0) {
        pos++;
        return src.slice(start, pos - 1);
      }
    }
    throw new Fail();
  };

  const command = (name: string): string => {
    if (TEXT_ARG.has(name)) return readRawGroup().replace(/\\([{}%&#_$ ])/g, '$1');
    if (DROP.has(name)) return '';
    if (name === 'sqrt') {
      const arg = readArg();
      return arg.length === 1 ? `√${arg}` : `√(${arg})`;
    }
    if (name === 'not') {
      const arg = readArg();
      return `${arg}\u0338`;
    }
    const sym = SYMBOLS[name];
    if (sym === undefined) throw new Fail();
    return sym;
  };

  const script = (map: Record<string, string>): string => {
    const arg = readArg();
    let out = '';
    for (const ch of arg) {
      const mapped = map[ch];
      if (mapped === undefined) throw new Fail();
      out += mapped;
    }
    return out;
  };

  function parseSeq(end: string | null): string {
    let out = '';
    while (pos < src.length) {
      const ch = src[pos];
      if (end && ch === end) return out;
      if (ch === '}') throw new Fail();
      if (ch === '{') {
        pos++;
        out += parseSeq('}');
        if (src[pos] !== '}') throw new Fail();
        pos++;
      } else if (ch === '\\') {
        out += command(readCommand());
      } else if (ch === '^') {
        pos++;
        out += script(SUP);
      } else if (ch === '_') {
        pos++;
        out += script(SUB);
      } else if (ch === '~') {
        pos++;
        out += ' ';
      } else if (ch === '&') {
        throw new Fail();
      } else {
        pos++;
        out += ch === "'" ? '′' : ch;
      }
    }
    if (end) throw new Fail();
    return out;
  }

  try {
    const out = parseSeq(null).replace(/[ \t]+/g, ' ').trim();
    return out.includes('\n') ? null : out;
  } catch (error) {
    if (error instanceof Fail) return null;
    throw error;
  }
}

/** Unicode superscript/subscript for HTML <sup>/<sub> text; null when not every char maps. */
export function toScript(text: string, kind: 'sup' | 'sub'): string | null {
  const map = kind === 'sup' ? SUP : SUB;
  let out = '';
  for (const ch of text) {
    const mapped = map[ch];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}
