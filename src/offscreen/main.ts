// Offscreen document: runs the prepare pipeline (needs DOM for Mermaid/canvas) for agent requests.
import { errorMessage } from '../pipeline/errors';
import { prepareWrite } from '../pipeline/prepare';
import type { RuntimeMessage } from '../shared/types';

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg?.type === 'xap:prepare') {
    prepareWrite(msg.markdown, msg.options ?? {}, msg.target, undefined, msg.title).then(
      ({ request, doc }) => sendResponse({ ok: true, request, doc }),
      (err) => sendResponse({ ok: false, error: errorMessage(err) }),
    );
    return true;
  }
  return false;
});
