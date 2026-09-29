const DB_NAME = 'frontier-eda-v4';
const STORE = 'workspace';
const KEY = 'active';

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveWorkspace(data) {
  const payload = { ...data, savedAt: new Date().toISOString(), version: 4 };
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(payload, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { backend: 'IndexedDB', payload };
  } catch {
    localStorage.setItem(`${DB_NAME}:${KEY}`, JSON.stringify(payload));
    return { backend: 'localStorage', payload };
  }
}

export async function loadWorkspace() {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  } catch {
    try { return JSON.parse(localStorage.getItem(`${DB_NAME}:${KEY}`) || 'null'); }
    catch { return null; }
  }
}

export async function clearWorkspace() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {}
  localStorage.removeItem(`${DB_NAME}:${KEY}`);
}
