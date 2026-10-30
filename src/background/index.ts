// Service worker entry. Each area registers its own listeners.
import { initWriter } from './writer';
import { initBridge } from './bridge';

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

initWriter();
initBridge();
