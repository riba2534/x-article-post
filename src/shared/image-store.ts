// Holds prepared image data outside runtime messages, which Chrome caps at 64 MB.
// All extension pages (side panel, offscreen) and the service worker share this IndexedDB origin.
import type { PreparedImage } from './types';

const DB_NAME = 'xap-images';
const STORE = 'images';
/** Entries older than this are dropped on the next write (runs that crashed before cleanup). */
const STALE_MS = 6 * 60 * 60 * 1000;

interface Entry {
  key: string;
  runId: string;
  base64: string;
  at: number;
}

const available = (): boolean => typeof indexedDB !== 'undefined';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('runId', 'runId');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Moves image bytes into the store and returns copies with an empty `base64`.
 * Without IndexedDB (unit tests, Node) images are returned unchanged.
 */
export async function stashImages(runId: string, images: Record<string, PreparedImage>): Promise<Record<string, PreparedImage>> {
  if (!available()) return images;
  const now = Date.now();
  await tx('readwrite', (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if ((c.value as Entry).at < now - STALE_MS) c.delete();
      c.continue();
    };
    for (const img of Object.values(images)) {
      store.put({ key: `${runId}/${img.id}`, runId, base64: img.base64, at: now } satisfies Entry);
    }
  });
  return Object.fromEntries(Object.entries(images).map(([id, img]) => [id, { ...img, base64: '' }]));
}

/** Returns the image with its data, reading the store when the data was stashed. */
export async function loadImage(runId: string, image: PreparedImage): Promise<PreparedImage | undefined> {
  if (image.base64 || !available()) return image.base64 ? image : undefined;
  const entry = await tx<Entry | undefined>('readonly', (store) => store.get(`${runId}/${image.id}`) as IDBRequest<Entry | undefined>);
  return entry ? { ...image, base64: entry.base64 } : undefined;
}

export async function dropImages(runId: string): Promise<void> {
  if (!available()) return;
  await tx('readwrite', (store) => {
    const cursor = store.index('runId').openCursor(IDBKeyRange.only(runId));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      c.delete();
      c.continue();
    };
  });
}
