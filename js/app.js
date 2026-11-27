/* global jsQR */
import * as db from './db.js';
import * as ai from './gemini.js';
import { resizeImage } from './image.js';
import { qrSvg, parseCode } from './qr.js';
import { settings, saveSettings, DEFAULT_MODEL } from './settings.js';

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
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
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
  const [c] = code ? [code] : await db.reserveCodes(1);
  const box = db.newBox(c);
  await db.putBox(box);
  askForPersistentStorage();
  return box;
}

const itemCount = (b) => (b.items || []).reduce((n, i) => n + (Number(i.qty) || 1), 0);

// ---------- router ----------

const routes = [
  [/^#?\/?$/, () => homeView()],
  [/^#\/box\/([^/?]+)$/, (m) => boxView(decodeURIComponent(m[1]))],
  [/^#\/scan$/, () => scanView()],
  [/^#\/labels(?:\?(.*))?$/, (m) => labelsView(new URLSearchParams(m[1] || ''))],
  [/^#\/ask$/, () => askView()],
  [/^#\/settings$/, () => settingsView()],
];

async function router() {
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
    const tab = hash.startsWith('#/box') ? '#/' : hash.split('?')[0];
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === tab));
    try {
      await fn(m);
    } catch (e) {
      console.error(e);
      view.innerHTML = `<p class="error">Something went wrong: ${esc(e.message)}</p>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  go('#/');
}

window.addEventListener('hashchange', router);

// ---------- home: list + search ----------

let lastQuery = '';

async function homeView() {
  const boxes = (await db.allBoxes()).sort((a, b) => b.updatedAt - a.updatedAt);
  view.innerHTML = `
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search boxes and items…" autocomplete="off" value="${esc(lastQuery)}">
      <button class="btn primary" id="new">+ New box</button>
    </div>
    <div id="list" class="cards"></div>`;

  const thumbs = new Map();
  await Promise.all(
    boxes.map(async (b) => {
      const p = await db.firstPhoto(b.code);
      if (p) thumbs.set(b.code, objUrl(p.thumb || p.blob));
    }),
  );

  const render = () => {
    lastQuery = $('#q').value;
    const terms = lastQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text) => terms.every((w) => text.includes(w));
    let html = '';
    let shown = 0;
    for (const b of boxes) {
      let hits = [];
      if (terms.length) {
        const boxHit = matches([b.code, b.name, b.location, b.notes].join(' ').toLowerCase());
        hits = (b.items || []).filter((i) => matches([i.name, i.category].join(' ').toLowerCase()));
        if (!boxHit && !hits.length) continue;
      }
      shown++;
      const t = thumbs.get(b.code);
      html += `
        <a class="card" href="#/box/${encodeURIComponent(b.code)}">
          ${t ? `<img class="thumb" src="${t}" alt="">` : '<div class="thumb empty">📦</div>'}
          <div class="card-body">
            <div class="code">${esc(b.code)}</div>
            <div class="name">${esc(b.name || 'Unnamed box')}</div>
            <div class="meta">${b.location ? `📍 ${esc(b.location)} · ` : ''}${itemCount(b)} item${itemCount(b) === 1 ? '' : 's'}</div>
            ${hits.length ? `<div class="hits">Has: ${hits.map((i) => `<mark>${esc(i.name)}</mark>${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ')}</div>` : ''}
          </div>
        </a>`;
    }
    if (!boxes.length) {
      html = `<div class="empty-state">
        <div class="big">📦</div>
        <h2>No boxes yet</h2>
        <p>Tap <b>+ New box</b> to add one, or go to <a href="#/labels">Labels</a> and print a sheet of blank QR labels to stick on your boxes first.</p>
        <p class="muted">Then take photos of what's inside — ${ai.hasKey() ? 'Gemini will list the items for you.' : 'add a Gemini key in <a href="#/settings">Settings</a> and AI will list the items for you.'}</p>
      </div>`;
    } else if (!shown) {
      html = `<p class="muted center">Nothing matches “${esc(lastQuery)}”. ${ai.hasKey() ? `<a href="#/ask">Ask Gemini instead?</a>` : ''}</p>`;
    }
    $('#list').innerHTML = html;
  };

  $('#q').addEventListener('input', render);
  $('#new').addEventListener('click', async () => {
    const box = await createBox();
    go(`#/box/${encodeURIComponent(box.code)}`);
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
      await createBox(code);
      router();
    });
    return;
  }

  const locations = [...new Set((await db.allBoxes()).map((b) => b.location).filter(Boolean))].sort();

  view.innerHTML = `
    <div class="box-head">
      <a href="#/" class="back">‹ Boxes</a>
      <span class="code-badge">${esc(box.code)}</span>
    </div>
    <label class="field"><span>Name</span><input id="name" value="${esc(box.name)}" placeholder="e.g. Christmas lights"></label>
    <label class="field"><span>Location</span><input id="location" list="locs" value="${esc(box.location)}" placeholder="e.g. Shelf A, top"></label>
    <datalist id="locs">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>

    <section>
      <h2>Photos</h2>
      <div class="photos" id="photos"></div>
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

    <div class="row spread">
      <a class="btn" href="#/labels?codes=${encodeURIComponent(box.code)}">🖨️ Print label</a>
      <button class="btn danger" id="del">Delete box</button>
    </div>`;

  const save = () => db.putBox(box);
  for (const f of ['name', 'location', 'notes']) {
    $(`#${f}`).addEventListener('change', (e) => {
      box[f] = e.target.value.trim();
      save();
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
    box.items.push(db.newItem({ name, qty: f.qty.value }));
    save();
    f.reset();
    f.name.focus();
    renderItems();
  });

  $('#items').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const li = e.target.closest('li[data-id]');
    if (!btn || !li) return;
    const item = box.items.find((i) => i.id === li.dataset.id);
    if (!item) return;
    if (btn.dataset.act === 'del') {
      box.items = box.items.filter((i) => i !== item);
      save();
      renderItems();
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
        item.name = form.name.value.trim() || item.name;
        item.qty = Math.max(1, Number(form.qty.value) || 1);
        item.category = form.category.value.trim();
        save();
        renderItems();
      });
    }
  });

  // --- photos ---
  let photos = await db.photosFor(box.code);
  const renderPhotos = () => {
    $('#photos').innerHTML = photos.length
      ? photos.map((p) => `<button class="photo" data-id="${p.id}"><img src="${objUrl(p.thumb || p.blob)}" alt="Photo of box contents"></button>`).join('')
      : '<p class="muted small">No photos yet.</p>';
  };

  const addFiles = async (files) => {
    for (const file of files) {
      try {
        const blob = await resizeImage(file, 1600);
        const thumb = await resizeImage(file, 360, 0.7);
        const photo = await db.addPhoto({ boxCode: box.code, blob, thumb });
        photos.push(photo);
        box.updatedAt = Date.now();
        save();
        renderPhotos();
        // With several photos at once, skip auto-identify so result sheets don't stack up.
        if (files.length === 1 && ai.hasKey() && settings.autoIdentify) await identify(photo);
      } catch (err) {
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
      <img class="full" src="${objUrl(photo.blob)}" alt="">
      <div class="row spread">
        <button class="btn primary" data-act="ai">✨ Identify items</button>
        <button class="btn danger" data-act="del">Delete photo</button>
        <button class="btn" data-close>Close</button>
      </div>`);
    m.el.querySelector('[data-act=ai]').addEventListener('click', () => {
      m.close();
      identify(photo);
    });
    m.el.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!confirm('Delete this photo?')) return;
      await db.deletePhoto(photo.id);
      photos = photos.filter((p) => p !== photo);
      m.close();
      renderPhotos();
    });
  });

  // --- AI: identify items in a photo ---
  async function identify(photo) {
    if (!ai.hasKey()) {
      toast('Add your Gemini API key in Settings first.');
      return;
    }
    const m = modal(`<div class="center pad"><div class="spinner"></div><p>Gemini is looking at your photo…</p></div>`);
    let result;
    try {
      result = await ai.identifyItems(photo.blob, box.items);
    } catch (err) {
      m.el.querySelector('.sheet-panel').innerHTML = `<p class="error">${esc(err.message)}</p><div class="row"><button class="btn" data-close>OK</button></div>`;
      return;
    }
    if (!result.items.length) {
      m.el.querySelector('.sheet-panel').innerHTML = `<p>Gemini couldn't make out any items in that photo. Try one with better light or closer up.</p><div class="row"><button class="btn" data-close>OK</button></div>`;
      return;
    }
    m.el.querySelector('.sheet-panel').innerHTML = `
      <h2>✨ Found ${result.items.length} item${result.items.length === 1 ? '' : 's'}</h2>
      <p class="muted small">Untick anything wrong, fix names, then add.</p>
      ${!box.name && result.boxName ? `<label class="check"><input type="checkbox" id="use-name" checked> Name this box “${esc(result.boxName)}”</label>` : ''}
      <ul class="ai-items">
        ${result.items
          .map(
            (i, n) => `
          <li>
            <input type="checkbox" checked data-n="${n}" aria-label="Include">
            <input class="qty" type="number" min="1" value="${i.qty}" data-qty="${n}" aria-label="Quantity">
            <input value="${esc(i.name)}" data-name="${n}" aria-label="Name">
          </li>`,
          )
          .join('')}
      </ul>
      <div class="row spread">
        <button class="btn primary" id="ai-add">Add to box</button>
        <button class="btn" data-close>Cancel</button>
      </div>`;
    m.el.querySelector('#ai-add').addEventListener('click', () => {
      const el = m.el;
      result.items.forEach((it, n) => {
        if (!el.querySelector(`[data-n="${n}"]`).checked) return;
        const name = el.querySelector(`[data-name="${n}"]`).value.trim();
        const qty = Math.max(1, Number(el.querySelector(`[data-qty="${n}"]`).value) || 1);
        if (!name) return;
        const existing = box.items.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (existing) existing.qty += qty;
        else box.items.push(db.newItem({ name, qty, category: it.category }));
      });
      const useName = el.querySelector('#use-name');
      if (useName?.checked) {
        box.name = result.boxName;
        $('#name').value = box.name;
      }
      save();
      renderItems();
      m.close();
      toast('Items added');
    });
  }

  $('#del').addEventListener('click', async () => {
    if (!confirm(`Delete ${box.code}${box.name ? ` (${box.name})` : ''} and all its photos? This can't be undone.`)) return;
    await db.deleteBox(box.code);
    toast(`${box.code} deleted`);
    go('#/');
  });

  renderItems();
  renderPhotos();
}

// ---------- scanner ----------

async function scanView() {
  view.innerHTML = `
    <h1>Scan a label</h1>
    <div class="scanner"><video playsinline muted autoplay></video><div class="frame"></div></div>
    <p class="muted center" id="status">Starting camera…</p>
    <form id="manual" class="row">
      <input name="code" placeholder="Or type a code, e.g. BOX-007" autocapitalize="characters" autocomplete="off">
      <button class="btn">Go</button>
    </form>
    <p class="muted small center">Your phone's normal camera app can scan the labels too — they open straight to the box.</p>`;

  $('#manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = parseCode(e.target.code.value) || e.target.code.value.trim().toUpperCase();
    if (code) go(`#/box/${encodeURIComponent(code)}`);
  });

  const status = $('#status');
  const video = $('video');
  let active = true;
  let stream;
  onCleanup(() => {
    active = false;
    stream?.getTracks().forEach((t) => t.stop());
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
  status.textContent = 'Point the camera at a box label.';

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
          navigator.vibrate?.(60);
          go(`#/box/${encodeURIComponent(code)}`);
          return;
        }
        status.textContent = "That QR code isn't one of your box labels.";
      }
    }
    setTimeout(tick, 180);
  };
  tick();
}

// ---------- labels ----------

async function labelsView(params) {
  const boxes = (await db.allBoxes()).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const selected = new Set((params.get('codes') || '').split(',').filter(Boolean));
  let blanks = [];
  let size = localStorage.getItem('label-size') || 'medium';

  view.innerHTML = `
    <h1>Print labels</h1>
    <p class="muted">Choose boxes to print, or make <b>blank labels</b> to stick on boxes now and fill in later — scanning a blank label lets you set it up.</p>
    <div class="row">
      <label class="inline">Label size
        <select id="size">
          <option value="small">Small · 1.5 in</option>
          <option value="medium">Medium · 2 in</option>
          <option value="large">Large · 3 in</option>
        </select>
      </label>
    </div>
    <div class="row">
      <input type="number" id="nblank" min="1" max="100" value="6" class="qty" aria-label="How many blank labels">
      <button class="btn" id="mkblank">+ Add blank labels</button>
    </div>
    ${
      boxes.length
        ? `<div class="row"><button class="btn small" id="all">Select all</button><button class="btn small" id="none">Clear</button></div>
           <ul class="pick">${boxes
             .map(
               (b) => `<li><label class="check"><input type="checkbox" value="${esc(b.code)}" ${selected.has(b.code) ? 'checked' : ''}>
               <b>${esc(b.code)}</b> ${esc(b.name || 'Unnamed box')} ${b.location ? `<span class="muted">· ${esc(b.location)}</span>` : ''}</label></li>`,
             )
             .join('')}</ul>`
        : ''
    }
    <button class="btn primary big" id="print">🖨️ Print <span id="n">0</span> labels</button>
    <p class="muted small">Tip: in the print dialog, turn off headers/footers and set scale to 100%. Plain paper + clear packing tape works great, or print on full-sheet sticker paper.</p>
    <h2>Preview</h2>
    <div id="print-sheet" class="label-sheet"></div>`;

  $('#size').value = size;
  const boxByCode = new Map(boxes.map((b) => [b.code, b]));

  const render = () => {
    const codes = [...boxes.filter((b) => selected.has(b.code)).map((b) => b.code), ...blanks];
    $('#n').textContent = codes.length;
    $('#print').disabled = !codes.length;
    const sheet = $('#print-sheet');
    sheet.className = `label-sheet ${size}`;
    sheet.innerHTML = codes.length
      ? codes
          .map((code) => {
            const b = boxByCode.get(code);
            return `<div class="label">
              ${qrSvg(boxUrl(code))}
              <div class="label-code">${esc(code)}</div>
              ${b?.name ? `<div class="label-name">${esc(b.name)}</div>` : ''}
            </div>`;
          })
          .join('')
      : '<p class="muted">Nothing selected yet.</p>';
  };

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
    blanks = [];
    view.querySelectorAll('.pick input').forEach((cb) => (cb.checked = false));
    render();
  });
  $('#mkblank').addEventListener('click', async () => {
    const n = Math.min(100, Math.max(1, Number($('#nblank').value) || 1));
    blanks.push(...(await db.reserveCodes(n)));
    render();
    toast(`Added ${n} blank label${n === 1 ? '' : 's'}`);
  });
  $('#size').addEventListener('change', (e) => {
    size = e.target.value;
    try {
      localStorage.setItem('label-size', size);
    } catch {
      /* ignore */
    }
    render();
  });
  $('#print').addEventListener('click', () => window.print());
  render();
}

// ---------- ask AI ----------

async function askView() {
  const boxes = await db.allBoxes();
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
      const { answer, boxCodes } = await ai.askInventory(q, boxes);
      const linked = boxCodes.map((c) => boxes.find((b) => b.code === c)).filter(Boolean);
      out.innerHTML = `
        <div class="answer">${esc(answer).replace(/\n/g, '<br>')}</div>
        <div class="cards">${linked
          .map(
            (b) => `<a class="card" href="#/box/${encodeURIComponent(b.code)}"><div class="thumb empty">📦</div><div class="card-body">
              <div class="code">${esc(b.code)}</div><div class="name">${esc(b.name || 'Unnamed box')}</div>
              <div class="meta">${b.location ? `📍 ${esc(b.location)}` : ''}</div></div></a>`,
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
    if (est?.usage != null) usage = `${(est.usage / 1048576).toFixed(1)} MB used on this device.`;
    if (await navigator.storage?.persisted?.()) usage += ' Storage is protected from automatic cleanup.';
  } catch {
    /* ignore */
  }

  view.innerHTML = `
    <h1>Settings</h1>

    <section>
      <h2>Gemini AI</h2>
      <p class="muted small">Get a free API key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>, then paste it here. It's stored only on this device and sent only to Google.</p>
      <label class="field"><span>API key</span>
        <div class="row tight"><input id="key" type="password" value="${esc(settings.apiKey)}" placeholder="AIza…" autocomplete="off" spellcheck="false">
        <button class="btn small" id="show" type="button">Show</button></div>
      </label>
      <label class="field"><span>Model</span><input id="model" value="${esc(settings.model)}" placeholder="${DEFAULT_MODEL}" spellcheck="false" autocapitalize="off"></label>
      <label class="check"><input type="checkbox" id="auto" ${settings.autoIdentify ? 'checked' : ''}> Identify items automatically when I add a photo</label>
      <div class="row"><button class="btn" id="test">Test key</button><span id="test-out" class="small"></span></div>
    </section>

    <section>
      <h2>Backup</h2>
      <p class="muted small">Your inventory lives on this phone. Export a backup now and then (it includes photos), and use Import to move it to another device. ${esc(usage)}</p>
      <div class="row">
        <button class="btn" id="export">⬇️ Export backup</button>
        <label class="btn">⬆️ Import backup<input type="file" accept="application/json,.json" class="visually-hidden" id="import"></label>
      </div>
    </section>

    <section>
      <h2>Install on your phone</h2>
      <p class="small"><b>iPhone:</b> open this page in Safari → Share button → <i>Add to Home Screen</i>.<br>
      <b>Android:</b> open in Chrome → ⋮ menu → <i>Install app</i> (or <i>Add to Home screen</i>).</p>
    </section>`;

  const key = $('#key');
  key.addEventListener('change', () => {
    settings.apiKey = key.value.trim();
    saveSettings();
    toast('API key saved');
  });
  $('#show').addEventListener('click', (e) => {
    key.type = key.type === 'password' ? 'text' : 'password';
    e.target.textContent = key.type === 'password' ? 'Show' : 'Hide';
  });
  $('#model').addEventListener('change', (e) => {
    settings.model = e.target.value.trim() || DEFAULT_MODEL;
    e.target.value = settings.model;
    saveSettings();
  });
  $('#auto').addEventListener('change', (e) => {
    settings.autoIdentify = e.target.checked;
    saveSettings();
  });
  $('#test').addEventListener('click', async () => {
    settings.apiKey = key.value.trim();
    saveSettings();
    const out = $('#test-out');
    out.textContent = 'Testing…';
    out.className = 'small';
    try {
      await ai.testKey();
      out.textContent = '✅ Key works!';
      out.className = 'small ok';
    } catch (err) {
      out.textContent = `❌ ${err.message}`;
      out.className = 'small error';
    }
  });
  $('#export').addEventListener('click', async () => {
    const data = await db.exportAll();
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
      const res = await db.importAll(JSON.parse(await file.text()));
      toast(`Imported ${res.boxes} boxes and ${res.photos} photos`);
    } catch (err) {
      toast(err.message || 'Import failed');
    }
  });
}

// ---------- start ----------

router();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
