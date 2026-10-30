// Map Markdown fence info strings to highlight.js language names ('' = plain text).

const ALIASES: Record<string, string> = {
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  golang: 'go',
  mysql: 'sql',
  postgresql: 'pgsql',
  psql: 'pgsql',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'shell',
  'shell-session': 'shell',
  py: 'python',
  python3: 'python',
  toml: 'ini',
  conf: 'ini',
  jsonc: 'json',
  json5: 'json',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  node: 'javascript',
  yml: 'yaml',
  md: 'markdown',
  make: 'makefile',
  mk: 'makefile',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  rs: 'rust',
  kt: 'kotlin',
  docker: 'dockerfile',
  patch: 'diff',
  proto: 'protobuf',
  rb: 'ruby',
  ps1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  tex: 'latex',
  vim: 'vim',
  viml: 'vim',
  cs: 'csharp',
  'c#': 'csharp',
  'f#': 'fsharp',
  hs: 'haskell',
  ex: 'elixir',
  erl: 'erlang',
  pl: 'perl',
  gql: 'graphql',
  tf: 'hcl',
  terraform: 'hcl',
};

const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'dataview', 'cql', 'none', 'output', 'log']);

// highlight.js names accepted as-is (subset of the 191 bundled languages that people actually write).
const KNOWN = new Set([
  'c', 'cpp', 'go', 'sql', 'pgsql', 'bash', 'shell', 'python', 'ini', 'json', 'typescript', 'javascript',
  'yaml', 'markdown', 'makefile', 'cmake', 'xml', 'http', 'java', 'rust', 'kotlin', 'swift', 'dockerfile',
  'diff', 'nginx', 'protobuf', 'lua', 'php', 'ruby', 'css', 'scss', 'less', 'powershell', 'dos', 'objectivec',
  'latex', 'vim', 'csharp', 'fsharp', 'haskell', 'elixir', 'erlang', 'perl', 'graphql', 'hcl', 'scala',
  'r', 'dart', 'groovy', 'gradle', 'apache', 'awk', 'clojure', 'julia', 'matlab', 'nix', 'ocaml', 'prolog',
  'scheme', 'lisp', 'thrift', 'x86asm', 'armasm', 'wasm', 'zig', 'verilog', 'vhdl', 'properties',
  'csp', 'django', 'handlebars', 'twig', 'basic', 'fortran', 'pascal', 'delphi', 'coffeescript', 'crystal',
  'elm', 'nim', 'reasonml', 'sas', 'stata', 'tcl', 'vbnet', 'vbscript', 'xquery', 'pf', 'routeros',
]);

export function normalizeLanguage(lang: string): string {
  const name = (lang ?? '').trim().split(/[\s{,]/)[0].toLowerCase();
  if (PLAIN.has(name)) return '';
  const mapped = ALIASES[name] ?? name;
  return KNOWN.has(mapped) ? mapped : '';
}
