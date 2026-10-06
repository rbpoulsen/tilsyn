'use strict';

/* ================================================================
   Tilsyn – fotoregistrering på veje og pladser
   Data ligger i IndexedDB:  projects · records (inkl. thumbnail) · photos (fuld størrelse)
   ================================================================ */

const CATEGORIES = [
  'Belægning / slaghul', 'Revner og sætninger', 'Kantsten', 'Fortov og flisebelægning',
  'Afvanding / riste', 'Skilte og afmærkning', 'Belysning', 'Beplantning og træer',
  'Byinventar', 'Renhold', 'Afspærring / arbejdsplads', 'Andet'
];
const PRIORITIES = [
  { v: 'lav', t: 'Lav' },
  { v: 'middel', t: 'Middel' },
  { v: 'hoj', t: 'Høj' }
];
const STATUSES = ['Registreret', 'Under udbedring', 'Udbedret'];
const DK_CENTER = [56.0, 10.6];
const FULL_MAX = 2048, THUMB_MAX = 640;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const prioText = (v) => (PRIORITIES.find(p => p.v === v) || PRIORITIES[1]).t;

const store = {
  get(k, d) { try { const v = localStorage.getItem('tilsyn.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tilsyn.' + k, JSON.stringify(v)); } catch { /* ignore */ } }
};

/* ---------------- dato/tid ---------------- */
const fmtDate = (iso) => new Date(iso).toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
const fmtCoord = (n) => (n == null ? '' : n.toFixed(6));
const osmLink = (r) => `https://www.openstreetmap.org/?mlat=${r.lat.toFixed(6)}&mlon=${r.lng.toFixed(6)}#map=19/${r.lat.toFixed(6)}/${r.lng.toFixed(6)}`;

/* ================================================================
   IndexedDB
   ================================================================ */
let idb;
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tilsyn', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('records', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      d.createObjectStore('photos', { keyPath: 'id' });
    };
    r.onsuccess = () => { idb = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const db = {
  all: (s) => reqP(idb.transaction(s).objectStore(s).getAll()),
  get: (s, id) => reqP(idb.transaction(s).objectStore(s).get(id)),
  put(s, v) { const t = idb.transaction(s, 'readwrite'); t.objectStore(s).put(v); return txDone(t); },
  putRecord(rec, photo) {
    const t = idb.transaction(['records', 'photos'], 'readwrite');
    t.objectStore('records').put(rec);
    if (photo) t.objectStore('photos').put({ id: rec.id, blob: photo });
    return txDone(t);
  },
  delRecords(ids) {
    const t = idb.transaction(['records', 'photos'], 'readwrite');
    ids.forEach(id => { t.objectStore('records').delete(id); t.objectStore('photos').delete(id); });
    return txDone(t);
  },
  delProject(id) { const t = idb.transaction('projects', 'readwrite'); t.objectStore('projects').delete(id); return txDone(t); }
};

/* ================================================================
   State
   ================================================================ */
const state = {
  projects: [],
  records: [],
  filter: store.get('filter', ''),
  view: store.get('view', 'map'),
  lastProject: store.get('lastProject', '')
};
const thumbURLs = new Map();
function thumbURL(rec) {
  if (!rec.thumb) return '';
  let u = thumbURLs.get(rec.id);
  if (!u) { u = URL.createObjectURL(rec.thumb); thumbURLs.set(rec.id, u); }
  return u;
}
function dropThumb(id) { const u = thumbURLs.get(id); if (u) URL.revokeObjectURL(u); thumbURLs.delete(id); }

const projectName = (id) => state.projects.find(p => p.id === id)?.name || 'Uden projekt';
const visibleRecords = () => state.records
  .filter(r => !state.filter || r.projectId === state.filter)
  .sort((a, b) => b.created.localeCompare(a.created));

async function loadAll() {
  [state.projects, state.records] = await Promise.all([db.all('projects'), db.all('records')]);
  state.projects.sort((a, b) => a.name.localeCompare(b.name, 'da'));
  if (state.filter && !state.projects.some(p => p.id === state.filter)) state.filter = '';
}

/* ================================================================
   UI helpers
   ================================================================ */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function confirmBox({ title, text, ok = 'OK', danger = false, input = null }) {
  const d = $('#confirm-dialog');
  $('#cf-title').textContent = title;
  $('#cf-text').textContent = text || '';
  $('#cf-text').hidden = !text;
  const okBtn = $('#cf-ok');
  okBtn.textContent = ok;
  okBtn.className = 'btn ' + (danger ? 'danger confirm' : 'primary');
  $('#cf-input-wrap').hidden = !input;
  if (input) { $('#cf-input-label').textContent = input.label; $('#cf-input').value = input.value || ''; }
  return new Promise(res => {
    const finish = (v) => { okBtn.onclick = $('#cf-cancel').onclick = null; d.onclose = null; d.close(); res(v); };
    okBtn.onclick = () => finish(input ? $('#cf-input').value.trim() || null : true);
    $('#cf-cancel').onclick = () => finish(input ? null : false);
    d.onclose = () => res(input ? null : false);
    d.showModal();
    if (input) setTimeout(() => $('#cf-input').focus(), 50);
  });
}

function fillSelect(sel, items, value) {
  sel.innerHTML = items.map(i => `<option value="${esc(i.v)}">${esc(i.t)}</option>`).join('');
  if (value != null) sel.value = value;
}

/* ================================================================
   Rendering
   ================================================================ */
function renderFilter() {
  fillSelect($('#filter'), [{ v: '', t: 'Alle projekter' }, ...state.projects.map(p => ({ v: p.id, t: p.name }))], state.filter);
}

function setView(v) {
  state.view = v; store.set('view', v);
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + v; });
  document.body.classList.toggle('no-filter', v === 'projects');
  if (v === 'map') { map.invalidateSize(); if (!didFit) renderMarkers(); }
}

function chipPrio(r) { return `<span class="chip prio p-${esc(r.priority)}"><span class="sw"></span>${esc(prioText(r.priority))}</span>`; }

function renderList() {
  const recs = visibleRecords();
  $('#list-count').textContent = (recs.length === 1 ? '1 registrering' : `${recs.length} registreringer`) + (state.filter ? ` i ${projectName(state.filter)}` : ' i alle projekter');
  const el = $('#list');
  if (!recs.length) {
    el.innerHTML = `<div class="empty"><strong>Ingen registreringer endnu</strong><p>Tryk på Tag billede for at fotografere et forhold. Position, dato og tid gemmes automatisk.</p></div>`;
    return;
  }
  el.innerHTML = recs.map(r => `
    <button type="button" class="card" data-id="${r.id}">
      <img class="thumb" src="${thumbURL(r)}" alt="" loading="lazy">
      <div style="min-width:0">
        <div class="meta"><span class="num">${fmtDate(r.created)} · ${fmtTime(r.created)}</span>${chipPrio(r)}${r.status === 'Udbedret' ? '<span class="chip done">Udbedret</span>' : ''}</div>
        <p class="title">${esc(r.category || 'Uden kategori')}${state.filter ? '' : ` <span class="proj">· ${esc(projectName(r.projectId))}</span>`}</p>
        <p class="text">${esc(r.description) || '<span class="proj">Ingen beskrivelse</span>'}</p>
        <p class="where">${r.lat != null ? esc(r.address || `${fmtCoord(r.lat)}, ${fmtCoord(r.lng)}`) : 'Ingen position – åbn og placér på kortet'}</p>
      </div>
    </button>`).join('');
}

function renderProjects() {
  const el = $('#project-list');
  if (!state.projects.length) {
    el.innerHTML = `<div class="empty"><strong>Ingen projekter endnu</strong><p>Opret et projekt ovenfor, eller opret det direkte, når du gemmer dit første billede.</p></div>`;
    return;
  }
  el.innerHTML = state.projects.map(p => {
    const recs = state.records.filter(r => r.projectId === p.id);
    const open = recs.filter(r => r.status !== 'Udbedret').length;
    const high = recs.filter(r => r.priority === 'hoj' && r.status !== 'Udbedret').length;
    const last = recs.reduce((m, r) => (r.created > m ? r.created : m), '');
    return `
    <article class="project" data-id="${p.id}">
      <div class="project-top">
        <div style="min-width:0">
          <h3>${esc(p.name)}</h3>
          ${p.description ? `<p class="sub">${esc(p.description)}</p>` : ''}
        </div>
        <div class="big-num">${recs.length}<small>billeder</small></div>
      </div>
      <div class="stats">
        <span><b>${open}</b> åbne</span>
        <span><b>${high}</b> høj prioritet</span>
        <span>Seneste: <b>${last ? fmtDate(last) : '–'}</b></span>
      </div>
      <div class="actions">
        <button type="button" class="btn primary small" data-act="export" ${recs.length ? '' : 'disabled'}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>Eksportér til Excel</button>
        <button type="button" class="btn ghost small" data-act="show">Vis på kort</button>
        <button type="button" class="btn ghost small" data-act="rename">Omdøb</button>
        <button type="button" class="btn small danger" data-act="delete">Slet</button>
      </div>
    </article>`;
  }).join('');
}

function renderAll() {
  renderFilter();
  renderList();
  renderProjects();
  renderMarkers();
}

/* ================================================================
   Kort (OSM via Leaflet)
   ================================================================ */
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bidragydere';
let map, markerLayer, meMarker, didFit = false;

function pinIcon(r, label) {
  const cls = r.status === 'Udbedret' ? 'pin done' : `pin p-${r.priority}`;
  return L.divIcon({ className: '', html: `<div class="${cls}"><span>${label ?? ''}</span></div>`, iconSize: [28, 28], iconAnchor: [14, 36], popupAnchor: [0, -34] });
}

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView(DK_CENTER, 7);
  L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }).addTo(map);
  markerLayer = L.featureGroup().addTo(map);

  const Locate = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-locate');
      div.innerHTML = '<a href="#" role="button" title="Vis min position" aria-label="Vis min position"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></a>';
      L.DomEvent.on(div, 'click', async (e) => {
        L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e);
        toast('Finder din position …', 0);
        const p = await getPosition();
        if (!p) return toast('Positionen kunne ikke bestemmes. Tjek at placering er tilladt for siden.');
        toast(`Position fundet (±${Math.round(p.accuracy)} m)`);
        showMe(p); map.setView([p.lat, p.lng], 18);
      });
      return div;
    }
  });
  map.addControl(new Locate());

  map.on('popupopen', (e) => {
    const b = e.popup.getElement().querySelector('[data-open]');
    if (b) b.onclick = () => openDetail(b.dataset.open);
  });
}

function showMe(p) {
  const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  if (meMarker) meMarker.setLatLng([p.lat, p.lng]); else meMarker = L.marker([p.lat, p.lng], { icon, interactive: false, keyboard: false }).addTo(map);
}

function renderMarkers(fit) {
  if (!map) return;
  markerLayer.clearLayers();
  const recs = visibleRecords().filter(r => r.lat != null);
  // nummerér kronologisk pr. udvalg, så nummeret svarer til rækkefølgen i Excel
  const chrono = [...recs].sort((a, b) => a.created.localeCompare(b.created));
  chrono.forEach((r, i) => {
    const m = L.marker([r.lat, r.lng], { icon: pinIcon(r, state.filter ? i + 1 : ''), title: r.category || '' });
    m.bindPopup(`
      <div class="pop">
        <img src="${thumbURL(r)}" alt="">
        <div class="meta"><span class="num">${fmtDate(r.created)} ${fmtTime(r.created)}</span> · ${esc(projectName(r.projectId))}</div>
        <strong>${esc(r.category || 'Uden kategori')}</strong>
        ${r.description ? `<p>${esc(r.description)}</p>` : ''}
        <button type="button" class="btn primary small" data-open="${r.id}">Åbn registrering</button>
      </div>`, { maxWidth: 240 });
    markerLayer.addLayer(m);
  });
  const empty = $('#map-empty');
  empty.textContent = state.records.length ? 'Ingen registreringer med position i dette udvalg.' : 'Tryk på Tag billede for at lave din første registrering. Position, dato og tid kommer på automatisk.';
  empty.hidden = recs.length > 0;
  if ((fit || !didFit) && recs.length && map.getSize().x > 0) {
    map.fitBounds(markerLayer.getBounds(), { padding: [40, 40], maxZoom: 18 });
    didFit = true;
  }
}

/* ================================================================
   Position
   ================================================================ */
function getPosition(timeout = 20000) {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise(res => navigator.geolocation.getCurrentPosition(
    p => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    () => res(null),
    { enableHighAccuracy: true, timeout, maximumAge: 3000 }
  ));
}

async function readExif(file) {
  const out = { gps: null, date: null };
  if (!window.exifr) return out;
  try {
    const g = await exifr.gps(file);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) out.gps = { lat: g.latitude, lng: g.longitude, accuracy: null };
  } catch { /* ingen GPS i EXIF */ }
  try {
    const t = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    const d = t?.DateTimeOriginal || t?.CreateDate;
    if (d instanceof Date && !isNaN(d)) out.date = d;
  } catch { /* ignore */ }
  return out;
}

/* Adresse via Nominatim (OSM). Max 1 kald pr. sekund jf. brugsbetingelserne. */
const geoQueue = [];
let geoBusy = false;
function queueAddress(id) { if (!geoQueue.includes(id)) geoQueue.push(id); pumpGeo(); }
async function pumpGeo() {
  if (geoBusy || !geoQueue.length || !navigator.onLine) return;
  geoBusy = true;
  while (geoQueue.length) {
    const id = geoQueue.shift();
    const rec = state.records.find(r => r.id === id);
    if (rec && rec.lat != null && !rec.address) {
      const addr = await reverseGeocode(rec.lat, rec.lng);
      if (addr) {
        rec.address = addr;
        await db.put('records', rec);
        renderList();
      }
      await new Promise(r => setTimeout(r, 1100));
    }
  }
  geoBusy = false;
}
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=da`);
    if (!r.ok) return '';
    const j = await r.json();
    const a = j.address || {};
    const street = [a.road || a.pedestrian || a.square || a.footway || a.path || a.place, a.house_number].filter(Boolean).join(' ');
    const town = [a.postcode, a.city || a.town || a.village || a.suburb || a.municipality].filter(Boolean).join(' ');
    return [street, town].filter(Boolean).join(', ') || j.display_name || '';
  } catch { return ''; }
}

/* ================================================================
   Billedbehandling
   ================================================================ */
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
function resizeTo(img, max, quality) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(b => (b ? res({ blob: b, w, h }) : rej(new Error('toBlob'))), 'image/jpeg', quality));
}

/* ================================================================
   Optagelse → registreringsformular
   ================================================================ */
let pendingPos = null;
let draft = null;          // registrering under redigering
let draftPhoto = null;     // fuld størrelse (kun ny registrering)
let pickMap, pickMarker;

function startCapture(fromCamera) {
  // GPS startes allerede ved tryk, så positionen er klar når billedet er taget
  pendingPos = fromCamera ? getPosition(30000) : null;
  const input = fromCamera ? $('#cam-input') : $('#gal-input');
  input.value = '';
  input.click();
}

async function handleFile(file, fromCamera) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(file.name)) {
    return toast('Filen er ikke et billede.');
  }
  toast(fromCamera ? 'Gemmer billede og finder position …' : 'Indlæser billede …', 0);
  try {
    const exif = await readExif(file);
    const img = await loadImage(file);
    const [full, thumb] = await Promise.all([resizeTo(img, FULL_MAX, 0.85), resizeTo(img, THUMB_MAX, 0.8)]);

    let loc = null, src = null;
    if (fromCamera) {
      const p = await pendingPos;
      if (p) { loc = p; src = 'gps'; }
      else if (exif.gps) { loc = exif.gps; src = 'exif'; }
    } else if (exif.gps) { loc = exif.gps; src = 'exif'; }

    const created = fromCamera ? new Date() : (exif.date || new Date(file.lastModified || Date.now()));
    const defProject = state.filter || (state.projects.some(p => p.id === state.lastProject) ? state.lastProject : (state.projects[0]?.id || ''));

    draft = {
      id: null,
      created: created.toISOString(),
      lat: loc?.lat ?? null, lng: loc?.lng ?? null, accuracy: loc?.accuracy ?? null,
      locSource: src, address: '',
      projectId: defProject, category: '', priority: 'middel', status: 'Registreret', description: '',
      thumb: thumb.blob, thumbW: thumb.w, thumbH: thumb.h
    };
    draftPhoto = full.blob;
    $('#toast').hidden = true;
    openRecordForm(draft, URL.createObjectURL(full.blob), true);
  } catch (err) {
    console.error(err);
    toast('Billedet kunne ikke læses. Prøv igen, eller vælg et JPEG-billede.');
  }
}

function locNote(d) {
  const n = $('#rf-loc-note');
  n.classList.remove('warn');
  if (d.lat == null) { n.textContent = 'Ingen position. Tryk på kortet for at placere billedet.'; n.classList.add('warn'); return; }
  const srcTxt = { gps: 'GPS', exif: 'billedets EXIF-data', manual: 'placeret manuelt' }[d.locSource] || '';
  n.textContent = `Kilde: ${srcTxt}${d.accuracy ? ` · ±${Math.round(d.accuracy)} m` : ''}. Træk markøren for at justere.`;
}
function updatePosText(d) {
  $('#rf-pos').textContent = d.lat == null ? '–' : `${fmtCoord(d.lat)}, ${fmtCoord(d.lng)}`;
  locNote(d);
}
function setDraftPos(lat, lng, src, acc = null) {
  draft.lat = lat; draft.lng = lng; draft.locSource = src; draft.accuracy = acc; draft.address = '';
  placePickMarker();
  updatePosText(draft);
}
function placePickMarker() {
  if (draft.lat == null) { if (pickMarker) { pickMarker.remove(); pickMarker = null; } return; }
  const ll = [draft.lat, draft.lng];
  if (!pickMarker) {
    pickMarker = L.marker(ll, { draggable: true, icon: L.divIcon({ className: '', html: '<div class="pin pin-draft"><span>+</span></div>', iconSize: [28, 28], iconAnchor: [14, 36] }) }).addTo(pickMap);
    pickMarker.on('dragend', () => { const p = pickMarker.getLatLng(); setDraftPos(p.lat, p.lng, 'manual'); });
  } else pickMarker.setLatLng(ll);
}

function renderProjectSelect(value) {
  const opts = state.projects.map(p => ({ v: p.id, t: p.name }));
  opts.push({ v: '__new', t: '+ Nyt projekt …' });
  if (!state.projects.length) value = '__new';
  fillSelect($('#rf-project'), opts, value || opts[0].v);
  $('#rf-newproj-wrap').hidden = $('#rf-project').value !== '__new';
}

function openRecordForm(d, photoURL, isNew) {
  draft = d;
  $('#record-title').textContent = isNew ? 'Ny registrering' : 'Redigér registrering';
  const ph = $('#rf-photo');
  if (ph.dataset.url) URL.revokeObjectURL(ph.dataset.url);
  ph.src = photoURL; ph.dataset.url = photoURL;
  $('#rf-date').textContent = fmtDate(d.created);
  $('#rf-time').textContent = fmtTime(d.created);
  renderProjectSelect(d.projectId);
  $('#rf-newproj').value = '';
  fillSelect($('#rf-category'), [{ v: '', t: 'Vælg …' }, ...CATEGORIES.map(c => ({ v: c, t: c }))], d.category);
  fillSelect($('#rf-status'), STATUSES.map(s => ({ v: s, t: s })), d.status);
  $('#rf-priority').innerHTML = PRIORITIES.map(p => `
    <label class="p-${p.v}"><input type="radio" name="prio" value="${p.v}" ${d.priority === p.v ? 'checked' : ''}><span class="sw"></span>${p.t}</label>`).join('');
  $('#rf-desc').value = d.description || '';
  $('#rf-save').disabled = false;

  const dlg = $('#record-dialog');
  dlg.showModal();

  if (!pickMap) {
    pickMap = L.map('pick-map', { zoomControl: true, attributionControl: true });
    L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }).addTo(pickMap);
    pickMap.on('click', e => setDraftPos(e.latlng.lat, e.latlng.lng, 'manual'));
  }
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  requestAnimationFrame(() => {
    pickMap.invalidateSize();
    if (d.lat != null) pickMap.setView([d.lat, d.lng], 18);
    else if (meMarker) pickMap.setView(meMarker.getLatLng(), 16);
    else pickMap.setView(map.getCenter(), Math.max(map.getZoom(), 7));
    placePickMarker();
  });
  updatePosText(d);
}

async function saveRecordForm(ev) {
  ev.preventDefault();
  const btn = $('#rf-save');
  let projectId = $('#rf-project').value;
  const newName = $('#rf-newproj').value.trim();
  if (projectId === '__new' && !newName) { $('#rf-newproj').focus(); return toast('Giv det nye projekt et navn.'); }
  if (draft.lat == null) {
    const go = await confirmBox({ title: 'Gem uden position?', text: 'Billedet vises ikke på kortet, før du placerer det. Du kan tilføje positionen senere under Redigér.', ok: 'Gem alligevel' });
    if (!go) return;
  }
  if (projectId === '__new') projectId = (await createProject(newName, '')).id;
  btn.disabled = true;
  const isNew = !draft.id;
  const rec = {
    ...draft,
    id: draft.id || uid(),
    projectId,
    category: $('#rf-category').value,
    status: $('#rf-status').value,
    priority: ($('input[name="prio"]:checked') || {}).value || 'middel',
    description: $('#rf-desc').value.trim(),
    updated: new Date().toISOString()
  };
  try {
    await db.putRecord(rec, isNew ? draftPhoto : null);
  } catch (err) {
    console.error(err); btn.disabled = false;
    return toast('Kunne ikke gemme. Er enhedens lager fuldt?');
  }
  const i = state.records.findIndex(r => r.id === rec.id);
  if (i >= 0) state.records[i] = rec; else state.records.push(rec);
  state.lastProject = projectId; store.set('lastProject', projectId);
  draftPhoto = null;
  $('#record-dialog').close();
  renderAll();
  if (isNew) {
    map.setView([rec.lat ?? map.getCenter().lat, rec.lng ?? map.getCenter().lng], rec.lat != null ? Math.max(map.getZoom(), 17) : map.getZoom());
  }
  toast(isNew ? 'Registrering gemt' : 'Ændringer gemt');
  if (rec.lat != null && !rec.address) queueAddress(rec.id);
}

/* ================================================================
   Detaljer
   ================================================================ */
let detailId = null;
async function openDetail(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  detailId = id;
  map.closePopup();
  $('#dt-title').textContent = r.category || 'Registrering';
  const ph = $('#dt-photo');
  if (ph.dataset.url) URL.revokeObjectURL(ph.dataset.url);
  ph.src = thumbURL(r); ph.dataset.url = '';
  const facts = [
    ['Projekt', esc(projectName(r.projectId))],
    ['Dato', `<span class="num">${fmtDate(r.created)}</span>`],
    ['Tid', `<span class="num">${fmtTime(r.created)}</span>`],
    ['Prioritet', chipPrio(r)],
    ['Status', esc(r.status)],
    ['Adresse', esc(r.address || (r.lat != null ? 'Slås op, når der er forbindelse …' : '–'))],
    ['Position', r.lat != null ? `<span class="num">${fmtCoord(r.lat)}, ${fmtCoord(r.lng)}</span>${r.accuracy ? ` <span class="proj">±${Math.round(r.accuracy)} m</span>` : ''}<br><a href="${osmLink(r)}" target="_blank" rel="noopener">Åbn i OpenStreetMap ↗</a>` : '<span class="note warn">Ingen position</span>']
  ];
  $('#dt-fields').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('#dt-desc').textContent = r.description || '';
  $('#dt-map').hidden = r.lat == null;
  $('#detail-dialog').showModal();
  const full = await db.get('photos', id);
  if (full?.blob && detailId === id) { const u = URL.createObjectURL(full.blob); ph.src = u; ph.dataset.url = u; }
}

async function editDetail() {
  const r = state.records.find(x => x.id === detailId);
  if (!r) return;
  $('#detail-dialog').close();
  const full = await db.get('photos', r.id);
  draftPhoto = null;
  const src = full?.blob || r.thumb;
  openRecordForm({ ...r }, src ? URL.createObjectURL(src) : '', false);
}

async function deleteDetail() {
  const r = state.records.find(x => x.id === detailId);
  if (!r) return;
  const ok = await confirmBox({ title: 'Slet registrering?', text: `Billedet fra ${fmtDate(r.created)} kl. ${fmtTime(r.created)} slettes permanent fra denne enhed.`, ok: 'Slet', danger: true });
  if (!ok) return;
  await db.delRecords([r.id]);
  dropThumb(r.id);
  state.records = state.records.filter(x => x.id !== r.id);
  $('#detail-dialog').close();
  renderAll();
  toast('Registrering slettet');
}

/* ================================================================
   Projekter
   ================================================================ */
async function createProject(name, description) {
  const p = { id: uid(), name, description: description || '', created: new Date().toISOString() };
  await db.put('projects', p);
  state.projects.push(p);
  state.projects.sort((a, b) => a.name.localeCompare(b.name, 'da'));
  renderAll();
  return p;
}

async function projectAction(id, act) {
  const p = state.projects.find(x => x.id === id);
  if (!p) return;
  if (act === 'export') return exportProject(p);
  if (act === 'show') { state.filter = id; store.set('filter', id); renderAll(); setView('map'); renderMarkers(true); return; }
  if (act === 'rename') {
    const name = await confirmBox({ title: 'Omdøb projekt', ok: 'Gem', input: { label: 'Projektnavn', value: p.name } });
    if (!name) return;
    p.name = name; await db.put('projects', p);
    state.projects.sort((a, b) => a.name.localeCompare(b.name, 'da'));
    renderAll(); return;
  }
  if (act === 'delete') {
    const recs = state.records.filter(r => r.projectId === id);
    const ok = await confirmBox({
      title: `Slet “${p.name}”?`,
      text: recs.length ? `Projektet og dets ${recs.length} registreringer med billeder slettes permanent. Eksportér til Excel først, hvis du vil beholde dem.` : 'Projektet er tomt og slettes.',
      ok: 'Slet projekt', danger: true
    });
    if (!ok) return;
    await db.delRecords(recs.map(r => r.id));
    recs.forEach(r => dropThumb(r.id));
    await db.delProject(id);
    state.records = state.records.filter(r => r.projectId !== id);
    state.projects = state.projects.filter(x => x.id !== id);
    if (state.filter === id) { state.filter = ''; store.set('filter', ''); }
    renderAll();
    toast('Projekt slettet');
  }
}

/* ================================================================
   Excel-eksport (ExcelJS) – billede, lokalitet og beskrivelse pr. række
   ================================================================ */
const XL_IMG_W = 220;      // px bredde på billede i Excel
const HEAD_ROW = 6;        // tabeloverskriftens række
const EMU = 9525;          // Excel-enheder pr. pixel
const XL = { blaa: 'FF095AA6', blaa20: 'FFCEDEED', sort: 'FF000000', hvid: 'FFFFFFFF' }; // Aabenraa Kommune, primær palet

function excelDate(iso) {
  // Excel kender ikke tidszoner: gem lokal tid som "UTC" så cellen viser det, brugeren så.
  const d = new Date(iso);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}
// ASCII-filnavn: nogle browsere afviser download-navne med æøå eller tankestreger
const safeName = (s) => s
  .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae').replace(/ø/g, 'oe').replace(/Ø/g, 'Oe').replace(/å/g, 'aa').replace(/Å/g, 'Aa')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'projekt';

async function exportProject(p) {
  if (!window.ExcelJS) return toast('Excel-modulet indlæses stadig. Prøv igen om et øjeblik.');
  const recs = state.records.filter(r => r.projectId === p.id).sort((a, b) => a.created.localeCompare(b.created));
  if (!recs.length) return toast('Projektet har ingen registreringer.');
  toast(`Opretter Excel-fil med ${recs.length} billeder …`, 0);

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aabenraa Kommune'; wb.company = 'Aabenraa Kommune'; wb.created = new Date();
    const ws = wb.addWorksheet('Registreringer', {
      views: [{ state: 'frozen', ySplit: HEAD_ROW, showGridLines: false }],
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: `${HEAD_ROW}:${HEAD_ROW}`,
        margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.7, header: 0.3, footer: 0.3 }
      },
      headerFooter: {
        oddFooter: '&L&"Verdana"&8Aabenraa Kommune · Skelbækvej 2 · 6200 Aabenraa · aabenraa.dk&R&"Verdana"&8Side &P af &N'
      }
    });
    const cols = [
      ['Nr.', 6], ['Dato', 12], ['Tid', 8], ['Billede', Math.ceil(XL_IMG_W / 7) + 2], ['Adresse', 30],
      ['Breddegrad', 12], ['Længdegrad', 12], ['Nøjagtighed (m)', 15], ['Kort', 14],
      ['Kategori', 24], ['Prioritet', 11], ['Status', 16], ['Beskrivelse', 55]
    ];
    ws.columns = cols.map(([, w]) => ({ width: w }));
    const colPx = (w) => Math.floor(w * 7 + 5);
    const totalPx = cols.reduce((sum, [, w]) => sum + colPx(w), 0);

    // Hoved: rubrik + underrubrik venstrestillet, logo øverst til højre med respektafstand
    const font = (o = {}) => ({ name: 'Verdana', size: 10, color: { argb: XL.sort }, ...o });
    [[1, 34], [2, 20], [3, 16], [4, 16]].forEach(([n, h]) => { ws.getRow(n).height = h; });
    ws.getCell('A1').value = p.name;
    ws.getCell('A1').font = font({ size: 16, bold: true });
    ws.getCell('A1').alignment = { vertical: 'bottom' };
    ws.getCell('A2').value = 'Tilsyn på veje og pladser';
    ws.getCell('A2').font = font({ size: 11 });
    ws.getCell('A3').value = `${recs.length} registreringer · eksporteret ${new Date().toLocaleString('da-DK', { dateStyle: 'long', timeStyle: 'short' })}`;
    ws.getCell('A3').font = font({ size: 8 });
    if (p.description) { ws.getCell('A4').value = p.description; ws.getCell('A4').font = font({ size: 8 }); }

    const [logoBuf, buenBuf] = await Promise.all([
      fetch('brand/logo-1-prioritet.png').then(r => r.arrayBuffer()).catch(() => null),
      fetch('brand/buen-blaa-20.png').then(r => r.arrayBuffer()).catch(() => null)
    ]);
    if (logoBuf) {
      const LOGO_H = 44, LOGO_W = Math.round(LOGO_H * 1600 / 530), CLEAR = LOGO_H / 2;
      const lastCol = cols.length - 1;
      const id = wb.addImage({ buffer: logoBuf, extension: 'png' });
      ws.addImage(id, {
        tl: { nativeCol: lastCol, nativeColOff: (colPx(cols[lastCol][1]) - LOGO_W - CLEAR) * EMU, nativeRow: 0, nativeRowOff: CLEAR * EMU },
        ext: { width: LOGO_W, height: LOGO_H }, editAs: 'oneCell'
      });
    }

    const head = ws.getRow(HEAD_ROW);
    head.values = cols.map(([t]) => t);
    head.height = 24;
    head.eachCell(c => {
      c.font = font({ bold: true, color: { argb: XL.hvid } });
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.blaa } };
      c.alignment = { vertical: 'middle' };
    });
    ws.autoFilter = { from: { row: HEAD_ROW, column: 1 }, to: { row: HEAD_ROW, column: cols.length } };

    const line = { style: 'thin', color: { argb: XL.blaa20 } };
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const rowNo = HEAD_ROW + 1 + i;
      const row = ws.getRow(rowNo);
      const dt = excelDate(r.created);
      row.values = [
        i + 1, dt, dt, '', r.address || '',
        r.lat ?? '', r.lng ?? '', r.accuracy != null ? Math.round(r.accuracy) : '',
        r.lat != null ? { text: 'Åbn i OpenStreetMap', hyperlink: osmLink(r) } : '',
        r.category || '', prioText(r.priority), r.status || '', r.description || ''
      ];
      row.eachCell({ includeEmpty: true }, c => {
        c.font = font();
        c.alignment = { vertical: 'top', wrapText: true };
        c.border = { bottom: line };
      });
      row.getCell(2).numFmt = 'dd-mm-yyyy';
      row.getCell(3).numFmt = 'hh:mm';
      row.getCell(6).numFmt = '0.000000';
      row.getCell(7).numFmt = '0.000000';
      if (r.lat != null) row.getCell(9).font = font({ color: { argb: XL.blaa }, underline: true });
      if (r.priority === 'hoj') row.getCell(11).font = font({ bold: true });

      const tw = r.thumbW || THUMB_MAX, th = r.thumbH || Math.round(THUMB_MAX * 0.75);
      const w = XL_IMG_W, h = Math.round(th * (w / tw));
      row.height = Math.max(40, (h + 12) * 0.75);
      if (r.thumb) {
        const imgId = wb.addImage({ buffer: await r.thumb.arrayBuffer(), extension: 'jpeg' });
        ws.addImage(imgId, { tl: { nativeCol: 3, nativeColOff: 6 * EMU, nativeRow: rowNo - 1, nativeRowOff: 6 * EMU }, ext: { width: w, height: h }, editAs: 'oneCell' });
      }
    }

    // Buen: hel form fra kant til kant under tabellen; afstand til bunden = halvdelen af buens højde
    if (buenBuf) {
      const BUEN_H = 48;
      const buenRow = HEAD_ROW + recs.length + 2;
      ws.getRow(buenRow).height = BUEN_H * 0.75;
      ws.getRow(buenRow + 1).height = (BUEN_H / 2) * 0.75;
      const id = wb.addImage({ buffer: buenBuf, extension: 'png' });
      ws.addImage(id, { tl: { nativeCol: 0, nativeColOff: 0, nativeRow: buenRow - 1, nativeRowOff: 0 }, ext: { width: totalPx, height: BUEN_H }, editAs: 'oneCell' });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const name = `Tilsyn_${safeName(p.name)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    await saveFile(blob, name);
    toast('Excel-fil klar: ' + name, 4000);
  } catch (err) {
    console.error(err);
    toast('Eksporten mislykkedes: ' + (err.message || err), 5000);
  }
}

async function saveFile(blob, name) {
  // Installeret som app på iPhone virker almindelig download dårligt – brug delemenuen dér.
  const standaloneIOS = navigator.standalone === true;
  if (standaloneIOS && navigator.canShare) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/* ================================================================
   Sikkerhedskopi (JSON med billeder som base64)
   ================================================================ */
const blobToDataURL = (b) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); });
const dataURLToBlob = async (u) => (await fetch(u)).blob();

async function exportBackup() {
  toast('Pakker sikkerhedskopi …', 0);
  const photos = await db.all('photos');
  const out = { app: 'tilsyn', version: 1, exported: new Date().toISOString(), projects: state.projects, records: [] };
  for (const r of state.records) {
    const { thumb, ...rest } = r;
    const full = photos.find(p => p.id === r.id);
    out.records.push({ ...rest, thumb: thumb ? await blobToDataURL(thumb) : null, photo: full ? await blobToDataURL(full.blob) : null });
  }
  await saveFile(new Blob([JSON.stringify(out)], { type: 'application/json' }), `Tilsyn_sikkerhedskopi_${new Date().toISOString().slice(0, 10)}.json`);
  toast('Sikkerhedskopi gemt');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'tilsyn') throw new Error('Filen er ikke en Tilsyn-sikkerhedskopi.');
    let n = 0;
    for (const p of data.projects || []) await db.put('projects', p);
    for (const r of data.records || []) {
      const { photo, ...rec } = r;
      rec.thumb = r.thumb ? await dataURLToBlob(r.thumb) : null;
      await db.putRecord(rec, photo ? await dataURLToBlob(photo) : null);
      n++;
    }
    thumbURLs.forEach(u => URL.revokeObjectURL(u)); thumbURLs.clear();
    await loadAll(); renderAll(); renderMarkers(true);
    $('#backup-dialog').close();
    toast(`Indlæst: ${(data.projects || []).length} projekter, ${n} registreringer`, 4000);
  } catch (err) {
    toast('Indlæsning mislykkedes: ' + err.message, 5000);
  }
}

/* ================================================================
   Opstart
   ================================================================ */
function bindEvents() {
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#filter').addEventListener('change', e => { state.filter = e.target.value; store.set('filter', state.filter); renderList(); renderMarkers(true); });

  $('#capture-btn').addEventListener('click', () => startCapture(true));
  $('#gallery-btn').addEventListener('click', () => startCapture(false));
  $('#cam-input').addEventListener('change', e => handleFile(e.target.files[0], true));
  $('#gal-input').addEventListener('change', e => handleFile(e.target.files[0], false));

  $('#record-form').addEventListener('submit', saveRecordForm);
  $('#rf-project').addEventListener('change', e => {
    $('#rf-newproj-wrap').hidden = e.target.value !== '__new';
    if (e.target.value === '__new') $('#rf-newproj').focus();
  });
  $('#rf-locate').addEventListener('click', async () => {
    const b = $('#rf-locate'); b.disabled = true; b.textContent = 'Finder …';
    const p = await getPosition();
    b.disabled = false; b.textContent = 'Brug min position';
    if (!p) return toast('Positionen kunne ikke bestemmes. Tjek at placering er tilladt.');
    setDraftPos(p.lat, p.lng, 'gps', p.accuracy);
    pickMap.setView([p.lat, p.lng], 18);
    showMe(p);
  });

  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#record-dialog').addEventListener('close', () => { draftPhoto = null; });
  $('#detail-dialog').addEventListener('close', () => { detailId = null; });

  $('#list').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) openDetail(c.dataset.id); });
  $('#dt-edit').addEventListener('click', editDetail);
  $('#dt-delete').addEventListener('click', deleteDetail);
  $('#dt-map').addEventListener('click', () => {
    const r = state.records.find(x => x.id === detailId);
    $('#detail-dialog').close();
    if (!r) return;
    if (state.filter && state.filter !== r.projectId) { state.filter = ''; store.set('filter', ''); renderFilter(); renderMarkers(); renderList(); }
    setView('map');
    map.setView([r.lat, r.lng], 19);
    markerLayer.eachLayer(m => { const ll = m.getLatLng(); if (ll.lat === r.lat && ll.lng === r.lng) m.openPopup(); });
  });

  $('#new-project-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#np-name').value.trim();
    if (!name) return;
    await createProject(name, $('#np-desc').value.trim());
    e.target.reset();
    toast('Projekt oprettet');
  });
  $('#project-list').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b) projectAction(b.closest('.project').dataset.id, b.dataset.act);
  });

  $('#backup-btn').addEventListener('click', () => $('#backup-dialog').showModal());
  $('#bk-export').addEventListener('click', exportBackup);
  $('#bk-import').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

  window.addEventListener('online', () => {
    state.records.filter(r => r.lat != null && !r.address).forEach(r => queueAddress(r.id));
  });
}

async function main() {
  initMap();
  bindEvents();
  try {
    await openDB();
  } catch (err) {
    console.error(err);
    toast('Lokal database er ikke tilgængelig i denne browser (privat vindue?). Data kan ikke gemmes.', 0);
    return;
  }
  await loadAll();
  renderAll();
  setView(state.view);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  state.records.filter(r => r.lat != null && !r.address).forEach(r => queueAddress(r.id));
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (!window.isSecureContext) toast('Siden skal åbnes via https for at GPS og kamera virker.', 6000);
}

main();
