const DB_NAME = "freeflow-video-store";
const DB_VERSION = 1;
const STORE_NAME = "videos";

type StoredVideo = {
  key: string;
  createdAt: number;
  blob: Blob;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

export async function saveVideo(key: string, blob: Blob) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore(STORE_NAME);
    const record: StoredVideo = {
      key,
      blob,
      createdAt: Date.now(),
    };
    store.put(record);
  });
}

export async function getVideo(key: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => {
      const result = request.result as StoredVideo | undefined;
      resolve(result?.blob);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteVideo(key: string) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_NAME).delete(key);
  });
}
