/* global supabase */
// Data lives in Supabase so everyone in the household shares it.
// A copy is kept on the phone (IndexedDB) so the app still opens and searches offline.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const BUCKET = 'garage-photos';
export let sb = null;

// ---------- connection config ----------

export function getConfig() {
  let url = SUPABASE_URL;
  let key = SUPABASE_ANON_KEY;
  try {
    url ||= localStorage.getItem('gi-sb-url') || '';
    key ||= localStorage.getItem('gi-sb-key') || '';
  } catch {
    /* ignore */
  }
  return { url: url.trim().replace(/\/(rest|auth)\/v1\/?$/, '').replace(/\/+$/, ''), key: key.trim(), fromFile: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY) };
}

export function saveConfig(url, key) {
  localStorage.setItem('gi-sb-url', url.trim());
  localStorage.setItem('gi-sb-key', key.trim());
}

export function connect() {
  const { url, key } = getConfig();
  if (!url || !key) return false;
  sb = supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  return true;
}

// ---------- auth ----------

const check = ({ data, error }) => {
  if (error) throw Object.assign(new Error(error.message || String(error)), { code: error.code, status: error.status });
  return data;
};

const appUrl = () => `${location.origin}${location.pathname}`;

export async function getSession() {
  return check(await sb.auth.getSession()).session;
}
export async function signInWithGoogle() {
  // Leaves the app for Google's sign-in page, then comes back here signed in.
  return check(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } }));
}
export async function signOut() {
  await sb.auth.signOut();
  await clearCache();
}
export async function isMember() {
  return check(await sb.rpc('garage_is_member')) === true;
}

// ---------- online / offline ----------

export let online = true;
export let lastLocalWrite = 0;
const listeners = new Set();
export const onStatus = (fn) => listeners.add(fn);
function setOnline(v) {
  if (online !== v) {
    online = v;
    listeners.forEach((fn) => fn(v));
  }
}
const isNetworkError = (e) =>
  !navigator.onLine || /fetch|network|load failed|timed? ?out|offline/i.test(`${e?.message} ${e?.name}`);

/** Run a read against Supabase; if the network is down, fall back to the phone's copy. */
async function readThrough(remote, local) {
  if (!navigator.onLine) {
    setOnline(false);
    return local();
  }
  try {
    const v = await remote();
    setOnline(true);
    return v;
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    setOnline(false);
    return local();
  }
}

const OFFLINE_MSG = "You're offline — changes need an internet connection.";

async function write(fn) {
  if (!navigator.onLine) {
    setOnline(false);
    throw new Error(OFFLINE_MSG);
  }
  try {
    const v = await fn();
    lastLocalWrite = Date.now();
    setOnline(true);
    return v;
  } catch (e) {
    if (isNetworkError(e)) {
      setOnline(false);
      throw new Error(OFFLINE_MSG);
    }
    throw e;
  }
}

// ---------- local cache (IndexedDB) ----------

let cachePromise;
function cache() {
  if (!cachePromise) {
    cachePromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('garage-inventory-cache', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('boxes', { keyPath: 'code' });
        db.createObjectStore('photos', { keyPath: 'id' }).createIndex('boxCode', 'boxCode');
        db.createObjectStore('blobs');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return cachePromise;
}
const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function tx(stores, mode, fn) {
  const db = await cache();
  const t = db.transaction(stores, mode);
  const result = await fn(t);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = t.onabort = () => reject(t.error);
  });
  return result;
}
const cacheGetAll = (store) => tx([store], 'readonly', (t) => req(t.objectStore(store).getAll()));
const cachePut = (store, values) => tx([store], 'readwrite', (t) => values.forEach((v) => t.objectStore(store).put(v)));
const cacheDelete = (store, keys) => tx([store], 'readwrite', (t) => keys.forEach((k) => t.objectStore(store).delete(k)));
const cacheReplace = (store, values) =>
  tx([store], 'readwrite', (t) => {
    const s = t.objectStore(store);
    s.clear();
    values.forEach((v) => s.put(v));
  });
async function clearCache() {
  try {
    await tx(['boxes', 'photos', 'blobs'], 'readwrite', (t) => ['boxes', 'photos', 'blobs'].forEach((s) => t.objectStore(s).clear()));
  } catch {
    /* ignore */
  }
}

// ---------- boxes ----------

const toBox = (r) => ({
  code: r.code,
  name: r.name || '',
  location: r.location || '',
  notes: r.notes || '',
  items: Array.isArray(r.items) ? r.items : [],
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});
const fromBox = (b) => ({
  code: b.code,
  name: b.name || '',
  location: b.location || '',
  notes: b.notes || '',
  items: b.items || [],
  updated_at: new Date().toISOString(),
});

const uid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
      );

export function newItem({ name, qty = 1, category = '' }) {
  return { id: uid(), name: name.trim(), qty: Math.max(1, Number(qty) || 1), category: (category || '').trim() };
}

export async function allBoxes() {
  return readThrough(
    async () => {
      const boxes = check(await sb.from('garage_boxes').select('*')).map(toBox);
      await cacheReplace('boxes', boxes);
      return boxes;
    },
    () => cacheGetAll('boxes'),
  );
}

export async function getBox(code) {
  return readThrough(
    async () => {
      const row = check(await sb.from('garage_boxes').select('*').eq('code', code).maybeSingle());
      if (!row) {
        await cacheDelete('boxes', [code]);
        return null;
      }
      const box = toBox(row);
      await cachePut('boxes', [box]);
      return box;
    },
    () => tx(['boxes'], 'readonly', (t) => req(t.objectStore('boxes').get(code))),
  );
}

export async function createBox(code) {
  return write(async () => {
    const [c] = code ? [code] : await reserveCodes(1);
    const { data, error } = await sb.from('garage_boxes').insert({ code: c }).select().single();
    if (error && error.code !== '23505') check({ error }); // 23505 = already exists (someone else just set it up)
    const box = data ? toBox(data) : await getBox(c);
    await cachePut('boxes', [box]);
    return box;
  });
}

/** Re-reads the box, applies `change`, and saves it — so two people editing don't wipe each other's items. */
export async function updateBox(code, change) {
  return write(async () => {
    const row = check(await sb.from('garage_boxes').select('*').eq('code', code).single());
    const box = toBox(row);
    change(box);
    const saved = toBox(check(await sb.from('garage_boxes').update(fromBox(box)).eq('code', code).select().single()));
    await cachePut('boxes', [saved]);
    return saved;
  });
}

export async function deleteBox(code) {
  return write(async () => {
    const photos = check(await sb.from('garage_photos').select('*').eq('box_code', code));
    const paths = photos.flatMap((p) => [p.path, p.thumb_path]);
    if (paths.length) check(await sb.storage.from(BUCKET).remove(paths));
    check(await sb.from('garage_boxes').delete().eq('code', code));
    await cacheDelete('boxes', [code]);
    await cacheDelete('photos', photos.map((p) => p.id));
    await cacheDelete('blobs', photos.flatMap((p) => [`t:${p.id}`, `f:${p.id}`]));
  });
}

export async function reserveCodes(n) {
  return write(async () => check(await sb.rpc('garage_reserve_codes', { n })));
}

// ---------- photos ----------

const toPhoto = (r) => ({ id: r.id, boxCode: r.box_code, path: r.path, thumbPath: r.thumb_path, createdAt: Date.parse(r.created_at) });

export async function allPhotos() {
  return readThrough(
    async () => {
      const photos = check(await sb.from('garage_photos').select('*').order('created_at')).map(toPhoto);
      await cacheReplace('photos', photos);
      return photos;
    },
    async () => (await cacheGetAll('photos')).sort((a, b) => a.createdAt - b.createdAt),
  );
}

export async function photosFor(boxCode) {
  return readThrough(
    async () => {
      const photos = check(await sb.from('garage_photos').select('*').eq('box_code', boxCode).order('created_at')).map(toPhoto);
      await cachePut('photos', photos);
      return photos;
    },
    async () =>
      (await tx(['photos'], 'readonly', (t) => req(t.objectStore('photos').index('boxCode').getAll(boxCode)))).sort(
        (a, b) => a.createdAt - b.createdAt,
      ),
  );
}

export async function addPhoto({ boxCode, blob, thumb }) {
  return write(async () => {
    const id = uid();
    const path = `${id}.jpg`;
    const thumbPath = `${id}-thumb.jpg`;
    const opts = { contentType: 'image/jpeg', upsert: false };
    check(await sb.storage.from(BUCKET).upload(path, blob, opts));
    check(await sb.storage.from(BUCKET).upload(thumbPath, thumb, opts));
    const row = check(await sb.from('garage_photos').insert({ id, box_code: boxCode, path, thumb_path: thumbPath }).select().single());
    await sb.from('garage_boxes').update({ updated_at: new Date().toISOString() }).eq('code', boxCode);
    const photo = toPhoto(row);
    await cachePut('photos', [photo]);
    await tx(['blobs'], 'readwrite', (t) => {
      t.objectStore('blobs').put(thumb, `t:${id}`);
      t.objectStore('blobs').put(blob, `f:${id}`);
    });
    return photo;
  });
}

export async function deletePhoto(photo) {
  return write(async () => {
    check(await sb.storage.from(BUCKET).remove([photo.path, photo.thumbPath]));
    check(await sb.from('garage_photos').delete().eq('id', photo.id));
    await cacheDelete('photos', [photo.id]);
    await cacheDelete('blobs', [`t:${photo.id}`, `f:${photo.id}`]);
  });
}

async function photoBlob(photo, full) {
  const key = `${full ? 'f' : 't'}:${photo.id}`;
  const cached = await tx(['blobs'], 'readonly', (t) => req(t.objectStore('blobs').get(key)));
  if (cached) return cached;
  const blob = check(await sb.storage.from(BUCKET).download(full ? photo.path : photo.thumbPath));
  await tx(['blobs'], 'readwrite', (t) => t.objectStore('blobs').put(blob, key));
  return blob;
}
export const thumbBlob = (photo) => photoBlob(photo, false).catch(() => null);
export const fullBlob = (photo) => photoBlob(photo, true);

// ---------- household settings (shared Gemini key) ----------

export async function getHouseholdSettings() {
  const rows = check(await sb.from('garage_settings').select('*'));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export async function setHouseholdSetting(key, value) {
  return write(async () => check(await sb.from('garage_settings').upsert({ key, value })));
}

// ---------- live updates ----------

export function subscribe(onChange) {
  const channel = sb
    .channel('inventory')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'garage_boxes' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'garage_photos' }, onChange)
    .subscribe();
  return () => sb.removeChannel(channel);
}

// ---------- backup ----------

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function exportAll(onProgress = () => {}) {
  const boxes = check(await sb.from('garage_boxes').select('*')).map(toBox);
  const photos = check(await sb.from('garage_photos').select('*').order('created_at')).map(toPhoto);
  const out = [];
  for (const [i, p] of photos.entries()) {
    onProgress(i + 1, photos.length);
    out.push({ boxCode: p.boxCode, createdAt: p.createdAt, blob: await blobToDataUrl(await fullBlob(p)), thumb: await blobToDataUrl(await photoBlob(p, false)) });
  }
  return { app: 'garage-inventory', version: 2, exportedAt: new Date().toISOString(), boxes, photos: out };
}

export async function importAll(data, onProgress = () => {}) {
  if (data?.app !== 'garage-inventory') throw new Error("That file isn't a Garage Inventory backup.");
  const boxes = data.boxes || [];
  if (boxes.length) {
    await write(async () => check(await sb.from('garage_boxes').upsert(boxes.map(fromBox))));
  }
  const photos = data.photos || [];
  for (const [i, p] of photos.entries()) {
    onProgress(i + 1, photos.length);
    const blob = await (await fetch(p.blob)).blob();
    const thumb = p.thumb ? await (await fetch(p.thumb)).blob() : blob;
    await addPhoto({ boxCode: p.boxCode, blob, thumb });
  }
  return { boxes: boxes.length, photos: photos.length };
}
