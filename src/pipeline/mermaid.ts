// Mermaid -> SVG (preview) and -> 2x PNG on white (upload). Mermaid is loaded lazily.
import { errorMessage } from './errors';
import { FONT_STACK, svgToPng, type NormalizedImage } from './image';

type Mermaid = typeof import('mermaid').default;

let loader: Promise<Mermaid> | null = null;
let seq = 0;

function loadMermaid(): Promise<Mermaid> {
  loader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'strict',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily: FONT_STACK,
      themeVariables: { fontFamily: FONT_STACK },
    });
    return mermaid;
  });
  return loader;
}

const cache = new Map<string, Promise<string>>();

/** Renders (and caches by source) so the preview and the upload share one layout pass. */
export function renderMermaidSvg(code: string): Promise<string> {
  let svg = cache.get(code);
  if (!svg) {
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    svg = render(code);
    svg.catch(() => cache.delete(code));
    cache.set(code, svg);
  }
  return svg;
}

async function render(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const id = `xap-mermaid-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch (err) {
    throw new Error(`Mermaid 语法错误：${errorMessage(err).split('\n')[0]}`);
  } finally {
    // Mermaid leaves its scratch element behind when parsing fails.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

export async function mermaidToPng(code: string): Promise<NormalizedImage> {
  return svgToPng(await renderMermaidSvg(code), { scale: 2, background: '#ffffff' });
}
