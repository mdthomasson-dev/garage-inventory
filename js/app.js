/* global jsQR */
import * as db from './db.js';
import * as ai from './gemini.js';
import { resizeImage } from './image.js';
import { qrSvg, parseCode } from './qr.js';
import { settings, saveSettings, DEFAULT_MODEL } from './settings.js';

const tabs = document.querySelector('.tabs');

const view = document.getElementById('view');
let cleanups = [];

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = view) => root.querySelector(sel);
const onCleanup = (fn) => cleanups.push(fn);

function objUrl(blob) {
  const u = URL.createObjectURL(blob);
  onCleanup(() => URL.revokeObjectURL(u));
  return u;
}

const go = (hash) => {
  location.hash = hash;
};

export const boxUrl = (code) => `${location.origin}${location.pathname}#/box/${encodeURIComponent(code)}`;

let toastTimer;
/** Shows a short message; with `action` ({ label, href }) it stays longer and has a tappable link. */
function toast(msg, action = null) {
  const t = document.getElementById('toast');
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const a = document.createElement('a');
    a.href = action.href;
    a.textContent = action.label;
    a.addEventListener('click', () => t.classList.remove('show'));
    t.appendChild(a);
  }
  t.classList.toggle('actionable', Boolean(action));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 9000 : 2600);
}

// ---------- Gemini photo jobs that run in the background ----------

const aiJobs = new Map(); // job id -> { id, photoId, boxCode, status: running|added|empty|error, result, error, added, bumped }
let aiStatusListener = null; // set while a box page is open: (boxCode, boxChanged) => redraw

/** Adds Gemini's items to the box (merging with ones already there), remembering what changed for Undo. */
async function applyAiResult(job) {
  job.added = [];
  job.bumped = [];
  job.namedBox = false;
  await db.updateBox(job.boxCode, (b) => {
    for (const p of job.result.items) {
      const existing = b.items.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
      if (existing) {
        existing.qty += p.qty;
        job.bumped.push({ id: existing.id, qty: p.qty });
      } else {
        const it = db.newItem({ name: p.name, qty: p.qty, category: p.category });
        b.items.push(it);
        job.added.push(it.id);
      }
    }
    if (!b.name && job.result.boxName) {
      b.name = job.result.boxName;
      job.namedBox = true;
    }
  });
}

async function undoAiResult(job) {
  await db.updateBox(job.boxCode, (b) => {
    b.items = b.items.filter((i) => !job.added.includes(i.id));
    for (const x of job.bumped) {
      const it = b.items.find((i) => i.id === x.id);
      if (it) it.qty = Math.max(1, it.qty - x.qty);
    }
    if (job.namedBox && b.name === job.result.boxName) b.name = '';
  });
}

/** Starts Gemini on a photo without blocking the screen; adds what it finds and tells you when it's done. */
function startIdentify(boxCode, photo, blob, existingItems) {
  if (!ai.hasKey()) {
    toast('Add your Gemini API key in Settings first.');
    return;
  }
  const job = { id: `${photo.id}:${Date.now()}`, photoId: photo.id, boxCode, status: 'running' };
  aiJobs.set(job.id, job);
  aiStatusListener?.(boxCode);
  (async () => {
    try {
      job.result = await ai.identifyItems(blob || (await db.fullBlob(photo)), existingItems || []);
      if (!aiJobs.has(job.id)) return; // dismissed while running
      if (job.result.items.length) {
        await applyAiResult(job);
        job.status = 'added';
      } else {
        job.status = 'empty';
      }
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
    }
    if (!aiJobs.has(job.id)) return;
    navigator.vibrate?.(job.status === 'added' ? [60, 50, 60] : 150);
    const n = job.result?.items.length || 0;
    const code = boxCode.replace('-', '\u2011'); // non-breaking hyphen keeps "BOX-001" on one line
    const msg =
      job.status === 'added'
        ? `✨ Added ${n} item${n === 1 ? '' : 's'} to ${code}`
        : job.status === 'empty'
          ? `Gemini couldn't make out items in that ${code} photo`
          : `Gemini had a problem with a ${code} photo`;
    const onThatBox = location.hash === `#/box/${encodeURIComponent(boxCode)}`;
    if (onThatBox) {
      aiStatusListener?.(boxCode, true);
      toast(msg);
    } else {
      toast(msg, { label: 'View', href: `#/box/${encodeURIComponent(boxCode)}` });
    }
  })();
}

function modal(html) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="sheet-panel" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const close = () => {
    wrap.remove();
    document.body.classList.remove('no-scroll');
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  onCleanup(close);
  return { el: wrap, close };
}

async function askForPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

async function createBox(code) {
  const box = await db.createBox(code);
  askForPersistentStorage();
  return box;
}

/** Shows a photo's thumbnail once it has downloaded (or comes out of the phone's cache). */
async function fillThumb(img, photo) {
  const blob = await db.thumbBlob(photo);
  if (blob && img.isConnected) img.src = objUrl(blob);
}

/** "Metal shelves · top left" — the section name plus the spot within it. */
const whereText = (b, sectionsById) => [sectionsById.get(b.sectionId)?.name, b.location].filter(Boolean).join(' · ');

const itemCount = (b) => (b.items || []).reduce((n, i) => n + (Number(i.qty) || 1), 0);

// ---------- router ----------

const routes = [
  [/^#?\/?$/, () => homeView()],
  [/^#\/box\/([^/?]+)$/, (m) => boxView(decodeURIComponent(m[1]))],
  [/^#\/section\/([^/?]+)$/, (m) => sectionView(decodeURIComponent(m[1]))],
  [/^#\/scan(?:\?(.*))?$/, (m) => scanView(new URLSearchParams(m[1] || ''))],
  [/^#\/labels(?:\?(.*))?$/, (m) => labelsView(new URLSearchParams(m[1] || ''))],
  [/^#\/ask$/, () => askView()],
  [/^#\/settings$/, () => settingsView()],
];

async function router({ keepScroll = false } = {}) {
  if (!ready) return;
  cleanups.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
  cleanups = [];
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    const tab = /^#\/(box|section)\//.test(hash) ? '#/' : hash.split('?')[0];
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === tab));
    try {
      await fn(m);
    } catch (e) {
      console.error(e);
      view.innerHTML = `<p class="error">Something went wrong: ${esc(e.message)}</p>`;
    }
    if (!keepScroll) window.scrollTo(0, 0);
    return;
  }
  go('#/');
}

let ready = false;
window.addEventListener('hashchange', () => router());

// ---------- home: list + search ----------

let lastQuery = '';

async function homeView() {
  const [allBoxes, sections] = await Promise.all([db.allBoxes(), db.allSections()]);
  const boxes = allBoxes.sort((a, b) => b.updatedAt - a.updatedAt);
  const sectionsById = new Map(sections.map((sec) => [sec.id, sec]));
  view.innerHTML = `
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search boxes and items…" autocomplete="off" value="${esc(lastQuery)}">
      <button class="btn primary" id="new">+ New box</button>
    </div>
    <div id="sections">
      <h2 class="strip-title">Sections</h2>
      <div class="sections-strip">
        ${sections
          .map((sec) => {
            const n = boxes.filter((b) => b.sectionId === sec.id).length;
            return `<a class="sec-card" href="#/section/${encodeURIComponent(sec.id)}">
              ${sec.thumbPath ? `<img data-sec="${esc(sec.id)}" alt="">` : '<div class="sec-img empty">🗄️</div>'}
              <span class="sec-name">${esc(sec.name || 'Unnamed section')}</span>
              <small>${n} box${n === 1 ? '' : 'es'}</small>
            </a>`;
          })
          .join('')}
        <label class="sec-card add">
          <div class="sec-img empty">📷</div>
          <span class="sec-name">Add section</span>
          <small>Take a photo</small>
          <input type="file" accept="image/*" capture="environment" class="visually-hidden" id="add-section">
        </label>
      </div>
    </div>
    <h2 class="strip-title">Boxes</h2>
    <div id="list" class="cards"></div>`;
  view.querySelectorAll('img[data-sec]').forEach((img) => fillSectionThumb(img, sectionsById.get(img.dataset.sec)));
  $('#add-section').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) addSectionFlow(file);
  });

  const firstPhoto = new Map();
  for (const p of await db.allPhotos()) if (!firstPhoto.has(p.boxCode)) firstPhoto.set(p.boxCode, p);

  const render = () => {
    lastQuery = $('#q').value;
    const terms = lastQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text) => terms.every((w) => text.includes(w));
    let html = '';
    let shown = 0;
    for (const b of boxes) {
      let hits = [];
      if (terms.length) {
        const boxHit = matches([b.code, b.name, b.location, b.notes, sectionsById.get(b.sectionId)?.name].join(' ').toLowerCase());
        hits = (b.items || []).filter((i) => matches([i.name, i.category].join(' ').toLowerCase()));
        if (!boxHit && !hits.length) continue;
      }
      shown++;
      html += `
        <a class="card" href="#/box/${encodeURIComponent(b.code)}">
          ${firstPhoto.has(b.code) ? `<img class="thumb" data-code="${esc(b.code)}" alt="">` : '<div class="thumb empty">📦</div>'}
          <div class="card-body">
            <div class="code">${esc(b.code)}</div>
            <div class="name">${esc(b.name || 'Unnamed box')}</div>
            <div class="meta">${whereText(b, sectionsById) ? `📍 ${esc(whereText(b, sectionsById))} · ` : ''}${itemCount(b)} item${itemCount(b) === 1 ? '' : 's'}</div>
            ${hits.length ? `<div class="hits">Has: ${hits.map((i) => `<mark>${esc(i.name)}</mark>${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ')}</div>` : ''}
          </div>
        </a>`;
    }
    if (!boxes.length) {
      html = `<div class="empty-state">
        <div class="big">📦</div>
        <h2>No boxes yet</h2>
        <p>Start by snapping a photo of each area of your garage with <b>Add section</b> above. Then tap <b>+ New box</b>, or go to <a href="#/labels">Labels</a> and print a sheet of blank QR labels to stick on your boxes first.</p>
        <p class="muted">Then take photos of what's inside — ${ai.hasKey() ? 'Gemini will list the items for you.' : 'add a Gemini key in <a href="#/settings">Settings</a> and AI will list the items for you.'}</p>
      </div>`;
    } else if (!shown) {
      html = `<p class="muted center">Nothing matches “${esc(lastQuery)}”. ${ai.hasKey() ? `<a href="#/ask">Ask Gemini instead?</a>` : ''}</p>`;
    }
    $('#list').innerHTML = html;
    $('#sections').hidden = terms.length > 0;
    view.querySelectorAll('img.thumb[data-code]').forEach((img) => fillThumb(img, firstPhoto.get(img.dataset.code)));
  };

  $('#q').addEventListener('input', render);
  $('#new').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const box = await createBox();
      go(`#/box/${encodeURIComponent(box.code)}`);
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  });
  render();
}

// ---------- a single box ----------

async function boxView(code) {
  let box = await db.getBox(code);
  if (!box) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🏷️</div>
        <h2>${esc(code)} isn't set up yet</h2>
        <p>This label hasn't been assigned to a box. Set it up now and add what's inside.</p>
        <button class="btn primary big" id="setup">Set up ${esc(code)}</button>
        <p><a href="#/">Back to boxes</a></p>
      </div>`;
    $('#setup').addEventListener('click', async () => {
      try {
        await createBox(code);
        router();
      } catch (err) {
        toast(err.message);
      }
    });
    return;
  }

  const [everyBox, sections] = await Promise.all([db.allBoxes(), db.allSections()]);
  const spots = [...new Set(everyBox.filter((b) => b.sectionId === box.sectionId).map((b) => b.location).filter(Boolean))].sort();

  view.innerHTML = `
    <div class="box-head">
      <a href="#/" class="back">‹ Boxes</a>
      <span class="code-badge">${esc(box.code)}</span>
    </div>
    <label class="field"><span>Name</span><input id="name" value="${esc(box.name)}" placeholder="e.g. Christmas lights"></label>
    <label class="field"><span>Section</span>
      <div class="row tight">
        <select id="section">
          <option value="">— No section —</option>
          ${sections.map((sec) => `<option value="${esc(sec.id)}" ${sec.id === box.sectionId ? 'selected' : ''}>${esc(sec.name || 'Unnamed section')}</option>`).join('')}
        </select>
        ${box.sectionId ? `<a class="btn small" href="#/section/${encodeURIComponent(box.sectionId)}">View</a>` : ''}
      </div>
    </label>
    ${sections.length ? '' : '<p class="muted small">Add sections (areas of your garage) from the Boxes tab.</p>'}
    <label class="field"><span>Spot in section</span><input id="location" list="locs" value="${esc(box.location)}" placeholder="e.g. top shelf, left"></label>
    <datalist id="locs">${spots.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>

    <section>
      <h2>Photos</h2>
      <div class="photos" id="photos"></div>
      <div id="ai-status"></div>
      <div class="row">
        <label class="btn primary">📷 Take photo<input type="file" accept="image/*" capture="environment" class="visually-hidden" id="cam"></label>
        <label class="btn">🖼️ From library<input type="file" accept="image/*" multiple class="visually-hidden" id="pick"></label>
      </div>
      ${ai.hasKey() ? '' : '<p class="muted small">Tip: add a Gemini key in <a href="#/settings">Settings</a> and the app will list items from your photos.</p>'}
    </section>

    <section>
      <h2>Contents <span class="muted" id="count"></span></h2>
      <form id="add-item" class="row">
        <input name="name" placeholder="Add an item…" required autocomplete="off">
        <input name="qty" type="number" min="1" value="1" class="qty" aria-label="Quantity">
        <button class="btn primary">Add</button>
      </form>
      <ul class="items" id="items"></ul>
    </section>

    <section>
      <h2>Notes</h2>
      <textarea id="notes" rows="3" placeholder="Anything else worth remembering">${esc(box.notes)}</textarea>
    </section>

    ${(() => {
      // Working along a section: go straight on to the next box, or back to the section.
      const sec = sections.find((x) => x.id === box.sectionId);
      if (!sec) return '';
      const id = encodeURIComponent(sec.id);
      return `<div class="next-box">
        <a class="btn primary big" href="#/scan?section=${id}">📷 Scan another box into ${esc(sec.name || 'this section')}</a>
        <a class="btn big" href="#/section/${id}">Done: back to ${esc(sec.name || 'section')}</a>
      </div>`;
    })()}

    <div class="row spread">
      <a class="btn" href="#/labels?codes=${encodeURIComponent(box.code)}">🖨️ Print label</a>
      <button class="btn danger" id="del">Delete box</button>
    </div>`;

  /** Applies a change to the latest copy of this box in the cloud, then redraws. */
  const change = async (fn) => {
    try {
      box = await db.updateBox(box.code, fn);
      renderItems();
      return true;
    } catch (err) {
      toast(err.message);
      return false;
    }
  };
  $('#section').addEventListener('change', async (e) => {
    const id = e.target.value || null;
    if (await change((b) => (b.sectionId = id))) {
      toast(id ? `Moved to ${sections.find((x) => x.id === id)?.name || 'section'}` : 'Removed from section');
      router({ keepScroll: true });
    }
  });
  for (const f of ['name', 'location', 'notes']) {
    $(`#${f}`).addEventListener('change', (e) => {
      const v = e.target.value.trim();
      change((b) => (b[f] = v));
    });
  }

  // --- items ---
  const renderItems = () => {
    const items = box.items || [];
    $('#count').textContent = items.length ? `(${itemCount(box)})` : '';
    $('#items').innerHTML = items.length
      ? items
          .map(
            (i) => `
        <li data-id="${esc(i.id)}">
          <span class="qty-badge">${i.qty}×</span>
          <span class="iname">${esc(i.name)}</span>
          ${i.category ? `<span class="tag">${esc(i.category)}</span>` : ''}
          <button class="icon" data-act="edit" aria-label="Edit">✎</button>
          <button class="icon" data-act="del" aria-label="Remove">✕</button>
        </li>`,
          )
          .join('')
      : '<li class="muted">Nothing listed yet. Add items above or take a photo.</li>';
  };

  $('#add-item').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    if (!name) return;
    const item = db.newItem({ name, qty: f.qty.value });
    f.reset();
    f.name.focus();
    change((b) => b.items.push(item));
  });

  $('#items').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const li = e.target.closest('li[data-id]');
    if (!btn || !li) return;
    const item = box.items.find((i) => i.id === li.dataset.id);
    if (!item) return;
    if (btn.dataset.act === 'del') {
      change((b) => (b.items = b.items.filter((i) => i.id !== item.id)));
    } else if (btn.dataset.act === 'edit') {
      li.innerHTML = `
        <form class="edit-item">
          <input name="name" value="${esc(item.name)}" required>
          <input name="qty" type="number" min="1" value="${item.qty}" class="qty">
          <input name="category" value="${esc(item.category)}" placeholder="Category" class="cat">
          <button class="btn primary">Save</button>
        </form>`;
      const form = li.querySelector('form');
      form.name.focus();
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const name = form.name.value.trim() || item.name;
        const qty = Math.max(1, Number(form.qty.value) || 1);
        const category = form.category.value.trim();
        change((b) => {
          const it = b.items.find((i) => i.id === item.id);
          if (it) Object.assign(it, { name, qty, category });
        });
      });
    }
  });

  // --- photos ---
  let photos = await db.photosFor(box.code);
  const renderPhotos = () => {
    $('#photos').innerHTML = photos.length
      ? photos.map((p) => `<button class="photo" data-id="${p.id}"><img alt="Photo of box contents"></button>`).join('')
      : '<p class="muted small">No photos yet.</p>';
    view.querySelectorAll('.photo').forEach((btn) => fillThumb(btn.querySelector('img'), photos.find((p) => p.id === btn.dataset.id)));
  };

  const addFiles = async (files) => {
    for (const file of files) {
      const busy = document.createElement('div');
      busy.className = 'photo uploading';
      busy.innerHTML = '<div class="spinner"></div>';
      $('#photos').querySelector('p')?.remove();
      $('#photos').appendChild(busy);
      try {
        const blob = await resizeImage(file, 1600);
        const thumb = await resizeImage(file, 360, 0.7);
        const photo = await db.addPhoto({ boxCode: box.code, blob, thumb });
        photos.push(photo);
        renderPhotos();
        // Gemini works in the background, so you can keep filling in the rest of the box.
        if (ai.hasKey() && settings.autoIdentify) startIdentify(box.code, photo, blob, box.items);
      } catch (err) {
        busy.remove();
        toast(err.message || 'Could not add that photo.');
      }
    }
  };
  for (const id of ['cam', 'pick']) {
    $(`#${id}`).addEventListener('change', (e) => {
      addFiles([...e.target.files]);
      e.target.value = '';
    });
  }

  $('#photos').addEventListener('click', (e) => {
    const btn = e.target.closest('.photo');
    if (!btn) return;
    const photo = photos.find((p) => p.id === btn.dataset.id);
    if (!photo) return;
    const m = modal(`
      <img class="full" alt="">
      <div class="row spread">
        <button class="btn primary" data-act="ai">✨ Identify items</button>
        <button class="btn danger" data-act="del">Delete photo</button>
        <button class="btn" data-close>Close</button>
      </div>`);
    db.fullBlob(photo)
      .then((b) => (m.el.querySelector('.full').src = objUrl(b)))
      .catch(() => toast("Couldn't load that photo."));
    m.el.querySelector('[data-act=ai]').addEventListener('click', () => {
      m.close();
      startIdentify(box.code, photo, null, box.items);
    });
    m.el.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!confirm('Delete this photo?')) return;
      try {
        await db.deletePhoto(photo);
      } catch (err) {
        toast(err.message);
        return;
      }
      photos = photos.filter((p) => p !== photo);
      m.close();
      renderPhotos();
    });
  });

  // --- AI: status of background Gemini jobs for this box ---
  const renderAiStatus = () => {
    const el = $('#ai-status');
    if (!el) return;
    const jobs = [...aiJobs.values()].filter((j) => j.boxCode === box.code);
    el.innerHTML = jobs
      .map((j) => {
        const close = `<button class="icon" data-dismiss="${esc(j.id)}" aria-label="Dismiss">✕</button>`;
        if (j.status === 'running')
          return `<div class="ai-job"><div class="spinner sm"></div><span>Gemini is looking at your photo… Keep working; the items will be added for you.</span>${close}</div>`;
        if (j.status === 'added') {
          const n = j.result.items.length;
          return `<div class="ai-job ready"><span>✨ Added ${n} item${n === 1 ? '' : 's'} from your photo</span><button class="btn small" data-undo="${esc(j.id)}">Undo</button>${close}</div>`;
        }
        if (j.status === 'empty')
          return `<div class="ai-job"><span>Gemini couldn't make out any items in one photo. Try one with better light or closer up.</span>${close}</div>`;
        return `<div class="ai-job problem"><span>${esc(j.error)}</span><button class="btn small" data-retry="${esc(j.id)}">Try again</button>${close}</div>`;
      })
      .join('');
  };
  /** Re-reads the box after Gemini added items, without disturbing anything you're typing. */
  const reloadBox = async () => {
    const fresh = await db.getBox(box.code);
    if (!fresh) return;
    box = fresh;
    renderItems();
    const nameInput = $('#name');
    if (nameInput && document.activeElement !== nameInput && !nameInput.value.trim()) nameInput.value = box.name;
  };
  aiStatusListener = (code, boxChanged) => {
    if (code !== box.code) return;
    renderAiStatus();
    if (boxChanged) reloadBox();
  };
  onCleanup(() => (aiStatusListener = null));

  $('#ai-status').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const job = aiJobs.get(t.dataset.undo || t.dataset.dismiss || t.dataset.retry);
    if (!job) return;
    if (t.dataset.dismiss) {
      aiJobs.delete(job.id);
      renderAiStatus();
    } else if (t.dataset.retry) {
      aiJobs.delete(job.id);
      const photo = photos.find((p) => p.id === job.photoId);
      if (photo) startIdentify(box.code, photo, null, box.items);
      else renderAiStatus();
    } else if (t.dataset.undo) {
      t.disabled = true;
      try {
        await undoAiResult(job);
        aiJobs.delete(job.id);
        renderAiStatus();
        await reloadBox();
        if (job.namedBox && $('#name').value === job.result.boxName) $('#name').value = box.name;
        toast('Removed what Gemini added');
      } catch (err) {
        t.disabled = false;
        toast(err.message);
      }
    }
  });

  $('#del').addEventListener('click', async () => {
    if (!confirm(`Delete ${box.code}${box.name ? ` (${box.name})` : ''} and all its photos? This can't be undone.`)) return;
    try {
      await db.deleteBox(box.code);
    } catch (err) {
      toast(err.message);
      return;
    }
    toast(`${box.code} deleted`);
    go('#/');
  });

  renderItems();
  renderPhotos();
  renderAiStatus();
}

// ---------- sections (areas of the garage) ----------

async function fillSectionThumb(img, sec) {
  const blob = await db.sectionThumb(sec);
  if (blob && img.isConnected) img.src = objUrl(blob);
}

/** Photo first, then a name (Gemini suggests one), then the new section opens. */
async function addSectionFlow(file) {
  let blob, thumb;
  try {
    blob = await resizeImage(file, 1600);
    thumb = await resizeImage(file, 480, 0.75);
  } catch (err) {
    toast(err.message);
    return;
  }
  const m = modal(`
    <h2>New section</h2>
    <img class="full" src="${objUrl(blob)}" alt="">
    <form id="sec-form">
      <label class="field"><span>Name</span><input name="name" required placeholder="e.g. Metal shelves by door" autocomplete="off"></label>
      <p class="muted small" id="sec-hint">${ai.hasKey() ? '✨ Gemini is suggesting a name…' : ''}</p>
      <div class="row spread">
        <button class="btn primary">Save section</button>
        <button class="btn" type="button" data-close>Cancel</button>
      </div>
    </form>`);
  const form = m.el.querySelector('#sec-form');
  let typed = false;
  form.name.addEventListener('input', () => (typed = true));
  if (ai.hasKey()) {
    ai.suggestSectionName(blob)
      .then((name) => {
        if (!m.el.isConnected) return;
        if (name && !typed) form.name.value = name;
        m.el.querySelector('#sec-hint').textContent = name ? 'Suggested by Gemini. Change it if you like.' : '';
      })
      .catch(() => m.el.isConnected && (m.el.querySelector('#sec-hint').textContent = ''));
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const sec = await db.createSection({ name: form.name.value, blob, thumb });
      m.close();
      toast('Section added');
      go(`#/section/${encodeURIComponent(sec.id)}`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Save section';
    }
  });
}

async function sectionView(id) {
  let sec = await db.getSection(id);
  if (!sec) {
    view.innerHTML = `<div class="empty-state"><h2>That section no longer exists</h2><p><a href="#/">Back to boxes</a></p></div>`;
    return;
  }
  const [boxes, allPhotos, sections] = await Promise.all([db.allBoxes(), db.allPhotos(), db.allSections()]);
  const secById = new Map(sections.map((x) => [x.id, x]));
  const here = boxes
    .filter((b) => b.sectionId === sec.id)
    .sort(
      (a, b) =>
        !a.location - !b.location || // boxes with a spot first
        (a.location || '').localeCompare(b.location || '', undefined, { numeric: true }) ||
        a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
  const others = boxes.filter((b) => b.sectionId !== sec.id).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const firstPhoto = new Map();
  for (const p of allPhotos) if (!firstPhoto.has(p.boxCode)) firstPhoto.set(p.boxCode, p);

  view.innerHTML = `
    <div class="box-head"><a href="#/" class="back">‹ Boxes</a></div>
    ${sec.photoPath ? '<button class="section-photo" id="sec-photo"><img alt="Photo of this section"></button>' : ''}
    <label class="field"><span>Section name</span><input id="sec-name" value="${esc(sec.name)}" placeholder="e.g. Metal shelves by door"></label>
    <h2>What's in this section <span class="muted">(${here.length} box${here.length === 1 ? '' : 'es'}, ${here.reduce((n, b) => n + itemCount(b), 0)} items)</span></h2>
    ${here.length ? '<input id="sec-q" type="search" placeholder="Search this section…" autocomplete="off">' : ''}
    <div class="cards" id="sec-boxes"></div>
    <a class="btn primary big" href="#/scan?section=${encodeURIComponent(sec.id)}">📷 Scan a box into this section</a>
    <div class="row">
      <button class="btn" id="new-here">+ New box here</button>
      ${others.length ? '<button class="btn" id="move-here">Move boxes here</button>' : ''}
    </div>
    <div class="row spread">
      <label class="btn">📷 ${sec.photoPath ? 'Retake photo' : 'Add photo'}<input type="file" accept="image/*" capture="environment" class="visually-hidden" id="sec-retake"></label>
      <button class="btn danger" id="sec-del">Delete section</button>
    </div>`;

  /** Each box with its full contents listed, so you can see everything in the section at a glance. */
  const renderHere = () => {
    const q = ($('#sec-q')?.value || '').toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const matches = (t) => terms.every((w) => t.includes(w));
    const MAX = 12;
    let html = '';
    for (const b of here) {
      let items = b.items || [];
      if (terms.length) {
        const boxHit = matches([b.code, b.name, b.location, b.notes].join(' ').toLowerCase());
        const hits = items.filter((i) => matches([i.name, i.category].join(' ').toLowerCase()));
        if (!boxHit && !hits.length) continue;
        if (!boxHit) items = hits;
      }
      const shown = terms.length ? items : items.slice(0, MAX);
      const more = items.length - shown.length;
      html += `<a class="card contents-card" href="#/box/${encodeURIComponent(b.code)}">
        ${firstPhoto.has(b.code) ? `<img class="thumb" data-code="${esc(b.code)}" alt="">` : '<div class="thumb empty">📦</div>'}
        <div class="card-body">
          <div class="code">${esc(b.code)}</div>
          <div class="name">${esc(b.name || 'Unnamed box')}</div>
          ${b.location ? `<div class="meta">📍 ${esc(b.location)}</div>` : ''}
          ${
            shown.length
              ? `<ul class="contents">${shown
                  .map((i) => `<li><span class="muted">${i.qty}×</span> ${terms.length ? `<mark>${esc(i.name)}</mark>` : esc(i.name)}</li>`)
                  .join('')}${more > 0 ? `<li class="muted">+ ${more} more…</li>` : ''}</ul>`
              : '<div class="meta">Nothing listed yet</div>'
          }
        </div>
      </a>`;
    }
    if (!here.length) html = '<p class="muted">No boxes in this section yet.</p>';
    else if (!html) html = `<p class="muted">Nothing in this section matches “${esc(q)}”.</p>`;
    $('#sec-boxes').innerHTML = html;
    view.querySelectorAll('#sec-boxes img.thumb[data-code]').forEach((img) => fillThumb(img, firstPhoto.get(img.dataset.code)));
  };
  renderHere();
  $('#sec-q')?.addEventListener('input', renderHere);

  if (sec.photoPath) {
    const img = $('#sec-photo img');
    db.sectionPhoto(sec)
      .then((b) => img.isConnected && (img.src = objUrl(b)))
      .catch(() => fillSectionThumb(img, sec));
    $('#sec-photo').addEventListener('click', () => {
      if (img.src) modal(`<img class="full" src="${img.src}" alt=""><div class="row"><button class="btn" data-close>Close</button></div>`);
    });
  }

  $('#sec-name').addEventListener('change', async (e) => {
    try {
      sec = await db.updateSection(sec.id, { name: e.target.value });
      toast('Name saved');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#new-here').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const box = await db.createBox(null, sec.id);
      askForPersistentStorage();
      go(`#/box/${encodeURIComponent(box.code)}`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });

  $('#move-here')?.addEventListener('click', () => {
    const m = modal(`
      <h2>Move boxes to ${esc(sec.name || 'this section')}</h2>
      <ul class="pick">${others
        .map(
          (b) => `<li><label class="check"><input type="checkbox" value="${esc(b.code)}">
          <b>${esc(b.code)}</b> ${esc(b.name || 'Unnamed box')} ${whereText(b, secById) ? `<span class="muted">· ${esc(whereText(b, secById))}</span>` : ''}</label></li>`,
        )
        .join('')}</ul>
      <div class="row spread"><button class="btn primary" id="do-move">Move</button><button class="btn" data-close>Cancel</button></div>`);
    m.el.querySelector('#do-move').addEventListener('click', async (e) => {
      const codes = [...m.el.querySelectorAll('input:checked')].map((cb) => cb.value);
      if (!codes.length) return m.close();
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        for (const code of codes) await db.updateBox(code, (b) => (b.sectionId = sec.id));
        m.close();
        toast(`Moved ${codes.length} box${codes.length === 1 ? '' : 'es'}`);
        router({ keepScroll: true });
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  });

  $('#sec-retake').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('Uploading photo…');
      await db.setSectionPhoto(sec, await resizeImage(file, 1600), await resizeImage(file, 480, 0.75));
      toast('Photo updated');
      router({ keepScroll: true });
    } catch (err) {
      toast(err.message);
    }
  });

  $('#sec-del').addEventListener('click', async () => {
    const msg = here.length
      ? `Delete “${sec.name || 'this section'}”? Its ${here.length} box${here.length === 1 ? '' : 'es'} will be kept, just not in any section.`
      : `Delete “${sec.name || 'this section'}”?`;
    if (!confirm(msg)) return;
    try {
      await db.deleteSection(sec);
      toast('Section deleted');
      go('#/');
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- scanner ----------

async function scanView(params = new URLSearchParams()) {
  // With ?section=<id>, every label scanned is put into that section (scan along a shelf, box after box).
  const sec = params.get('section') ? await db.getSection(params.get('section')) : null;
  const secHref = sec ? `#/section/${encodeURIComponent(sec.id)}` : '';

  view.innerHTML = `
    ${
      sec
        ? `<div class="box-head"><a href="${secHref}" class="back">‹ ${esc(sec.name || 'Section')}</a></div>
           <h1>Scan a box into “${esc(sec.name || 'this section')}”</h1>`
        : '<h1>Scan a label</h1>'
    }
    <div class="scanner"><video playsinline muted autoplay></video><div class="frame"></div></div>
    <p class="muted center" id="status">Starting camera…</p>
    <form id="manual" class="row">
      <input name="code" placeholder="Or type a code, e.g. BOX-007" autocapitalize="characters" autocomplete="off">
      <button class="btn">Go</button>
    </form>
    ${
      sec
        ? `<a class="btn big" href="${secHref}">Cancel</a>`
        : '<p class="muted small center">Your phone\'s normal camera app can scan the labels too — they open straight to the box.</p>'
    }`;

  const status = $('#status');
  const video = $('video');
  let active = true;
  let stream;
  onCleanup(() => {
    active = false;
    stream?.getTracks().forEach((t) => t.stop());
  });

  // --- what happens with a scanned code ---
  let busy = false;
  const handleCode = async (code) => {
    if (!sec) {
      navigator.vibrate?.(60);
      go(`#/box/${encodeURIComponent(code)}`);
      return true; // stop scanning
    }
    // Section mode: put this box in the section, then open its page to fill it in.
    if (busy) return false;
    busy = true;
    status.textContent = `Putting ${code} in ${sec.name || 'this section'}…`;
    try {
      const existing = await db.getBox(code);
      if (!existing) await db.createBox(code, sec.id);
      else if (existing.sectionId !== sec.id) await db.updateBox(code, (b) => (b.sectionId = sec.id));
      navigator.vibrate?.(80);
      toast(
        !existing
          ? `${code} added to ${sec.name || 'this section'}`
          : existing.sectionId === sec.id
            ? `${code} is already in ${sec.name || 'this section'}`
            : `${code} moved to ${sec.name || 'this section'}`,
      );
      go(`#/box/${encodeURIComponent(code)}`);
      return true;
    } catch (err) {
      status.textContent = err.message;
      busy = false;
      return false;
    }
  };

  $('#manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = parseCode(e.target.code.value);
    if (!code) return toast('Codes look like BOX-007');
    e.target.reset();
    await handleCode(code);
  });

  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "This browser can't use the camera here. Use your phone's camera app, or type the code below.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch {
    status.textContent = 'Camera permission was blocked. Allow camera access for this site, or type the code below.';
    return;
  }
  if (!active) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* autoplay attr covers it */
  }
  status.textContent = sec ? `Point the camera at the label of the box to put in ${sec.name || 'this section'}.` : 'Point the camera at a box label.';

  let detector = null;
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      detector = new BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch {
    detector = null;
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async () => {
    if (!active) return;
    if (video.readyState >= 2 && video.videoWidth) {
      let text = null;
      try {
        if (detector) {
          text = (await detector.detect(video))[0]?.rawValue;
        } else if (window.jsQR) {
          const s = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * s);
          canvas.height = Math.round(video.videoHeight * s);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data;
        }
      } catch {
        /* keep trying */
      }
      if (text && active) {
        const code = parseCode(text);
        if (code) {
          if (await handleCode(code)) return;
        } else {
          status.textContent = "That QR code isn't one of your box labels.";
        }
      }
    }
    setTimeout(tick, 180);
  };
  tick();
}

// ---------- labels ----------

/** Pre-cut sticker sheets the app can print onto exactly (inches, US Letter). */
const SHEET_TEMPLATES = {
  avery8163: { name: 'Avery 8163 / 5163 (2×4)', cols: 2, rows: 5, w: 4, h: 2, top: 0.5, left: 0.15625, gapX: 0.1875, gapY: 0 },
};

const readNum = (key, fallback = 0) => {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const saveNum = (key, v) => {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* ignore */
  }
};

async function labelsView(params) {
  const [labelBoxes, labelSections, nextNumber] = await Promise.all([db.allBoxes(), db.allSections(), db.nextCodeNumber()]);
  const boxes = labelBoxes.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const secById = new Map(labelSections.map((x) => [x.id, x]));
  const boxByCode = new Map(boxes.map((b) => [b.code, b]));
  const selected = new Set((params.get('codes') || '').split(',').filter(Boolean));
  let blanks = []; // numbers, not yet claimed
  let size = localStorage.getItem('label-size') || 'medium';
  let next = nextNumber;

  view.innerHTML = `
    <h1>Print labels</h1>
    <p class="muted">Make <b>blank labels</b> to stick on boxes now and fill in later (scanning one lets you set it up), and/or pick existing boxes to print their labels.</p>

    <section>
      <h2>Blank labels</h2>
      <div class="row">
        <label class="inline">How many <input type="number" id="nblank" min="1" max="200" value="12" class="qty" inputmode="numeric"></label>
        <label class="inline">Start at <span class="code-prefix">BOX-</span><input type="number" id="start" min="1" max="99999" value="${next}" class="qty" inputmode="numeric"></label>
      </div>
      <p class="muted small" id="range-note"></p>
      <div class="row">
        <button class="btn primary" id="mkblank">Make labels</button>
        <button class="btn" id="clrblank" hidden>Remove blank labels</button>
      </div>
    </section>

    ${
      boxes.length
        ? `<section>
            <h2>Existing boxes</h2>
            <div class="row"><button class="btn small" id="all">Select all</button><button class="btn small" id="none">Unselect all</button></div>
            <ul class="pick">${boxes
              .map(
                (b) => `<li><label class="check"><input type="checkbox" value="${esc(b.code)}" ${selected.has(b.code) ? 'checked' : ''}>
                <b>${esc(b.code)}</b> ${esc(b.name || 'Unnamed box')} ${whereText(b, secById) ? `<span class="muted">· ${esc(whereText(b, secById))}</span>` : ''}</label></li>`,
              )
              .join('')}</ul>
          </section>`
        : ''
    }

    <section>
      <div class="row">
        <label class="inline">Label size
          <select id="size">
            <option value="small">Small · 1.5 in</option>
            <option value="medium">Medium · 2 in</option>
            <option value="large">Large · 3 in</option>
            <optgroup label="Sticker sheets (no cutting)">
              ${Object.entries(SHEET_TEMPLATES).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('')}
            </optgroup>
          </select>
        </label>
      </div>
      <div id="sheet-opts" hidden>
        <div class="row">
          <label class="inline">Skip first <input type="number" id="skip" min="0" max="9" value="0" class="qty" inputmode="numeric"> stickers</label>
        </div>
        <p class="muted small">For a sheet you've already used part of: stickers are counted left to right, top to bottom.</p>
        <details class="nudge">
          <summary>Fine-tune position</summary>
          <p class="muted small">Do a test print on plain paper and hold it against a sticker sheet up to the light. If it's off, nudge it here (millimetres; use minus numbers to go the other way). This phone remembers it.</p>
          <div class="row">
            <label class="inline">Right <input type="number" id="nudge-x" step="0.5" min="-15" max="15" class="qty" inputmode="decimal"> mm</label>
            <label class="inline">Down <input type="number" id="nudge-y" step="0.5" min="-15" max="15" class="qty" inputmode="decimal"> mm</label>
          </div>
        </details>
      </div>
      <div class="row">
        <button class="btn primary big" id="print">🖨️ Print <span id="n">0</span> labels</button>
      </div>
      <div class="row"><button class="btn" id="clear-sheet">🗑️ Clear sheet</button></div>
      <p class="muted small" id="print-tip"></p>
    </section>

    <h2>Preview</h2>
    <div id="print-sheet" class="label-sheet"></div>`;

  if (![...$('#size').options].some((o) => o.value === size)) size = 'medium';
  $('#size').value = size;
  $('#skip').value = 0;
  $('#nudge-x').value = readNum('label-nudge-x');
  $('#nudge-y').value = readNum('label-nudge-y');

  // The printer page margins: none for sticker sheets (we position everything ourselves).
  const pageStyle = document.createElement('style');
  document.head.appendChild(pageStyle);
  onCleanup(() => pageStyle.remove());

  const labelHtml = (code) => {
    const b = boxByCode.get(code);
    return `${qrSvg(boxUrl(code))}
      <div class="label-text">
        <div class="label-code">${esc(code)}</div>
        ${b?.name ? `<div class="label-name">${esc(b.name)}</div>` : ''}
      </div>`;
  };

  /** Lays labels out on whole pages that match a pre-cut sticker sheet. */
  const sheetPages = (codes, t) => {
    const skip = Math.min(t.cols * t.rows - 1, Math.max(0, Math.floor(Number($('#skip').value) || 0)));
    const nx = Number($('#nudge-x').value) || 0;
    const ny = Number($('#nudge-y').value) || 0;
    const slots = [...Array(skip).fill(null), ...codes];
    const per = t.cols * t.rows;
    const pages = [];
    for (let i = 0; i < slots.length; i += per) pages.push(slots.slice(i, i + per));
    const style = `--cols:${t.cols};--w:${t.w}in;--h:${t.h}in;--gx:${t.gapX}in;--gy:${t.gapY}in;--top:calc(${t.top}in + ${ny}mm);--left:calc(${t.left}in + ${nx}mm)`;
    return pages
      .map(
        (pg) => `<div class="sheet-page" style="${style}">${pg
          .map((code) => (code ? `<div class="sticker">${labelHtml(code)}</div>` : '<div class="sticker skipped"></div>'))
          .join('')}</div>`,
      )
      .join('');
  };

  const fitPreview = () => {
    const sheet = $('#print-sheet');
    if (sheet?.classList.contains('sheets')) sheet.style.setProperty('--z', Math.min(1, view.clientWidth / (8.5 * 96 + 4)));
  };
  window.addEventListener('resize', fitPreview);
  onCleanup(() => window.removeEventListener('resize', fitPreview));

  const readRange = () => {
    const count = Math.min(200, Math.max(1, Math.floor(Number($('#nblank').value) || 1)));
    const start = Math.min(99999, Math.max(1, Math.floor(Number($('#start').value) || next)));
    return { count, start, end: Math.min(99999, start + count - 1) };
  };

  const describeRange = () => {
    const { start, end } = readRange();
    const used = [];
    for (let n = start; n <= end; n++) {
      const b = boxByCode.get(db.formatCode(n));
      if (b) used.push(b);
    }
    let note = `${db.formatCode(start)} to ${db.formatCode(end)}.`;
    if (start !== next) note += ` (Next unused number is ${next}.)`;
    if (used.length) {
      note += ` ⚠️ ${used.length === 1 ? `${used[0].code} already belongs to a box` : `${used.length} of these already belong to boxes`} — those labels will open the existing ${used.length === 1 ? 'box' : 'boxes'}.`;
    }
    $('#range-note').textContent = note;
  };

  const render = () => {
    const codes = [...boxes.filter((b) => selected.has(b.code)).map((b) => b.code), ...blanks.map(db.formatCode)];
    $('#n').textContent = codes.length;
    $('#print').disabled = !codes.length;
    $('#clrblank').hidden = !blanks.length;
    $('#mkblank').textContent = blanks.length ? 'Remake labels' : 'Make labels';
    const sheet = $('#print-sheet');
    const t = SHEET_TEMPLATES[size];
    $('#sheet-opts').hidden = !t;
    $('#print-tip').textContent = t
      ? `In the print dialog choose Letter paper, scale 100% (not "Fit to page"), margins "Default" or "None", and turn off headers/footers. Load the sticker sheet the way your printer takes paper.`
      : 'In the print dialog, set scale to 100% and turn off headers/footers. Full-sheet sticker paper or plain paper + clear packing tape both work.';
    pageStyle.textContent = t ? '@page { size: letter; margin: 0; }' : '@page { margin: 0.4in; }';
    if (!codes.length) {
      sheet.className = 'label-sheet';
      sheet.innerHTML = '<p class="muted">Nothing on the sheet yet. Make blank labels or pick boxes above.</p>';
      return;
    }
    if (t) {
      sheet.className = 'label-sheet sheets';
      sheet.innerHTML = sheetPages(codes, t);
      fitPreview();
      const pages = sheet.querySelectorAll('.sheet-page').length;
      $('#n').textContent = `${codes.length}`;
      $('#print').lastChild.textContent = ` labels (${pages} sheet${pages === 1 ? '' : 's'})`;
    } else {
      sheet.className = `label-sheet ${size}`;
      sheet.innerHTML = codes.map((code) => `<div class="label">${labelHtml(code)}</div>`).join('');
      $('#print').lastChild.textContent = ' labels';
    }
  };

  for (const id of ['nblank', 'start']) $(`#${id}`).addEventListener('input', describeRange);

  $('#mkblank').addEventListener('click', () => {
    const { start, end } = readRange();
    blanks = [];
    for (let n = start; n <= end; n++) blanks.push(n);
    render();
  });
  $('#clrblank').addEventListener('click', () => {
    blanks = [];
    render();
  });
  $('#clear-sheet').addEventListener('click', () => {
    blanks = [];
    selected.clear();
    view.querySelectorAll('.pick input').forEach((cb) => (cb.checked = false));
    render();
  });

  view.querySelectorAll('.pick input').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? selected.add(cb.value) : selected.delete(cb.value);
      render();
    }),
  );
  $('#all')?.addEventListener('click', () => {
    boxes.forEach((b) => selected.add(b.code));
    view.querySelectorAll('.pick input').forEach((cb) => (cb.checked = true));
    render();
  });
  $('#none')?.addEventListener('click', () => {
    selected.clear();
    view.querySelectorAll('.pick input').forEach((cb) => (cb.checked = false));
    render();
  });
  $('#skip').addEventListener('input', render);
  for (const [id, key] of [['nudge-x', 'label-nudge-x'], ['nudge-y', 'label-nudge-y']]) {
    $(`#${id}`).addEventListener('input', (e) => {
      saveNum(key, Math.max(-15, Math.min(15, Number(e.target.value) || 0)));
      render();
    });
  }
  $('#size').addEventListener('change', (e) => {
    size = e.target.value;
    try {
      localStorage.setItem('label-size', size);
    } catch {
      /* ignore */
    }
    render();
  });

  // Numbers are only marked as used when you actually print, so trying different amounts costs nothing.
  $('#print').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (blanks.length) {
      btn.disabled = true;
      try {
        await db.claimCodesThrough(Math.max(...blanks));
      } catch (err) {
        btn.disabled = false;
        if (!confirm(`${err.message}\n\nPrint anyway? (A new box might later get one of these numbers.)`)) return;
      }
      btn.disabled = false;
      next = Math.max(next, Math.max(...blanks) + 1);
      $('#start').value = next;
      describeRange();
    }
    window.print();
  });

  describeRange();
  render();
}

// ---------- ask AI ----------

async function askView() {
  const [boxes, sections] = await Promise.all([db.allBoxes(), db.allSections()]);
  const secById = new Map(sections.map((x) => [x.id, x]));
  view.innerHTML = `
    <h1>Ask about your stuff</h1>
    <p class="muted">Try “Where are the jumper cables?”, “Which boxes have camping gear?” or “Do I have any spare light bulbs?”</p>
    ${ai.hasKey() ? '' : '<p class="notice">Add your Gemini API key in <a href="#/settings">Settings</a> to use this.</p>'}
    <form id="ask">
      <textarea name="q" rows="2" required placeholder="Ask a question…"></textarea>
      <button class="btn primary big" ${ai.hasKey() ? '' : 'disabled'}>✨ Ask Gemini</button>
    </form>
    <div id="answer"></div>`;

  $('#ask').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return;
    const out = $('#answer');
    out.innerHTML = '<div class="center pad"><div class="spinner"></div></div>';
    try {
      const { answer, boxCodes } = await ai.askInventory(q, boxes, sections);
      const linked = boxCodes.map((c) => boxes.find((b) => b.code === c)).filter(Boolean);
      out.innerHTML = `
        <div class="answer">${esc(answer).replace(/\n/g, '<br>')}</div>
        <div class="cards">${linked
          .map(
            (b) => `<a class="card" href="#/box/${encodeURIComponent(b.code)}"><div class="thumb empty">📦</div><div class="card-body">
              <div class="code">${esc(b.code)}</div><div class="name">${esc(b.name || 'Unnamed box')}</div>
              <div class="meta">${whereText(b, secById) ? `📍 ${esc(whereText(b, secById))}` : ''}</div></div></a>`,
          )
          .join('')}</div>`;
    } catch (err) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
}

// ---------- settings ----------

async function settingsView() {
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) usage = `This phone's offline copy uses ${(est.usage / 1048576).toFixed(1)} MB.`;
  } catch {
    /* ignore */
  }
  const session = await db.getSession();
  const cfg = db.getConfig();

  view.innerHTML = `
    <h1>Settings</h1>

    <section>
      <h2>Account</h2>
      <p class="small">Signed in as <b>${esc(session?.user?.email)}</b>. Everyone in your household sees the same boxes and photos.</p>
      <div class="row"><button class="btn" id="signout">Sign out</button></div>
    </section>

    <section>
      <h2>Gemini AI</h2>
      <p class="muted small">Get a free API key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and paste it here. It's shared with your household, so it only needs entering once.</p>
      <label class="field"><span>API key</span>
        <div class="row tight"><input id="key" type="password" value="${esc(settings.apiKey)}" placeholder="AIza…" autocomplete="off" spellcheck="false">
        <button class="btn small" id="show" type="button">Show</button></div>
      </label>
      <label class="field"><span>Model</span>
        <select id="model">
          <option value="${DEFAULT_MODEL}">Automatic (recommended)</option>
          ${settings.model !== DEFAULT_MODEL ? `<option value="${esc(settings.model)}" selected>${esc(settings.model)}</option>` : ''}
        </select>
      </label>
      <p class="muted small" id="model-note">${settings.apiKey ? 'Loading the models your key can use…' : 'Add your key to see the available models.'}</p>
      <label class="check"><input type="checkbox" id="auto" ${settings.autoIdentify ? 'checked' : ''}> Identify items automatically when I add a photo</label>
      <label class="field"><span>What Gemini lists from a photo</span>
        <select id="detail">
          <option value="overview" ${settings.aiDetail !== 'detailed' ? 'selected' : ''}>Quick overview: a few broad groups (faster)</option>
          <option value="detailed" ${settings.aiDetail === 'detailed' ? 'selected' : ''}>Every item it can see (slower)</option>
        </select>
      </label>
      <div class="row"><button class="btn" id="test">Test key</button><span id="test-out" class="small"></span></div>
    </section>

    <section>
      <h2>Backup</h2>
      <p class="muted small">Everything is stored in your Supabase project. A backup file (with photos) is extra insurance. ${esc(usage)}</p>
      <div class="row">
        <button class="btn" id="export">⬇️ Export backup</button>
        <label class="btn">⬆️ Import backup<input type="file" accept="application/json,.json" class="visually-hidden" id="import"></label>
      </div>
      <p class="small" id="progress"></p>
    </section>

    <section>
      <h2>Install on your phone</h2>
      <p class="small"><b>iPhone:</b> open this page in Safari → Share button → <i>Add to Home Screen</i>.<br>
      <b>Android:</b> open in Chrome → ⋮ menu → <i>Install app</i> (or <i>Add to Home screen</i>).</p>
    </section>

    ${
      cfg.fromFile
        ? ''
        : `<section><h2>Supabase connection</h2><p class="muted small">Connected to ${esc(cfg.url)}.</p>
           <button class="btn small" id="reconfig">Change connection</button></section>`
    }`;

  $('#signout').addEventListener('click', async () => {
    await db.signOut();
    location.hash = '#/';
    boot();
  });
  $('#reconfig')?.addEventListener('click', () => {
    if (!confirm('Disconnect from this Supabase project on this phone?')) return;
    localStorage.removeItem('gi-sb-url');
    localStorage.removeItem('gi-sb-key');
    db.signOut().finally(() => location.reload());
  });

  const key = $('#key');
  key.addEventListener('change', async () => {
    settings.apiKey = key.value.trim();
    saveSettings();
    try {
      await db.setHouseholdSetting('gemini_api_key', settings.apiKey);
      toast('API key saved for the household');
      loadModels();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#show').addEventListener('click', (e) => {
    key.type = key.type === 'password' ? 'text' : 'password';
    e.target.textContent = key.type === 'password' ? 'Show' : 'Hide';
  });
  $('#model').addEventListener('change', async (e) => {
    settings.model = e.target.value || DEFAULT_MODEL;
    saveSettings();
    db.setHouseholdSetting('gemini_model', settings.model)
      .then(() => toast('Model saved for the household'))
      .catch((err) => toast(err.message));
  });
  const loadModels = async () => {
    if (!settings.apiKey) return;
    const note = $('#model-note');
    try {
      const models = await ai.listModels();
      const sel = $('#model');
      if (!sel) return;
      sel.innerHTML =
        `<option value="${DEFAULT_MODEL}">Automatic (recommended)</option>` +
        models
          .filter((m) => m.id !== DEFAULT_MODEL)
          .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}${/-latest$/.test(m.id) ? '' : ` · ${esc(m.id)}`}</option>`)
          .join('');
      if (![...sel.options].some((o) => o.value === settings.model)) {
        sel.insertAdjacentHTML('beforeend', `<option value="${esc(settings.model)}">${esc(settings.model)}</option>`);
      }
      sel.value = settings.model;
      note.textContent = 'Automatic uses Google\'s current Flash model and switches to Flash-Lite when it\'s busy. Flash models are fast and free-tier friendly; "Pro" models are smarter but slower with tighter free limits.';
    } catch (err) {
      note.textContent = `Couldn't load the model list: ${err.message}`;
    }
  };
  loadModels();
  $('#detail').addEventListener('change', (e) => {
    settings.aiDetail = e.target.value;
    saveSettings();
    toast(e.target.value === 'detailed' ? 'Gemini will list every item' : 'Gemini will give a quick overview');
  });
  $('#auto').addEventListener('change', (e) => {
    settings.autoIdentify = e.target.checked;
    saveSettings();
  });
  $('#test').addEventListener('click', async () => {
    if (key.value.trim() !== settings.apiKey) key.dispatchEvent(new Event('change'));
    settings.apiKey = key.value.trim();
    const out = $('#test-out');
    out.textContent = 'Testing…';
    out.className = 'small';
    try {
      const model = await ai.testKey();
      out.textContent = `✅ Key works! Using ${model}.`;
      out.className = 'small ok';
    } catch (err) {
      out.textContent = `❌ ${err.message}`;
      out.className = 'small error';
    }
  });
  const progress = (label) => (i, n) => ($('#progress').textContent = `${label} photo ${i} of ${n}…`);
  $('#export').addEventListener('click', async (e) => {
    e.target.disabled = true;
    let data;
    try {
      data = await db.exportAll(progress('Downloading'));
    } catch (err) {
      toast(err.message);
      return;
    } finally {
      e.target.disabled = false;
      $('#progress').textContent = '';
    }
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const name = `garage-inventory-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await db.importAll(JSON.parse(await file.text()), progress('Uploading'));
      toast(`Imported ${res.boxes} boxes and ${res.photos} photos`);
    } catch (err) {
      toast(err.message || 'Import failed');
    } finally {
      $('#progress').textContent = '';
    }
  });
}

// ---------- sign-in & first-run screens ----------

function gate(html) {
  ready = false;
  document.body.classList.add('signed-out');
  view.innerHTML = `<div class="gate">${html}</div>`;
}

function setupScreen() {
  gate(`
    <h1>Connect to Supabase</h1>
    <p class="muted small">One-time setup. In Supabase open your project → <b>Project Settings → API</b> and copy the Project URL and the <b>anon</b> (or <b>publishable</b>) key.
    To skip this step on every phone, put them in <code>js/config.js</code> instead.</p>
    <form id="cfg">
      <label class="field"><span>Project URL</span><input name="url" type="url" required placeholder="https://xxxx.supabase.co" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Anon / publishable key</span><input name="key" required autocapitalize="off" spellcheck="false"></label>
      <button class="btn primary big">Connect</button>
    </form>`);
  $('#cfg').addEventListener('submit', (e) => {
    e.preventDefault();
    db.saveConfig(e.target.url.value, e.target.key.value);
    boot();
  });
}

function loginScreen(message = '') {
  gate(`
    <div class="center"><img src="icons/icon-192.png" width="72" height="72" alt="" class="gate-icon"></div>
    <h1 class="center">Garage Inventory</h1>
    <p class="muted center small">Sign in with your Google account to see your household's boxes.</p>
    ${message ? `<p class="notice small">${message}</p>` : ''}
    <button class="btn big google" id="google" type="button">
      <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      Continue with Google
    </button>
    <p class="error small" id="login-err"></p>`);
  const err = $('#login-err');
  $('#google').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await db.signInWithGoogle(); // navigates away to Google
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

function friendlyAuthError(msg) {
  if (/signups? not allowed/i.test(msg))
    return `There's no account for that Google email yet. In Supabase, add it under Authentication → Users (tick Auto Confirm) and to garage_members, then try again.`;
  return msg;
}

function notMemberScreen(email) {
  gate(`
    <h1>Not on the household list</h1>
    <p><b>${esc(email)}</b> is signed in, but it isn't one of the household's email addresses yet.</p>
    <p class="small muted">In Supabase, open <b>Table Editor → garage_members</b> and add this email (or add it to the last lines of <code>supabase/setup.sql</code> and run it again). Then tap Try again.</p>
    <div class="row"><button class="btn primary" id="retry">Try again</button><button class="btn" id="out">Sign out</button></div>`);
  $('#retry').addEventListener('click', () => boot());
  $('#out').addEventListener('click', async () => {
    await db.signOut();
    boot();
  });
}

// ---------- live updates from other phones ----------

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!ready || document.querySelector('.modal')) return;
    const a = document.activeElement;
    if (a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return; // don't yank the page while someone's typing
    const h = location.hash || '#/';
    if (h === '#/' || h.startsWith('#/box/') || h.startsWith('#/section/')) router({ keepScroll: true });
  }, 700);
}

db.onStatus?.((isOnline) => document.body.classList.toggle('offline', !isOnline));
window.addEventListener('online', () => document.body.classList.remove('offline'));
window.addEventListener('offline', () => document.body.classList.add('offline'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSoon();
});

// ---------- start ----------

let unsubscribe = null;
let booting = null;

async function boot() {
  if (booting) return booting;
  booting = (async () => {
    unsubscribe?.();
    unsubscribe = null;
    if (!db.sb && !db.connect()) return setupScreen();

    let session;
    try {
      session = await db.getSession();
    } catch {
      session = null;
    }
    // Supabase sign-in links put tokens (or an error) in the URL; read the error, then tidy the URL.
    const params = new URLSearchParams(location.hash.replace(/^#\/?/, '') + '&' + location.search.slice(1));
    const authError = params.get('error_description');
    if (/access_token|error|type=/.test(location.hash + location.search)) history.replaceState(null, '', location.pathname + '#/');
    if (!session && authError) return loginScreen(esc(friendlyAuthError(authError)));
    if (!session) return loginScreen();

    let member = false;
    try {
      member = await db.isMember();
    } catch (err) {
      if (!navigator.onLine || /fetch|network|load failed/i.test(err.message)) member = true; // offline: trust the cached session
      else return loginScreen(esc(err.message));
    }
    if (!member) return notMemberScreen(session.user.email);

    try {
      const hs = await db.getHouseholdSettings();
      if (hs.gemini_api_key != null) settings.apiKey = hs.gemini_api_key;
      if (hs.gemini_model) settings.model = hs.gemini_model;
      saveSettings();
    } catch {
      /* offline: use the copy saved on this phone */
    }

    document.body.classList.remove('signed-out');
    unsubscribe = db.subscribe(() => {
      if (Date.now() - db.lastLocalWrite > 2500) refreshSoon();
    });
    ready = true;
    await router();
  })().finally(() => {
    booting = null;
  });
  return booting;
}

db.connect();
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // When a new version of the app finishes downloading, switch to it right away
  // (unless the app is being installed for the first time).
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update()))
    .catch(() => {});
}
