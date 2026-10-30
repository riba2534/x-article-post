// Evaluates dist/background.js in Node with chrome stubs: the service worker must load without a DOM.
const noop = () => {};
const ev = { addListener: noop, hasListener: () => false };
const handler = { get: (t, k) => (k in t ? t[k] : new Proxy(function () {}, handler)), apply: () => Promise.resolve(undefined) };
const stub = new Proxy({ runtime: new Proxy({ onMessage: ev, onConnect: ev, getManifest: () => ({ version: 't' }), id: 'x', getURL: (p) => 'chrome-extension://x/' + p }, handler), storage: new Proxy({ onChanged: ev, local: { get: async () => ({}), set: async () => {} } }, handler), alarms: new Proxy({ onAlarm: ev, create: noop }, handler) }, handler);
globalThis.chrome = stub;
globalThis.self = globalThis;
const { pathToFileURL } = await import('node:url');
await import(pathToFileURL(process.argv[2] || 'dist/background.js').href);
console.log('background.js evaluated OK');
