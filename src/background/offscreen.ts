// Creates (or reuses) the single offscreen document that runs the pipeline (Mermaid, images).
const OFFSCREEN_URL = 'offscreen/offscreen.html';

let creating: Promise<void> | null = null;

async function exists(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  return contexts.length > 0;
}

export async function ensureOffscreen(): Promise<void> {
  if (await exists()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING, chrome.offscreen.Reason.BLOBS],
      justification: 'Render Mermaid diagrams and tables to PNG and normalize images for X Article drafts.',
    })
    .catch(async (e: unknown) => {
      // Lost a race with another caller: fine if the document is there now.
      if (!(await exists())) throw e;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}
