// All data lives on this device in IndexedDB. Nothing is sent anywhere
// except photos/text you explicitly send to Gemini.

const DB_NAME = 'garage-inventory';
const VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('boxes', { keyPath: 'code' });
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('boxCode', 'boxCode');
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

export const formatCode = (n) => `BOX-${String(n).padStart(3, '0')}`;

export function newBox(code) {
  const now = Date.now();
  return { code, name: '', location: '', notes: '', items: [], createdAt: now, updatedAt: now };
}

export function newItem({ name, qty = 1, category = '' }) {
  return { id: uid(), name: name.trim(), qty: Math.max(1, Number(qty) || 1), category: category.trim() };
}

export async function getBox(code) {
  return req((await store('boxes')).get(code));
}

export async function allBoxes() {
  return req((await store('boxes')).getAll());
}

export async function putBox(box) {
  box.updatedAt = Date.now();
  return req((await store('boxes', 'readwrite')).put(box));
}

export async function deleteBox(code) {
  const db = await open();
  const tx = db.transaction(['boxes', 'photos'], 'readwrite');
  tx.objectStore('boxes').delete(code);
  const photos = tx.objectStore('photos');
  const keys = await req(photos.index('boxCode').getAllKeys(code));
  keys.forEach((k) => photos.delete(k));
  return done(tx);
}

/** Hands out the next unused box codes (BOX-001, BOX-002, …). */
export async function reserveCodes(n) {
  const db = await open();
  const tx = db.transaction(['meta', 'boxes'], 'readwrite');
  const meta = tx.objectStore('meta');
  const [m, keys] = await Promise.all([req(meta.get('counter')), req(tx.objectStore('boxes').getAllKeys())]);
  let max = m?.value || 0;
  for (const k of keys) {
    const x = /^BOX-(\d+)$/.exec(k);
    if (x) max = Math.max(max, Number(x[1]));
  }
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(formatCode(++max));
  meta.put({ key: 'counter', value: max });
  await done(tx);
  return codes;
}

export async function addPhoto({ boxCode, blob, thumb }) {
  const photo = { id: uid(), boxCode, blob, thumb, createdAt: Date.now() };
  await req((await store('photos', 'readwrite')).put(photo));
  return photo;
}

export async function photosFor(boxCode) {
  const all = await req((await store('photos')).index('boxCode').getAll(boxCode));
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function firstPhoto(boxCode) {
  return req((await store('photos')).index('boxCode').get(boxCode));
}

export async function deletePhoto(id) {
  return req((await store('photos', 'readwrite')).delete(id));
}

// ---------- Backup ----------

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function exportAll() {
  const boxes = await allBoxes();
  const photos = await req((await store('photos')).getAll());
  const out = [];
  for (const p of photos) {
    out.push({
      id: p.id,
      boxCode: p.boxCode,
      createdAt: p.createdAt,
      blob: await blobToDataUrl(p.blob),
      thumb: p.thumb ? await blobToDataUrl(p.thumb) : null,
    });
  }
  const counter = await req((await store('meta')).get('counter'));
  return { app: 'garage-inventory', version: 1, exportedAt: new Date().toISOString(), counter: counter?.value || 0, boxes, photos: out };
}

export async function importAll(data) {
  if (data?.app !== 'garage-inventory') throw new Error("That file isn't a Garage Inventory backup.");
  const photos = [];
  for (const p of data.photos || []) {
    photos.push({
      ...p,
      blob: await (await fetch(p.blob)).blob(),
      thumb: p.thumb ? await (await fetch(p.thumb)).blob() : null,
    });
  }
  const db = await open();
  const tx = db.transaction(['boxes', 'photos', 'meta'], 'readwrite');
  for (const b of data.boxes || []) tx.objectStore('boxes').put(b);
  for (const p of photos) tx.objectStore('photos').put(p);
  const meta = tx.objectStore('meta');
  const cur = await req(meta.get('counter'));
  meta.put({ key: 'counter', value: Math.max(cur?.value || 0, data.counter || 0) });
  await done(tx);
  return { boxes: (data.boxes || []).length, photos: photos.length };
}
