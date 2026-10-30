// Mermaid -> SVG (preview) and -> 2x PNG on white (upload). Mermaid is loaded lazily.
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

export async function renderMermaidSvg(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const id = `xap-mermaid-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch (err) {
    throw new Error(`Mermaid 语法错误：${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  } finally {
    // Mermaid leaves its scratch element behind when parsing fails.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

export async function mermaidToPng(code: string): Promise<NormalizedImage> {
  return svgToPng(await renderMermaidSvg(code), { scale: 2, background: '#ffffff' });
}
