import { describe, expect, it } from 'vitest';
import { normalizeLanguage } from '../../src/core';
import { decodeEntities, tokenizeHtml } from '../../src/core/html';
import { texToUnicode, toScript } from '../../src/core/math-unicode';

describe('normalizeLanguage', () => {
  it.each([
    ['c', 'c'], ['cpp', 'cpp'], ['C++', 'cpp'], ['go', 'go'], ['golang', 'go'], ['sql', 'sql'], ['MySQL', 'sql'],
    ['shell', 'bash'], ['sh', 'bash'], ['zsh', 'bash'], ['bash', 'bash'], ['console', 'shell'], ['python', 'python'],
    ['py', 'python'], ['ini', 'ini'], ['toml', 'ini'], ['json', 'json'], ['jsonc', 'json'], ['ts', 'typescript'],
    ['typescript', 'typescript'], ['js', 'javascript'], ['javascript', 'javascript'], ['yml', 'yaml'], ['yaml', 'yaml'],
    ['md', 'markdown'], ['markdown', 'markdown'], ['makefile', 'makefile'], ['cmake', 'cmake'], ['xml', 'xml'],
    ['html', 'xml'], ['http', 'http'], ['java', 'java'], ['rs', 'rust'], ['rust', 'rust'], ['kotlin', 'kotlin'],
    ['swift', 'swift'], ['dockerfile', 'dockerfile'], ['Dockerfile', 'dockerfile'], ['diff', 'diff'], ['nginx', 'nginx'],
    ['protobuf', 'protobuf'], ['proto', 'protobuf'], ['lua', 'lua'], ['php', 'php'], ['ruby', 'ruby'],
    ['text', ''], ['txt', ''], ['plain', ''], ['plaintext', ''], ['dataview', ''], ['cql', ''], ['', ''],
    ['go {linenos=true}', 'go'], ['brainfuck-ish', ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });
});

describe('texToUnicode', () => {
  it.each([
    ['x^2', 'x²'],
    ['a_1 + a_{10}', 'a₁ + a₁₀'],
    ['\\alpha \\le \\beta', 'α ≤ β'],
    ['n \\times m \\cdot k', 'n × m · k'],
    ['O(n \\log n)', 'O(n log n)'],
    ['\\sum_{i} x \\to \\infty', '∑ᵢ x → ∞'],
    ['x \\in \\{1, 2\\}', 'x ∈ {1, 2}'],
    ['a\\,b', 'a b'],
    ['\\text{cost} = 5', 'cost = 5'],
    ['{dp}[i][j]', 'dp[i][j]'],
    ['2^m-1', '2ᵐ-1'],
    ['P = 0.90^{10} \\approx 34.8\\%', 'P = 0.90¹⁰ ≈ 34.8%'],
    ['\\lfloor k/2 \\rfloor', '⌊ k/2 ⌋'],
    ['T\u200b', 'T'],
    ["f'(x)", 'f′(x)'],
  ])('%s -> %s', (tex, expected) => {
    expect(texToUnicode(tex)).toBe(expected);
  });

  it.each([['\\frac{a}{b}'], ['x^{q}'], ['\\unknown'], ['a \\\\ b'], ['\\begin{matrix}a&b\\end{matrix}'], ['{x'], ['']])('gives up on %s', (tex) => {
    expect(texToUnicode(tex)).toBeNull();
  });

  it('maps sup/sub text', () => {
    expect(toScript('2', 'sup')).toBe('²');
    expect(toScript('n+1', 'sub')).toBe('ₙ₊₁');
    expect(toScript('q', 'sup')).toBeNull();
  });
});

describe('html', () => {
  it('tokenizes tags, attributes, comments and raw-text elements', () => {
    expect(tokenizeHtml('<a href="x?a=1&amp;b=2" data-x=\'y\'>t</a><!-- c --><style>p{}</style><br/>')).toEqual([
      { kind: 'open', name: 'a', attrs: { href: 'x?a=1&b=2', 'data-x': 'y' }, selfClosing: false, raw: '<a href="x?a=1&amp;b=2" data-x=\'y\'>' },
      { kind: 'text', value: 't' },
      { kind: 'close', name: 'a', raw: '</a>' },
      { kind: 'comment', raw: '<!-- c -->' },
      { kind: 'open', name: 'style', attrs: {}, selfClosing: false, raw: '<style>' },
      { kind: 'close', name: 'style', raw: '</style>' },
      { kind: 'open', name: 'br', attrs: {}, selfClosing: true, raw: '<br/>' },
    ]);
  });

  it('leaves non-tags as text', () => {
    expect(tokenizeHtml('a < b <bits/stdc++.h>')).toEqual([{ kind: 'text', value: 'a < b <bits/stdc++.h>' }]);
  });

  it('decodes entities', () => {
    expect(decodeEntities('&lt;&#65;&#x42;&hellip;&unknown;&')).toBe('<AB…&unknown;&');
  });
});
