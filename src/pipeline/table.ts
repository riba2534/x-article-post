// Markdown table (with images in cells) -> 2x PNG via SVG foreignObject. Cell images are
// inlined as data: URLs because an SVG used as an image cannot load external resources.
import { fetchImageBytes } from './fetch';
import { bytesToBase64, FONT_STACK, sniffMime, svgToPng, type NormalizedImage } from './image';
import { markdownToHtml } from './markdown-html';

const TABLE_WIDTH = 680;
const XHTML = 'http://www.w3.org/1999/xhtml';

export const TABLE_CSS = `
.xap-table{font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:#0f1419;background:#fff;padding:16px;width:${TABLE_WIDTH}px;box-sizing:border-box}
.xap-table table{border-collapse:collapse;width:100%}
.xap-table th,.xap-table td{border:1px solid #cfd9de;padding:8px 12px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.xap-table th{background:#f7f9f9;font-weight:700}
.xap-table img{max-width:100%;height:auto;display:block}
.xap-table code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px}
.xap-table a{color:#1d9bf0;text-decoration:none}
`;

async function inlineImages(root: HTMLElement): Promise<void> {
  await Promise.all(
    [...root.querySelectorAll('img')].map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      try {
        if (!src) throw new Error('missing src');
        const { bytes } = await fetchImageBytes(src);
        const mime = sniffMime(bytes);
        if (!mime) throw new Error('unknown image');
        img.setAttribute('src', `data:${mime};base64,${bytesToBase64(bytes)}`);
        await img.decode().catch(() => undefined);
      } catch {
        img.replaceWith(document.createTextNode(img.getAttribute('alt') || '[图片]'));
      }
    }),
  );
}

export async function tableToPng(markdown: string): Promise<NormalizedImage> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none';
  const box = document.createElement('div');
  box.className = 'xap-table';
  box.innerHTML = markdownToHtml(markdown);
  const style = document.createElement('style');
  style.textContent = TABLE_CSS;
  host.append(style, box);
  document.body.append(host);
  try {
    if (!box.querySelector('table')) throw new Error('不是表格');
    await inlineImages(box);
    const width = TABLE_WIDTH;
    const height = Math.ceil(box.getBoundingClientRect().height);
    const wrapper = document.createElementNS(XHTML, 'div');
    wrapper.append(style.cloneNode(true), box.cloneNode(true));
    const xhtml = new XMLSerializer().serializeToString(wrapper);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
    return await svgToPng(svg, { scale: 2, background: '#ffffff' });
  } finally {
    host.remove();
  }
}
