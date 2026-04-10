// ════════════════════════════════════════
//  TripCount v5 – Robust image + autocomplete
// ════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, deleteField }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBxpJHvlezAW7msWsmiMfKj77leKeUC-gQ",
  authDomain: "tripcount-2026.firebaseapp.com",
  projectId: "tripcount-2026",
  storageBucket: "tripcount-2026.firebasestorage.app",
  messagingSenderId: "216207264977",
  appId: "1:216207264977:web:389e9148d8a2c95b7409f0"
};

const fbApp   = initializeApp(firebaseConfig);
const auth    = getAuth(fbApp);
const db      = getFirestore(fbApp);
const storage = getStorage(fbApp);

// ── State ──
let currentUser    = null;
let trips          = [];
let unsubscribe    = null;
let editingId      = null;
let selectedEmoji  = '🏖️';
let pendingGps     = null;
let pendingFile    = null;   // raw File object chosen by user
let leafletMap     = null;
let mapMarkers     = [];
let acTimer        = null;
let acResults      = [];

const GRADIENTS = [
  'linear-gradient(135deg,#2A9D8F,#0D6B60)',
  'linear-gradient(135deg,#E63946,#8B1A2F)',
  'linear-gradient(135deg,#457B9D,#1D3557)',
  'linear-gradient(135deg,#F4A261,#C9591C)',
  'linear-gradient(135deg,#6C757D,#343A40)',
  'linear-gradient(135deg,#8338EC,#3A1078)',
  'linear-gradient(135deg,#3A86FF,#0047AB)',
  'linear-gradient(135deg,#06D6A0,#028A60)',
];

// ════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════
onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    showScreen('home');
    updateUserUI(user);
    subscribeTrips(user.uid);
  } else {
    showScreen('login');
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    trips = [];
  }
});

async function loginGoogle() {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { showToast('❌ Anmeldung fehlgeschlagen: ' + e.message); }
}
async function logoutUser() { await signOut(auth); showToast('👋 Abgemeldet'); }

function updateUserUI(user) {
  const av = document.getElementById('user-avatar');
  if (user.photoURL) { av.src = user.photoURL; av.classList.remove('hidden'); }
  const sav = document.getElementById('settings-avatar');
  if (sav && user.photoURL) sav.src = user.photoURL;
  const sn = document.getElementById('settings-name');
  const se = document.getElementById('settings-email');
  if (sn) sn.textContent = user.displayName || '';
  if (se) se.textContent = user.email || '';
}

// ════════════════════════════════════════
//  FIRESTORE
// ════════════════════════════════════════
function subscribeTrips(uid) {
  if (unsubscribe) unsubscribe();
  const q = query(collection(db, 'users', uid, 'trips'), orderBy('startDate', 'asc'));
  unsubscribe = onSnapshot(q,
    snap => { trips = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderHome(); renderArchive(); renderMap(); },
    err  => showToast('❌ Sync-Fehler: ' + err.message)
  );
}
const tripsRef = () => collection(db, 'users', currentUser.uid, 'trips');
const tripDoc  = id  => doc(db, 'users', currentUser.uid, 'trips', id);

// ════════════════════════════════════════
//  IMAGE – compress to ≤1 MB then upload
// ════════════════════════════════════════
function loadImg(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild konnte nicht geladen werden')); };
    img.src = url;
  });
}

function toBlob(img, w, h, q) {
  return new Promise((res, rej) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    c.toBlob(b => b ? res(b) : rej(new Error('Canvas toBlob fehlgeschlagen')), 'image/jpeg', q);
  });
}

async function compressTo1MB(file) {
  const img = await loadImg(file);
  let w = img.naturalWidth, h = img.naturalHeight;

  // Scale to max 1920px longest side
  const MAX = 1920;
  if (w > MAX || h > MAX) {
    if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
    else        { w = Math.round(w * MAX / h); h = MAX; }
  }

  // Try qualities until ≤ 1 MB
  for (const q of [0.90, 0.78, 0.65, 0.50, 0.38]) {
    const blob = await toBlob(img, w, h, q);
    if (blob.size <= 1_000_000) return blob;
  }
  // Last resort: shrink dimensions too
  w = Math.round(w * 0.65); h = Math.round(h * 0.65);
  return toBlob(img, w, h, 0.72);
}

// Returns a Firebase Storage download URL (never base64, never blob:)
async function uploadImage(file, tripId) {
  const blob = await compressTo1MB(file);
  const kb   = Math.round(blob.size / 1024);
  showToast(`📸 Komprimiert auf ${kb} KB – hochladen …`);
  const path    = `users/${currentUser.uid}/trips/${tripId}.jpg`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(fileRef);
  // Safety check – must be an https URL, never data:/blob:
  if (!url.startsWith('https://')) throw new Error('Ungültige Bild-URL von Storage');
  return url;
}

// ════════════════════════════════════════
//  FIRESTORE REST API – bypasses SDK size limit
//  Used to patch corrupted documents with oversized base64 images
// ════════════════════════════════════════
async function patchDocViaREST(docId, fields) {
  const token = await currentUser.getIdToken();
  const project = 'tripcount-2026';
  const path = `users/${currentUser.uid}/trips/${docId}`;
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`;

  // Build Firestore REST value format
  function toFirestoreValue(val) {
    if (val === null || val === undefined || val === '') return { nullValue: null };
    if (typeof val === 'string')  return { stringValue: val };
    if (typeof val === 'number')  return { doubleValue: val };
    if (typeof val === 'boolean') return { booleanValue: val };
    return { stringValue: String(val) };
  }

  const firestoreFields = {};
  for (const [key, val] of Object.entries(fields)) {
    firestoreFields[key] = toFirestoreValue(val);
  }

  // Build field mask - each field listed separately
  const fieldMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const patchUrl = `${url}?${fieldMask}`;

  const res = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: firestoreFields })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`REST ${res.status}: ${errText.slice(0,100)}`);
  }
  return res.json();
}

// ════════════════════════════════════════
//  ADDRESS AUTOCOMPLETE
// ════════════════════════════════════════
async function fetchPlaces(q) {
  // Photon by Komoot – CORS-enabled geocoding, no User-Agent required
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=de`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`Geocoding Fehler ${r.status}`);
  const data = await r.json();
  // Normalize Photon GeoJSON → same shape renderSuggestions expects
  return (data.features || []).map(f => ({
    display_name: [f.properties.name, f.properties.city, f.properties.country].filter(Boolean).join(', '),
    lat: String(f.geometry.coordinates[1]),
    lon: String(f.geometry.coordinates[0]),
    type: f.properties.type || 'place',
    class: f.properties.osm_value || '',
    address: {
      city:    f.properties.city || f.properties.name,
      town:    f.properties.city,
      village: f.properties.village,
      state:   f.properties.state,
      country: f.properties.country,
    }
  }));
}

function placeIcon(type, cls) {
  const m = { city:'🏙️', town:'🏘️', village:'🏡', country:'🌍', island:'🏝️',
              beach:'🏖️', mountain:'🏔️', airport:'✈️', suburb:'🏠', state:'📍' };
  return m[type] || m[cls] || '📍';
}

function renderSuggestions(results) {
  const list = document.getElementById('autocomplete-list');
  if (!list) return;
  if (!results.length) {
    list.innerHTML = '<div class="autocomplete-loading">Keine Ergebnisse</div>';
    list.classList.remove('hidden');
    return;
  }
  acResults = results;
  list.innerHTML = results.map((r, i) => {
    const main = r.address?.city || r.address?.town || r.address?.village || r.address?.state || r.display_name.split(',')[0];
    const sub  = [r.address?.state, r.address?.country].filter(Boolean).join(', ');
    return `<div class="autocomplete-item" data-idx="${i}">
      <div class="ac-icon">${placeIcon(r.type, r.class)}</div>
      <div><div class="ac-main">${escHtml(main)}</div><div class="ac-sub">${escHtml(sub)}</div></div>
    </div>`;
  }).join('');
  list.classList.remove('hidden');
}

function pickSuggestion(idx) {
  const r = acResults[idx]; if (!r) return;
  const name = r.address?.city || r.address?.town || r.address?.village || r.address?.state || r.address?.country || r.display_name.split(',')[0];
  const el = document.getElementById('input-dest');
  if (el) el.value = name;
  pendingGps = { lat: parseFloat(r.lat), lng: parseFloat(r.lon), name };
  const coordEl = document.getElementById('gps-coords');
  if (coordEl) {
    coordEl.textContent = `📍 ${pendingGps.lat.toFixed(5)}, ${pendingGps.lng.toFixed(5)} · ${name}`;
    coordEl.classList.remove('hidden');
  }
  // Hide GPS status if showing
  const gs = document.getElementById('gps-status');
  if (gs) gs.classList.add('hidden');
  hideAC();
}

function hideAC() {
  const list = document.getElementById('autocomplete-list');
  if (list) list.classList.add('hidden');
  // Small delay before clearing results so touchstart can still read them
  setTimeout(() => { acResults = []; }, 300);
}

function initAutocomplete() {
  if (window._acBound) return;
  window._acBound = true;

  // ── Search trigger ──
  function triggerSearch(inputEl) {
    clearTimeout(acTimer);
    const val = (inputEl.value || '').trim();
    if (val.length < 2) { hideAC(); return; }
    const list = document.getElementById('autocomplete-list');
    if (!list) return;
    list.innerHTML = '<div class="autocomplete-loading">🔍 Suche …</div>';
    list.classList.remove('hidden');
    acTimer = setTimeout(async () => {
      try {
        const results = await fetchPlaces(val);
        renderSuggestions(results);
      } catch (err) {
        const l = document.getElementById('autocomplete-list');
        if (l) {
          l.innerHTML = '<div class="autocomplete-loading">⚠️ Keine Verbindung</div>';
          l.classList.remove('hidden');
        }
      }
    }, 350);
  }

  // ── Input events (all variants for Android) ──
  document.addEventListener('input',          e => { if (e.target?.id === 'input-dest') triggerSearch(e.target); });
  document.addEventListener('keyup',          e => { if (e.target?.id === 'input-dest') triggerSearch(e.target); });
  document.addEventListener('compositionend', e => { if (e.target?.id === 'input-dest') triggerSearch(e.target); });

  // ── Click on suggestion ──
  document.addEventListener('click', e => {
    const item = e.target?.closest('.autocomplete-item');
    if (item) {
      e.preventDefault();
      e.stopPropagation();
      pickSuggestion(parseInt(item.dataset.idx));
      return;
    }
    // Close if clicking outside input AND outside list
    const inInput = e.target?.id === 'input-dest';
    const inList  = e.target?.closest('#autocomplete-list');
    if (!inInput && !inList) hideAC();
  });

  // ── Touch on suggestion (mobile) ──
  document.addEventListener('touchstart', e => {
    const item = e.target?.closest('.autocomplete-item');
    if (item) {
      e.preventDefault();
      pickSuggestion(parseInt(item.dataset.idx));
    }
  }, { passive: false });
}

// ════════════════════════════════════════
//  GPS
// ════════════════════════════════════════
function requestGPS() {
  if (!navigator.geolocation) { gpsStatus('❌ GPS nicht verfügbar', true); return; }
  document.getElementById('btn-gps').classList.add('loading');
  gpsStatus('📡 Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('btn-gps').classList.remove('loading');
    const { latitude: lat, longitude: lng } = pos.coords;
    pendingGps = { lat, lng };
    gpsStatus('✅ Standort gefunden!');
    const c = document.getElementById('gps-coords');
    if (c) { c.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`; c.classList.remove('hidden'); }
    hideAC();
    fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=de`)
      .then(r => r.json()).then(d => {
        const f = d?.features?.[0]?.properties || {};
        const name = f.city || f.town || f.name || f.state || '';
        pendingGps.name = name;
        const el = document.getElementById('input-dest');
        if (el && !el.value.trim()) el.value = name;
        if (c) c.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}${name?' · '+name:''}`;
      }).catch(() => {});
  }, () => {
    document.getElementById('btn-gps').classList.remove('loading');
    gpsStatus('❌ GPS verweigert', true);
  }, { enableHighAccuracy: true, timeout: 10000 });
}
function gpsStatus(msg, err=false) {
  const el = document.getElementById('gps-status');
  if (el) { el.textContent = msg; el.style.color = err ? 'var(--coral)' : 'var(--teal)'; el.classList.remove('hidden'); }
}

// ════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════
function daysUntil(d) {
  const t = new Date(); t.setHours(0,0,0,0);
  const s = new Date(d); s.setHours(0,0,0,0);
  return Math.ceil((s-t)/86400000);
}
function fmtDate(s) {
  return s ? new Date(s).toLocaleDateString('de-DE',{day:'numeric',month:'short',year:'numeric'}) : '';
}
function duration(s,e) { return (!s||!e) ? 1 : Math.max(1,Math.ceil((new Date(e)-new Date(s))/86400000)); }
function progress(trip) {
  const cr = trip.createdAt?.toDate ? trip.createdAt.toDate() : new Date(trip.createdAt||Date.now());
  const st = new Date(trip.startDate), now = new Date();
  if (now>=st) return 100;
  const total = st-cr; if (total<=0) return 0;
  return Math.min(100,Math.max(0,Math.round(((now-cr)/total)*100)));
}
function gradient(trip) { return GRADIENTS[(trip.gradientIndex??Math.abs((trip.id||'').charCodeAt(0)))%GRADIENTS.length]; }
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// Returns true only for real https:// Storage URLs
function isStorageUrl(s) { return s && s.startsWith('https://'); }

// ════════════════════════════════════════
//  RENDER
// ════════════════════════════════════════
function renderHome() {
  const up  = trips.filter(t=>daysUntil(t.startDate)>=0).sort((a,b)=>new Date(a.startDate)-new Date(b.startDate));
  const hero=document.getElementById('hero-section');
  const list=document.getElementById('trip-list');
  const empty=document.getElementById('empty-state');
  const cnt=document.getElementById('trip-count-label');
  if (up.length) {
    hero.innerHTML = heroHTML(up[0], daysUntil(up[0].startDate));
    hero.querySelector('.hero-card').addEventListener('click', ()=>openDetail(up[0].id));
  } else hero.innerHTML='';
  list.innerHTML='';
  if (!up.length) { empty.classList.remove('hidden'); cnt.textContent=''; }
  else { empty.classList.add('hidden'); cnt.textContent=`${up.length} Reise${up.length!==1?'n':''}`; up.forEach(t=>list.appendChild(tripCard(t))); }
}
function heroHTML(t, days) {
  const bg = isStorageUrl(t.image) ? `background-image:url(${t.image})` : `background:${gradient(t)}`;
  const d  = days===0?'Heute!':days, u=days===0?'':`<span class="unit">Tag${days!==1?'e':''}</span>`;
  return `<div class="hero-card"><div class="hero-bg" style="${bg}"></div><div class="hero-overlay"></div>
    <div class="hero-emoji">${t.emoji||'✈️'}</div>
    <div class="hero-content"><div class="hero-badge">Nächste Reise</div>
    <div class="hero-days">${d}${u}</div>
    <div class="hero-dest"><svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${escHtml(t.destination)} · ${fmtDate(t.startDate)}</div></div></div>`;
}
function tripCard(t) {
  const days=daysUntil(t.startDate);
  const bg=isStorageUrl(t.image)?`background-image:url(${t.image});background-size:cover;background-position:center`:`background:${gradient(t)}`;
  let pc='countdown-pill',pt='';
  if(days<0){pc+=' past';pt='Vergangen';}
  else if(days===0){pc+=' soon';pt='Heute! 🎉';}
  else if(days<=14){pc+=' soon';pt=`${days}T`;}
  else pt=`${days} Tage`;
  const pg=progress(t);
  const d=document.createElement('div'); d.className='trip-card';
  d.innerHTML=`<div class="trip-thumb"><div class="trip-thumb-inner" style="${bg}">${isStorageUrl(t.image)?'':(t.emoji||'✈️')}</div></div>
    <div class="trip-info"><div><div class="trip-name">${escHtml(t.destination)}</div>
    <div class="trip-date">${fmtDate(t.startDate)}${t.endDate?' – '+fmtDate(t.endDate):''}</div></div>
    <div class="trip-bottom"><div class="${pc}">${pt}</div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pg}%"></div></div></div></div>`;
  d.addEventListener('click',()=>openDetail(t.id)); return d;
}

function renderArchive() {
  const past=trips.filter(t=>daysUntil(t.startDate)<0).sort((a,b)=>new Date(b.startDate)-new Date(a.startDate));
  const list=document.getElementById('archive-list');
  const empty=document.getElementById('archive-empty');
  list.innerHTML='';
  !past.length ? empty.classList.remove('hidden') : (empty.classList.add('hidden'), past.forEach(t=>list.appendChild(tripCard(t))));
}

// ════════════════════════════════════════
//  MAP
// ════════════════════════════════════════
function initMap() {
  if (leafletMap) return;
  leafletMap = L.map('leaflet-map',{zoomControl:true}).setView([20,10],2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{attribution:'© OSM · © CARTO',maxZoom:18}).addTo(leafletMap);
}
function renderMap() {
  if (!leafletMap) initMap();
  mapMarkers.forEach(m=>m.remove()); mapMarkers=[];
  const wc=trips.filter(t=>t.lat&&t.lng);
  const el=document.getElementById('map-count'); if(el) el.textContent=`${wc.length} Pin${wc.length!==1?'s':''}`;
  wc.forEach(t=>{
    const days=daysUntil(t.startDate), color=days<0?'#A09890':days<=14?'#E8735A':'#D4A853';
    const icon=L.divIcon({className:'',html:`<div style="background:${color};width:36px;height:36px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 4px 12px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;"><span style="transform:rotate(45deg);font-size:16px;">${t.emoji||'✈️'}</span></div>`,iconSize:[36,36],iconAnchor:[18,36],popupAnchor:[0,-38]});
    const dl=days<0?'Vergangen':days===0?'Heute!':`${days} Tage`;
    const m=L.marker([t.lat,t.lng],{icon}).addTo(leafletMap).bindPopup(`<strong style="font-family:'Playfair Display',serif;color:#F5EFE6">${escHtml(t.destination)}</strong><br><span style="font-size:.75rem;color:#A09890">${fmtDate(t.startDate)}</span><br><span style="color:#D4A853;font-weight:600">${dl}</span>`);
    mapMarkers.push(m);
  });
  if (wc.length) leafletMap.fitBounds(L.latLngBounds(wc.map(t=>[t.lat,t.lng])),{padding:[40,40],maxZoom:8});
  setTimeout(()=>leafletMap.invalidateSize(),100);
}

// ════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════
function openDetail(id) {
  const t=trips.find(x=>x.id===id); if(!t) return;
  const days=daysUntil(t.startDate), dur=duration(t.startDate,t.endDate), pg=progress(t);
  const bg=isStorageUrl(t.image)?`background-image:url(${t.image});background-size:cover;background-position:center`:`background:${gradient(t)}`;
  const cl=t.checklist||[];
  const chk=cl.map((c,i)=>`<div class="checklist-item"><div class="check-circle ${c.done?'done':''}" data-idx="${i}">${c.done?'<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>':''}</div><span class="check-label ${c.done?'done-text':''}">${escHtml(c.text)}</span></div>`).join('');
  const gpsH=t.lat?`<div class="gps-coords" style="display:block;margin-bottom:18px;">📍 ${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}${t.gpsName?' · '+escHtml(t.gpsName):''}</div>`:'';
  const notH=t.notes?`<div class="notes-box" style="margin-bottom:18px;"><div class="section-heading" style="margin-bottom:8px;"><h3>Notizen</h3></div><p>${escHtml(t.notes)}</p></div>`:'';
  const dl=days<0?'Vorbei':days===0?'Heute!':days, du=days<0?'':days===0?'🎉':'Tage';
  document.getElementById('detail-content').innerHTML=`
    <div class="detail-header"><div class="detail-hero-img" style="${bg}">${isStorageUrl(t.image)?'':(t.emoji||'✈️')}</div><div class="detail-hero-overlay"></div>
    <button class="detail-back" id="d-back"><svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg></button>
    <button class="detail-edit" id="d-edit"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button></div>
    <div class="detail-scroll">
      <div style="margin-bottom:18px;"><div class="detail-title">${escHtml(t.destination)}</div>
      <div class="detail-sub"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${fmtDate(t.startDate)}${t.endDate?' – '+fmtDate(t.endDate):''} · ${dur} Nacht${dur!==1?'e':''}</div></div>
      ${gpsH}
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-icon">⏳</div><div class="stat-val">${dl}</div><div class="stat-unit">${du}</div></div>
        <div class="stat-box"><div class="stat-icon">🌅</div><div class="stat-val">${dur}</div><div class="stat-unit">Reisetage</div></div>
        <div class="stat-box"><div class="stat-icon">✅</div><div class="stat-val">${cl.filter(c=>c.done).length}/${cl.length}</div><div class="stat-unit">Aufgaben</div></div>
        <div class="stat-box"><div class="stat-icon">${t.emoji||'✈️'}</div><div class="stat-val" style="font-size:1rem;padding-top:4px;">${pg}%</div><div class="stat-unit">Wartezeit vorbei</div></div>
      </div>
      ${days>=0?`<div class="progress-section"><div class="progress-section-top"><span>Countdown-Fortschritt</span><strong>${pg}%</strong></div><div class="progress-bar" style="height:8px;"><div class="progress-fill" style="width:${pg}%"></div></div></div>`:''}
      ${notH}
      <div class="section-heading"><h3>Packliste</h3></div>
      <div class="checklist" id="d-checklist">${chk}</div>
      <div class="add-check-row"><input type="text" id="new-check-input" placeholder="Neue Aufgabe …"/><button id="btn-add-check">+ Add</button></div>
    </div>`;
  document.getElementById('d-back').addEventListener('click',()=>showScreen('home'));
  document.getElementById('d-edit').addEventListener('click',()=>openEdit(id));
  document.getElementById('d-checklist').addEventListener('click',async e=>{
    const c=e.target.closest('.check-circle'); if(!c) return;
    const i=parseInt(c.dataset.idx), trip=trips.find(x=>x.id===id); if(!trip) return;
    const upd=[...(trip.checklist||[])]; upd[i].done=!upd[i].done;
    await updateDoc(tripDoc(id),{checklist:upd});
  });
  document.getElementById('btn-add-check').addEventListener('click',()=>addCheck(id));
  document.getElementById('new-check-input').addEventListener('keydown',e=>{if(e.key==='Enter')addCheck(id);});
  showScreen('detail');
}
async function addCheck(id) {
  const inp=document.getElementById('new-check-input'), txt=inp.value.trim(); if(!txt) return;
  const t=trips.find(x=>x.id===id); if(!t) return;
  await updateDoc(tripDoc(id),{checklist:[...(t.checklist||[]),{text:txt,done:false}]});
  inp.value='';
}

// ════════════════════════════════════════
//  MODAL – ADD / EDIT
// ════════════════════════════════════════
function resetModal() {
  pendingFile=null; pendingGps=null;
  ['input-dest','input-notes'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  ['input-start','input-end'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const prev=document.getElementById('image-preview');
  if(prev){prev.src='';prev.style.display='none';}
  document.getElementById('image-preview-wrap').style.display='flex';
  document.getElementById('btn-remove-image').classList.add('hidden');
  document.getElementById('btn-delete-trip').classList.add('hidden');
  document.getElementById('form-error').classList.add('hidden');
  const gs=document.getElementById('gps-status');if(gs)gs.classList.add('hidden');
  const gc=document.getElementById('gps-coords');if(gc)gc.classList.add('hidden');
  document.getElementById('image-input').value='';
  // Autocomplete uses event delegation – no reset needed
}

function openAdd() {
  editingId=null; selectedEmoji='🏖️';
  document.getElementById('modal-title').textContent='Neue Reise';
  resetModal(); updateEmojiPicker(); openModal();
}

function openEdit(id) {
  const t=trips.find(x=>x.id===id); if(!t) return;
  editingId=id; selectedEmoji=t.emoji||'🏖️';
  pendingGps=t.lat?{lat:t.lat,lng:t.lng,name:t.gpsName}:null;
  pendingFile=null;
  document.getElementById('modal-title').textContent='Reise bearbeiten';
  resetModal();
  document.getElementById('input-dest').value=t.destination;
  document.getElementById('input-start').value=t.startDate;
  document.getElementById('input-end').value=t.endDate||'';
  document.getElementById('input-notes').value=t.notes||'';
  document.getElementById('btn-delete-trip').classList.remove('hidden');
  if (t.lat) {
    const c=document.getElementById('gps-coords');
    c.textContent=`📍 ${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}${t.gpsName?' · '+t.gpsName:''}`;
    c.classList.remove('hidden');
  }
  // Only show image preview for valid Storage URLs (not legacy base64)
  if (isStorageUrl(t.image)) {
    document.getElementById('image-preview').src=t.image;
    document.getElementById('image-preview').style.display='block';
    document.getElementById('image-preview-wrap').style.display='none';
    document.getElementById('btn-remove-image').classList.remove('hidden');
  }
  updateEmojiPicker(); openModal();
}

function openModal() {
  const ov=document.getElementById('modal-overlay');
  ov.classList.remove('hidden');
  requestAnimationFrame(()=>ov.style.opacity='1');
}
function closeModal() {
  const ov=document.getElementById('modal-overlay');
  ov.style.opacity='0';
  setTimeout(()=>ov.classList.add('hidden'),280);
  hideAC();
}

async function saveTrip() {
  const dest  = document.getElementById('input-dest').value.trim();
  const start = document.getElementById('input-start').value;
  const end   = document.getElementById('input-end').value;
  const notes = document.getElementById('input-notes').value.trim();

  if (!dest)  { showFormError('Bitte gib ein Reiseziel ein.'); return; }
  if (!start) { showFormError('Bitte wähle ein Abreisedatum.'); return; }
  if (end && end < start) { showFormError('Rückkehr kann nicht vor der Abreise liegen.'); return; }

  const btn=document.getElementById('btn-save-trip');
  btn.textContent='Speichern …'; btn.disabled=true;
  document.getElementById('form-error').classList.add('hidden');

  try {
    const existing = editingId ? trips.find(t=>t.id===editingId) : null;

    // Fields guaranteed NOT to contain an image
    const safe = {
      destination:dest, startDate:start, endDate:end||null, notes,
      emoji:selectedEmoji,
      checklist: existing?.checklist||[],
      gradientIndex: existing?.gradientIndex??Math.floor(Math.random()*GRADIENTS.length),
      lat: pendingGps?.lat||null, lng: pendingGps?.lng||null, gpsName: pendingGps?.name||null,
    };

    if (editingId) {
      // Determine image URL first (before any Firestore write)
      let imageUrl = null;
      if (pendingFile) {
        imageUrl = await uploadImage(pendingFile, editingId);
      } else if (isStorageUrl(existing?.image)) {
        imageUrl = existing.image;
      }

      // Check if existing doc has oversized image (legacy base64)
      const hasLegacyImage = existing?.image && !isStorageUrl(existing.image);

      if (hasLegacyImage) {
        // Use REST API for the COMPLETE update - bypasses SDK cache entirely
        await patchDocViaREST(editingId, {
          destination: dest,
          startDate: start,
          endDate: end || '',
          notes,
          emoji: selectedEmoji,
          image: imageUrl || '',
          lat: pendingGps?.lat || 0,
          lng: pendingGps?.lng || 0,
          gpsName: pendingGps?.name || '',
        });
      } else {
        // Normal SDK update for clean documents
        await updateDoc(tripDoc(editingId), {
          ...safe,
          image: imageUrl,
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      // New trip – create doc first to get ID, then upload image
      const ref = await addDoc(tripsRef(), { ...safe, image: null, createdAt: serverTimestamp() });
      if (pendingFile) {
        const url = await uploadImage(pendingFile, ref.id);
        await updateDoc(ref, { image: url });
      }
    }

    closeModal();
    showToast(editingId ? '✏️ Reise aktualisiert!' : '✈️ Reise gespeichert!');
  } catch(e) {
    showFormError('Fehler: ' + e.message);
    console.error(e);
  } finally {
    btn.textContent='Reise speichern ✈'; btn.disabled=false;
  }
}

async function deleteTrip() {
  if(!editingId||!confirm('Diese Reise wirklich löschen?')) return;
  await deleteDoc(tripDoc(editingId)); closeModal(); showToast('🗑️ Reise gelöscht');
}
function showFormError(msg) {
  const el=document.getElementById('form-error'); if(el){el.textContent=msg;el.classList.remove('hidden');}
}

// ════════════════════════════════════════
//  EMOJI + IMAGE UI
// ════════════════════════════════════════
function updateEmojiPicker() {
  document.querySelectorAll('.emoji-opt').forEach(el=>el.classList.toggle('selected',el.dataset.emoji===selectedEmoji));
}
function handleImageUpload(file) {
  if (!file) return;
  pendingFile = file;
  const url = URL.createObjectURL(file);
  document.getElementById('image-preview').src = url;
  document.getElementById('image-preview').style.display = 'block';
  document.getElementById('image-preview-wrap').style.display = 'none';
  document.getElementById('btn-remove-image').classList.remove('hidden');
  showToast(`📸 ${Math.round(file.size/1024)} KB – wird beim Speichern komprimiert`);
}

// ════════════════════════════════════════
//  NAV + TOAST + EXPORT
// ════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  const el=document.getElementById(`screen-${name}`); if(el) el.classList.add('active');
  if (name==='map') setTimeout(()=>{initMap();renderMap();leafletMap.invalidateSize();},100);
}
function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.remove('hidden'); t.classList.add('show');
  setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.classList.add('hidden'),300);},2800);
}
function exportJSON() {
  const blob=new Blob([JSON.stringify(trips,null,2)],{type:'application/json'});
  Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:'tripcount.json'}).click();
  showToast('📤 Export erfolgreich!');
}

// ════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initAutocomplete(); // bind once via event delegation
  document.getElementById('btn-google-login').addEventListener('click', loginGoogle);

  ['btn-open-add','btn-empty-add','btn-nav-add','btn-map-add','btn-archive-add']
    .forEach(id => document.getElementById(id)?.addEventListener('click', openAdd));

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id==='modal-overlay') closeModal();
  });
  document.getElementById('btn-save-trip').addEventListener('click', saveTrip);
  document.getElementById('btn-delete-trip').addEventListener('click', deleteTrip);
  document.getElementById('btn-gps').addEventListener('click', requestGPS);

  document.getElementById('emoji-picker').addEventListener('click', e => {
    const opt=e.target.closest('.emoji-opt'); if(opt){selectedEmoji=opt.dataset.emoji;updateEmojiPicker();}
  });

  const uploadArea=document.getElementById('image-upload-area');
  const imageInput=document.getElementById('image-input');
  uploadArea.addEventListener('click', e => { if(e.target.id!=='btn-remove-image') imageInput.click(); });
  imageInput.addEventListener('change', e => handleImageUpload(e.target.files[0]));
  document.getElementById('btn-remove-image').addEventListener('click', e => {
    e.stopPropagation();
    pendingFile=null;
    document.getElementById('image-preview').style.display='none';
    document.getElementById('image-preview-wrap').style.display='flex';
    document.getElementById('btn-remove-image').classList.add('hidden');
    imageInput.value='';
  });

  document.querySelectorAll('[data-nav]').forEach(btn =>
    btn.addEventListener('click', () => showScreen(btn.dataset.nav)));

  document.getElementById('btn-signout')?.addEventListener('click', logoutUser);
  document.getElementById('btn-export')?.addEventListener('click', exportJSON);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
});
