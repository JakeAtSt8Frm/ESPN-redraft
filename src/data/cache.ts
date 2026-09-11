/**
 * IndexedDB-backed cache for snapshot payloads.
 *
 * A league is about four megabytes of JSON — seventeen week files, the player
 * universe and last season's logs for the forecast model. Every file is keyed by
 * the snapshot's `generatedAt` stamp, so an entry never goes stale: a new
 * snapshot simply has new keys, and `cachePrune` drops the old stamp's entries
 * so the store holds one copy per league rather than one per refresh.
 */

const DB_NAME = 'espn-redraft-cache';
const DB_VERSION = 1;
const STORE = 'payloads';

interface CacheEntry<T> {
  key: string;
  value: T;
  storedAt: number;
  ttl: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    // Private browsing and some embedded webviews block IndexedDB entirely.
    // The app must still work, just without persistence.
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);

      request.onsuccess = () => {
        const entry = request.result as CacheEntry<T> | undefined;
        if (!entry) {
          resolve(null);
          return;
        }
        if (entry.ttl > 0 && Date.now() - entry.storedAt > entry.ttl) {
          resolve(null);
          return;
        }
        resolve(entry.value);
      };

      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheSet<T>(key: string, value: T, ttl: number): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value, storedAt: Date.now(), ttl } satisfies CacheEntry<T>);
      tx.oncomplete = () => resolve();
      // A write failure (usually a storage quota) must not break the app.
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function cacheClear(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Deletes every entry whose key starts with `prefix` and doesn't contain
 * `keep`. Used to drop a league's previous snapshot once a newer one is read.
 */
export async function cachePrune(prefix: string, keep: string): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const request = tx.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (key.startsWith(prefix) && !key.includes(keep)) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** TTLs, in milliseconds. */
export const TTL = {
  /**
   * A snapshot file is immutable under its stamp; the TTL only bounds how long
   * an abandoned league's copy can linger.
   */
  SNAPSHOT: 14 * 24 * 60 * 60 * 1000,
  /** The last index seen, kept so the app still opens offline. */
  INDEX: 30 * 24 * 60 * 60 * 1000,
  /** The redraft trade market moves daily. */
  MARKET: 6 * 60 * 60 * 1000,
} as const;

/**
 * Requests already running, keyed the same way as the store.
 *
 * A cache read is asynchronous, so two callers asking for the same key within a
 * few milliseconds both miss and both fetch — the write from the first has not
 * landed when the second reads. A single load mostly avoids that by construction
 * (its keys are distinct), but re-entry does not: StrictMode runs every effect
 * twice in development, and tapping refresh or flicking between leagues starts a
 * second load over the same keys as the first. Holding the promise makes the
 * second caller wait on the request already running rather than issue its own.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** True for a cancelled request, in either shape a runtime produces. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Fetches through the cache: returns the cached value when fresh, otherwise
 * fetches, stores and returns.
 */
export async function cached<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    try {
      return await existing;
    } catch (err) {
      /*
       * The request being shared carries its caller's AbortSignal, and that
       * caller may have walked away — switching league aborts the load in
       * flight. Their cancellation says nothing about this request, so it must
       * not be inherited: fall through and issue our own. Any other failure is a
       * real answer about the payload and is passed on.
       */
      if (!isAbort(err)) throw err;
    }
  }

  const request = (async () => {
    const hit = await cacheGet<T>(key);
    if (hit !== null) return hit;

    const value = await fetcher();
    // Fire-and-forget: a slow write shouldn't delay rendering.
    void cacheSet(key, value, ttl);
    return value;
  })();

  inFlight.set(key, request);
  // Cleared either way — a failed request must not be handed to the next caller,
  // who may well be a retry of the one that just failed. `then(clear, clear)`
  // rather than `finally`, which derives a promise that re-rejects: nothing
  // awaits this bookkeeping branch, so an aborted load reported it as an
  // unhandled rejection even though the caller below handles the same failure.
  const clear = () => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  };
  void request.then(clear, clear);

  return request;
}
