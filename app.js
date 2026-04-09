// ════════════════════════════════════════
//  TripCount v4 – Smart Compress + Autocomplete
// ════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
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
let currentUser   = null;
let trips         = [];
let unsubscribe   = null;
let editingId     = null;
let selectedEmoji = '🏖️';
let pendingGps    = null;
let pendingFile   = null;
let imageRemovedByUser = false;
let leafletMap    = null;
let mapMarkers    = [];
let acTimer       = null;   // autocomplete debounce
let acResults     = [];     // current suggestions

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
    showScreen('home'); updateUserUI(user); subscribeTrips(user.uid);
  } else {
    showScreen('login');
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    trips = [];
  }
});
async function loginGoogle() {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch { showToast('❌ Anmeldung fehlgeschlagen'); }
}
async function logoutUser() { await signOut(auth); showToast('👋 Abgemeldet'); }
function updateUserUI(user) {
  const av = document.getElementById('user-avatar');
  const sav = document.getElementById('settings-avatar');
  if (user.photoURL) { av.src = user.photoURL; av.classList.remove('hidden'); if(sav) sav.src = user.photoURL; }
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
  const q = query(collection(db, 'users', uid, 'trips'), orderBy('startDate','asc'));
  unsubscribe = onSnapshot(q,
    snap => { trips = snap.docs.map(d => ({id:d.id,...d.data()})); renderHome(); renderArchive(); renderMap(); },
    err  => showToast('❌ Sync-Fehler: ' + err.message)
  );
}
const tripsRef = () => collection(db, 'users', currentUser.uid, 'trips');
const tripDoc  = id => doc(db, 'users', currentUser.uid, 'trips', id);

// ════════════════════════════════════════
//  IMAGE COMPRESS → max 1 MB
// ════════════════════════════════════════
const MAX_BYTES = 1_000_000; // 1 MB target

async function compressToTarget(file) {
  // Try progressively lower quality until under 1 MB
  const img = await loadImage(file);
  let { width, height } = img;

  // Scale down if very large (max 1920px on longest side)
  const maxDim = 1920;
  if (width > maxDim || height > maxDim) {
    if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
    else                 { width = Math.round(width * maxDim / height);  height = maxDim; }
  }

  for (const quality of [0.92, 0.82, 0.70, 0.55, 0.40]) {
    const blob = await canvasToBlob(img, width, height, quality);
    if (blob.size <= MAX_BYTES) return blob;
    // Also try halving dimensions if still too big at low quality
    if (quality === 0.40) {
      width  = Math.round(width  * 0.7);
      height = Math.round(height * 0.7);
      const blob2 = await canvasToBlob(img, width, height, 0.75);
      return blob2; // return whatever we have
    }
  }
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

function canvasToBlob(img, w, h, quality) {
  return new Promise((res, rej) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/jpeg', quality);
  });
}

async function uploadImageToStorage(file, tripId) {
  const blob = await compressToTarget(file);
  const kb   = Math.round(blob.size / 1024);
  showToast(`📸 Bild komprimiert (${kb} KB) – wird hochgeladen …`);
  const path    = `users/${currentUser.uid}/trips/${tripId||('new_'+Date.now())}.jpg`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType:'image/jpeg' });
  return await getDownloadURL(fileRef);
}

// ════════════════════════════════════════
//  ADDRESS AUTOCOMPLETE (Nominatim OSM)
// ════════════════════════════════════════
async function fetchSuggestions(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&addressdetails=1&q=${encodeURIComponent(query)}`;
  const res  = await fetch(url, { headers: { 'Accept-Language': 'de' } });
  return await res.json();
}

function placeTypeIcon(type, cls) {
  const map = {
    city:'🏙️', town:'🏘️', village:'🏡', country:'🌍',
    island:'🏝️', beach:'🏖️', mountain:'🏔️', hotel:'🏨',
    tourism:'✈️', airport:'✈️', suburb:'🏠', state:'📍',
  };
  return map[type] || map[cls] || '📍';
}

function showAutocomplete(results) {
  const list = document.getElementById('autocomplete-list');
  if (!results.length) { list.classList.add('hidden'); return; }
  acResults = results;

  list.innerHTML = results.map((r, i) => {
    const main = r.address?.city || r.address?.town || r.address?.village ||
                 r.address?.state || r.address?.country || r.display_name.split(',')[0];
    const sub  = r.display_name.split(',').slice(1, 3).join(',').trim();
    const icon = placeTypeIcon(r.type, r.class);
    return `<div class="autocomplete-item" data-idx="${i}">
      <div class="ac-icon">${icon}</div>
      <div><div class="ac-main">${escHtml(main)}</div><div class="ac-sub">${escHtml(sub)}</div></div>
    </div>`;
  }).join('');

  list.classList.remove('hidden');
}

function selectSuggestion(idx) {
  const r    = acResults[idx];
  if (!r) return;
  const name = r.address?.city || r.address?.town || r.address?.village ||
               r.address?.state || r.address?.country || r.display_name.split(',')[0];
  document.getElementById('input-dest').value = name;
  pendingGps = { lat: parseFloat(r.lat), lng: parseFloat(r.lon), name };
  // Show coords
  const coordEl = document.getElementById('gps-coords');
  coordEl.textContent = `📍 ${parseFloat(r.lat).toFixed(5)}, ${parseFloat(r.lon).toFixed(5)} · ${name}`;
  coordEl.classList.remove('hidden');
  document.getElementById('gps-status').classList.add('hidden');
  hideAutocomplete();
}

function hideAutocomplete() {
  document.getElementById('autocomplete-list')?.classList.add('hidden');
  acResults = [];
}

function initAutocomplete() {
  // Called every time modal opens – safe because we check if already bound
  const input = document.getElementById('input-dest');
  const list  = document.getElementById('autocomplete-list');
  if (!input || !list || input.dataset.acBound) return;
  input.dataset.acBound = '1'; // mark as bound so we don't double-attach

  input.addEventListener('input', () => {
    clearTimeout(acTimer);
    const val = input.value.trim();
    if (val.length < 2) { hideAutocomplete(); return; }
    list.innerHTML = '<div class="autocomplete-loading">🔍 Suche …</div>';
    list.classList.remove('hidden');
    acTimer = setTimeout(async () => {
      try {
        const results = await fetchSuggestions(val);
        showAutocomplete(results);
      } catch { hideAutocomplete(); }
    }, 400);
  });

  list.addEventListener('click', e => {
    const item = e.target.closest('.autocomplete-item');
    if (!item) return;
    selectSuggestion(parseInt(item.dataset.idx));
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#input-dest') && !e.target.closest('#autocomplete-list')) {
      hideAutocomplete();
    }
  });
}

// ════════════════════════════════════════
//  GPS (device location)
// ════════════════════════════════════════
function requestGPS() {
  if (!navigator.geolocation) { showGpsStatus('❌ GPS nicht verfügbar', true); return; }
  const btn = document.getElementById('btn-gps');
  btn.classList.add('loading');
  showGpsStatus('📡 Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.classList.remove('loading');
      const { latitude: lat, longitude: lng } = pos.coords;
      pendingGps = { lat, lng };
      showGpsStatus('✅ Standort gefunden!');
      const coordEl = document.getElementById('gps-coords');
      coordEl.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      coordEl.classList.remove('hidden');
      hideAutocomplete();
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, { headers:{'Accept-Language':'de'} })
        .then(r => r.json()).then(data => {
          const name = data.address?.city || data.address?.town || data.address?.state || '';
          pendingGps.name = name;
          const dest = document.getElementById('input-dest');
          if (!dest.value.trim()) dest.value = name;
          coordEl.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}${name?' · '+name:''}`;
        }).catch(()=>{});
    },
    () => { document.getElementById('btn-gps').classList.remove('loading'); showGpsStatus('❌ GPS verweigert', true); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}
function showGpsStatus(msg, isError=false) {
  const el = document.getElementById('gps-status');
  el.textContent = msg; el.style.color = isError ? 'var(--coral)' : 'var(--teal)';
  el.classList.remove('hidden');
}

// ════════════════════════════════════════
//  DATE HELPERS
// ════════════════════════════════════════
function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const t = new Date(dateStr); t.setHours(0,0,0,0);
  return Math.ceil((t - today) / 86400000);
}
function formatDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleDateString('de-DE', {day:'numeric',month:'short',year:'numeric'});
}
function tripDuration(s, e) {
  if (!s||!e) return 1;
  return Math.max(1, Math.ceil((new Date(e)-new Date(s))/86400000));
}
function waitProgress(trip) {
  const created = trip.createdAt?.toDate ? trip.createdAt.toDate() : new Date(trip.createdAt||Date.now());
  const start = new Date(trip.startDate), now = new Date();
  if (now >= start) return 100;
  const total = start - created;
  return total <= 0 ? 0 : Math.min(100, Math.max(0, Math.round(((now-created)/total)*100)));
}
function getGradient(trip) {
  const idx = trip.gradientIndex !== undefined ? trip.gradientIndex : Math.abs((trip.id||'').charCodeAt(0))%GRADIENTS.length;
  return GRADIENTS[idx];
}
function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════
//  RENDER HOME
// ════════════════════════════════════════
function renderHome() {
  const upcoming = trips.filter(t=>daysUntil(t.startDate)>=0).sort((a,b)=>new Date(a.startDate)-new Date(b.startDate));
  const heroEl=document.getElementById('hero-section'), listEl=document.getElementById('trip-list');
  const emptyEl=document.getElementById('empty-state'), cntEl=document.getElementById('trip-count-label');
  if (upcoming.length>0) {
    const next=upcoming[0];
    heroEl.innerHTML=buildHeroHTML(next,daysUntil(next.startDate));
    heroEl.querySelector('.hero-card').addEventListener('click',()=>openDetail(next.id));
  } else heroEl.innerHTML='';
  listEl.innerHTML='';
  if (upcoming.length===0) { emptyEl.classList.remove('hidden'); cntEl.textContent=''; }
  else { emptyEl.classList.add('hidden'); cntEl.textContent=`${upcoming.length} Reise${upcoming.length!==1?'n':''}`; upcoming.forEach(t=>listEl.appendChild(buildTripCard(t))); }
}
function buildHeroHTML(trip,days) {
  const bg=trip.image?`background-image:url(${trip.image})`:`background:${getGradient(trip)}`;
  const txt=days===0?'Heute!':days, unit=days===0?'':`<span class="unit">Tag${days!==1?'e':''}</span>`;
  return `<div class="hero-card"><div class="hero-bg" style="${bg}"></div><div class="hero-overlay"></div>
    <div class="hero-emoji">${trip.emoji||'✈️'}</div>
    <div class="hero-content"><div class="hero-badge">Nächste Reise</div>
    <div class="hero-days">${txt}${unit}</div>
    <div class="hero-dest"><svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${escHtml(trip.destination)} · ${formatDate(trip.startDate)}</div></div></div>`;
}
function buildTripCard(trip) {
  const days=daysUntil(trip.startDate);
  const bg=trip.image?`background-image:url(${trip.image});background-size:cover;background-position:center`:`background:${getGradient(trip)}`;
  let pillCls='countdown-pill',pillTxt='';
  if(days<0){pillCls+=' past';pillTxt='Vergangen';}
  else if(days===0){pillCls+=' soon';pillTxt='Heute! 🎉';}
  else if(days<=14){pillCls+=' soon';pillTxt=`${days} Tag${days!==1?'e':''}`;}
  else pillTxt=`${days} Tage`;
  const prog=waitProgress(trip);
  const div=document.createElement('div'); div.className='trip-card';
  div.innerHTML=`<div class="trip-thumb"><div class="trip-thumb-inner" style="${bg}">${trip.image?'':(trip.emoji||'✈️')}</div></div>
    <div class="trip-info"><div><div class="trip-name">${escHtml(trip.destination)}</div>
    <div class="trip-date">${formatDate(trip.startDate)}${trip.endDate?' – '+formatDate(trip.endDate):''}</div></div>
    <div class="trip-bottom"><div class="${pillCls}">${pillTxt}</div>
    <div class="progress-bar"><div class="progress-fill" style="width:${prog}%"></div></div></div></div>`;
  div.addEventListener('click',()=>openDetail(trip.id));
  return div;
}

// ════════════════════════════════════════
//  RENDER ARCHIVE
// ════════════════════════════════════════
function renderArchive() {
  const past=trips.filter(t=>daysUntil(t.startDate)<0).sort((a,b)=>new Date(b.startDate)-new Date(a.startDate));
  const listEl=document.getElementById('archive-list'), emptyEl=document.getElementById('archive-empty');
  listEl.innerHTML='';
  past.length===0?emptyEl.classList.remove('hidden'):(emptyEl.classList.add('hidden'),past.forEach(t=>listEl.appendChild(buildTripCard(t))));
}

// ════════════════════════════════════════
//  LEAFLET MAP
// ════════════════════════════════════════
function initMap() {
  if(leafletMap) return;
  leafletMap=L.map('leaflet-map',{zoomControl:true}).setView([20,10],2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{attribution:'© OpenStreetMap · © CARTO',maxZoom:18}).addTo(leafletMap);
}
function renderMap() {
  if(!leafletMap) initMap();
  mapMarkers.forEach(m=>m.remove()); mapMarkers=[];
  const wc=trips.filter(t=>t.lat&&t.lng);
  const cntEl=document.getElementById('map-count');
  if(cntEl) cntEl.textContent=`${wc.length} Pin${wc.length!==1?'s':''}`;
  wc.forEach(trip=>{
    const days=daysUntil(trip.startDate);
    const color=days<0?'#A09890':days<=14?'#E8735A':'#D4A853';
    const icon=L.divIcon({className:'',
      html:`<div style="background:${color};width:36px;height:36px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 4px 12px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;"><span style="transform:rotate(45deg);font-size:16px;">${trip.emoji||'✈️'}</span></div>`,
      iconSize:[36,36],iconAnchor:[18,36],popupAnchor:[0,-38]});
    const dl=days<0?'Vergangen':days===0?'Heute!':`${days} Tage`;
    const m=L.marker([trip.lat,trip.lng],{icon}).addTo(leafletMap)
      .bindPopup(`<strong style="font-family:'Playfair Display',serif;font-size:1rem;color:#F5EFE6">${escHtml(trip.destination)}</strong><br><span style="font-size:.75rem;color:#A09890">${formatDate(trip.startDate)}</span><br><span style="font-size:.8rem;color:#D4A853;font-weight:600">${dl}</span>`);
    mapMarkers.push(m);
  });
  if(wc.length>0) leafletMap.fitBounds(L.latLngBounds(wc.map(t=>[t.lat,t.lng])),{padding:[40,40],maxZoom:8});
  setTimeout(()=>leafletMap.invalidateSize(),100);
}

// ════════════════════════════════════════
//  DETAIL VIEW
// ════════════════════════════════════════
function openDetail(id) {
  const trip=trips.find(t=>t.id===id); if(!trip) return;
  const days=daysUntil(trip.startDate), dur=tripDuration(trip.startDate,trip.endDate), prog=waitProgress(trip);
  const bg=trip.image?`background-image:url(${trip.image});background-size:cover;background-position:center`:`background:${getGradient(trip)}`;
  const checklist=trip.checklist||[];
  const checkHTML=checklist.map((item,i)=>`<div class="checklist-item"><div class="check-circle ${item.done?'done':''}" data-idx="${i}">${item.done?'<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>':''}</div><span class="check-label ${item.done?'done-text':''}">${escHtml(item.text)}</span></div>`).join('');
  const gpsHTML=trip.lat?`<div class="gps-coords" style="display:block;margin-bottom:18px;">📍 ${trip.lat.toFixed(5)}, ${trip.lng.toFixed(5)}${trip.gpsName?' · '+escHtml(trip.gpsName):''}</div>`:'';
  const notesHTML=trip.notes?`<div class="notes-box" style="margin-bottom:18px;"><div class="section-heading" style="margin-bottom:8px;"><h3>Notizen</h3></div><p>${escHtml(trip.notes)}</p></div>`:'';
  const daysLabel=days<0?'Vorbei':days===0?'Heute!':days, daysUnit=days<0?'':days===0?'🎉':'Tage';
  document.getElementById('detail-content').innerHTML=`
    <div class="detail-header"><div class="detail-hero-img" style="${bg}">${trip.image?'':(trip.emoji||'✈️')}</div><div class="detail-hero-overlay"></div>
    <button class="detail-back" id="d-back"><svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg></button>
    <button class="detail-edit" id="d-edit"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button></div>
    <div class="detail-scroll">
      <div style="margin-bottom:18px;"><div class="detail-title">${escHtml(trip.destination)}</div>
      <div class="detail-sub"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${formatDate(trip.startDate)}${trip.endDate?' – '+formatDate(trip.endDate):''} · ${dur} Nacht${dur!==1?'e':''}</div></div>
      ${gpsHTML}
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-icon">⏳</div><div class="stat-val">${daysLabel}</div><div class="stat-unit">${daysUnit}</div></div>
        <div class="stat-box"><div class="stat-icon">🌅</div><div class="stat-val">${dur}</div><div class="stat-unit">Reisetage</div></div>
        <div class="stat-box"><div class="stat-icon">✅</div><div class="stat-val">${checklist.filter(c=>c.done).length}/${checklist.length}</div><div class="stat-unit">Aufgaben</div></div>
        <div class="stat-box"><div class="stat-icon">${trip.emoji||'✈️'}</div><div class="stat-val" style="font-size:1rem;padding-top:4px;">${prog}%</div><div class="stat-unit">Wartezeit vorbei</div></div>
      </div>
      ${days>=0?`<div class="progress-section"><div class="progress-section-top"><span>Countdown-Fortschritt</span><strong>${prog}%</strong></div><div class="progress-bar" style="height:8px;"><div class="progress-fill" style="width:${prog}%"></div></div></div>`:''}
      ${notesHTML}
      <div class="section-heading"><h3>Packliste</h3></div>
      <div class="checklist" id="d-checklist">${checkHTML}</div>
      <div class="add-check-row"><input type="text" id="new-check-input" placeholder="Neue Aufgabe …"/><button id="btn-add-check">+ Add</button></div>
    </div>`;
  document.getElementById('d-back').addEventListener('click',()=>showScreen('home'));
  document.getElementById('d-edit').addEventListener('click',()=>openEdit(id));
  document.getElementById('d-checklist').addEventListener('click',async e=>{
    const circle=e.target.closest('.check-circle'); if(!circle) return;
    const idx=parseInt(circle.dataset.idx), t=trips.find(x=>x.id===id); if(!t) return;
    const updated=[...(t.checklist||[])]; updated[idx].done=!updated[idx].done;
    await updateDoc(tripDoc(id),{checklist:updated});
  });
  document.getElementById('btn-add-check').addEventListener('click',()=>addCheck(id));
  document.getElementById('new-check-input').addEventListener('keydown',e=>{if(e.key==='Enter')addCheck(id);});
  showScreen('detail');
}
async function addCheck(tripId) {
  const input=document.getElementById('new-check-input'), text=input.value.trim(); if(!text) return;
  const t=trips.find(x=>x.id===tripId); if(!t) return;
  await updateDoc(tripDoc(tripId),{checklist:[...(t.checklist||[]),{text,done:false}]});
  input.value='';
}

// ════════════════════════════════════════
//  ADD / EDIT MODAL
// ════════════════════════════════════════
function openAdd() {
  editingId=null; selectedEmoji='🏖️'; pendingGps=null; pendingFile=null; imageRemovedByUser=false;
  document.getElementById('modal-title').textContent='Neue Reise';
  ['input-dest','input-notes'].forEach(id=>document.getElementById(id).value='');
  ['input-start','input-end'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('image-preview').style.display='none';
  document.getElementById('image-preview-wrap').style.display='flex';
  document.getElementById('btn-remove-image').classList.add('hidden');
  document.getElementById('btn-delete-trip').classList.add('hidden');
  document.getElementById('form-error').classList.add('hidden');
  document.getElementById('gps-status').classList.add('hidden');
  document.getElementById('gps-coords').classList.add('hidden');
  document.getElementById('image-input').value='';
  hideAutocomplete(); updateEmojiPicker(); openModal();
}
function openEdit(id) {
  const trip=trips.find(t=>t.id===id); if(!trip) return;
  editingId=id; selectedEmoji=trip.emoji||'🏖️';
  pendingGps=trip.lat?{lat:trip.lat,lng:trip.lng,name:trip.gpsName}:null; pendingFile=null; imageRemovedByUser=false;
  document.getElementById('modal-title').textContent='Reise bearbeiten';
  document.getElementById('input-dest').value=trip.destination;
  document.getElementById('input-start').value=trip.startDate;
  document.getElementById('input-end').value=trip.endDate||'';
  document.getElementById('input-notes').value=trip.notes||'';
  document.getElementById('btn-delete-trip').classList.remove('hidden');
  document.getElementById('form-error').classList.add('hidden');
  const coordEl=document.getElementById('gps-coords');
  if(trip.lat){coordEl.textContent=`📍 ${trip.lat.toFixed(5)}, ${trip.lng.toFixed(5)}${trip.gpsName?' · '+trip.gpsName:''}`;coordEl.classList.remove('hidden');}
  else coordEl.classList.add('hidden');
  document.getElementById('gps-status').classList.add('hidden');
  // Only show image if it's a real URL (not legacy base64)
  const isRealUrl = trip.image && !trip.image.startsWith('data:');
  if(isRealUrl){
    document.getElementById('image-preview').src=trip.image;
    document.getElementById('image-preview').style.display='block';
    document.getElementById('image-preview-wrap').style.display='none';
    document.getElementById('btn-remove-image').classList.remove('hidden');
  } else {
    document.getElementById('image-preview').style.display='none';
    document.getElementById('image-preview-wrap').style.display='flex';
    document.getElementById('btn-remove-image').classList.add('hidden');
  }
  hideAutocomplete(); updateEmojiPicker(); openModal();
}
function openModal() {
  const ov = document.getElementById('modal-overlay');
  ov.classList.remove('hidden');
  requestAnimationFrame(() => ov.style.opacity = '1');
  setTimeout(initAutocomplete, 80); // DOM is ready after short delay
}
function closeModal() {
  const ov=document.getElementById('modal-overlay');
  ov.style.opacity='0'; setTimeout(()=>ov.classList.add('hidden'),280);
  hideAutocomplete();
}

async function saveTrip() {
  const dest  = document.getElementById('input-dest').value.trim();
  const start = document.getElementById('input-start').value;
  const end   = document.getElementById('input-end').value;
  const notes = document.getElementById('input-notes').value.trim();
  if (!dest)  { showFormError('Bitte gib ein Reiseziel ein.'); return; }
  if (!start) { showFormError('Bitte wähle ein Abreisedatum.'); return; }
  if (end && end < start) { showFormError('Rückkehr kann nicht vor der Abreise liegen.'); return; }
  document.getElementById('form-error').classList.add('hidden');
  const btn = document.getElementById('btn-save-trip');
  btn.textContent = 'Speichern …'; btn.disabled = true;
  try {
    const existing = editingId ? trips.find(t => t.id === editingId) : null;

    // ── Fields that never contain the image ──
    const safeFields = {
      destination: dest, startDate: start, endDate: end || null,
      notes, emoji: selectedEmoji,
      checklist: existing?.checklist || [],
      gradientIndex: existing?.gradientIndex ?? Math.floor(Math.random() * GRADIENTS.length),
      lat: pendingGps?.lat || null, lng: pendingGps?.lng || null, gpsName: pendingGps?.name || null,
    };

    if (editingId) {
      // Step 1: Always wipe the image field first (removes legacy base64)
      await updateDoc(tripDoc(editingId), { image: deleteField() });
      // Step 2: Update all safe fields
      await updateDoc(tripDoc(editingId), { ...safeFields, updatedAt: serverTimestamp() });
      // Step 3: If user uploaded a new file, upload + set URL
      if (pendingFile) {
        const url = await uploadImageToStorage(pendingFile, editingId);
        await updateDoc(tripDoc(editingId), { image: url });
      }
      // (If no new file: image stays deleted = no image. User can add one separately.)
    } else {
      // New trip: upload image first if any, then create doc
      let imageUrl = null;
      if (pendingFile) imageUrl = await uploadImageToStorage(pendingFile, null);
      await addDoc(tripsRef(), { ...safeFields, image: imageUrl, createdAt: serverTimestamp() });
    }

    closeModal();
    showToast(editingId ? '✏️ Reise aktualisiert!' : '✈️ Reise gespeichert!');
  } catch(e) { showFormError('Fehler: ' + e.message); }
  finally { btn.textContent = 'Reise speichern ✈'; btn.disabled = false; }
}
async function deleteTrip() {
  if(!editingId||!confirm('Diese Reise wirklich löschen?')) return;
  await deleteDoc(tripDoc(editingId)); closeModal(); showToast('🗑️ Reise gelöscht');
}
function showFormError(msg) {
  const el=document.getElementById('form-error'); el.textContent=msg; el.classList.remove('hidden');
}

// ════════════════════════════════════════
//  EMOJI + IMAGE
// ════════════════════════════════════════
function updateEmojiPicker() {
  document.querySelectorAll('.emoji-opt').forEach(el=>el.classList.toggle('selected',el.dataset.emoji===selectedEmoji));
}
function handleImageUpload(file) {
  if(!file) return;
  pendingFile=file;
  const url=URL.createObjectURL(file);
  document.getElementById('image-preview').src=url;
  document.getElementById('image-preview').style.display='block';
  document.getElementById('image-preview-wrap').style.display='none';
  document.getElementById('btn-remove-image').classList.remove('hidden');
  // Show estimated size
  const kb=Math.round(file.size/1024);
  showToast(`📸 ${kb} KB ausgewählt – wird beim Speichern komprimiert`);
}

// ════════════════════════════════════════
//  SCREEN NAV
// ════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  const el=document.getElementById(`screen-${name}`);
  if(el) el.classList.add('active');
  if(name==='map') setTimeout(()=>{initMap();renderMap();leafletMap.invalidateSize();},100);
}

// ════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════
function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.remove('hidden'); t.classList.add('show');
  setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.classList.add('hidden'),300);},2600);
}
function exportJSON() {
  const blob=new Blob([JSON.stringify(trips,null,2)],{type:'application/json'});
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:'tripcount-backup.json'});
  a.click(); showToast('📤 Export erfolgreich!');
}

// ════════════════════════════════════════
//  INIT
// ════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-google-login').addEventListener('click', loginGoogle);
  ['btn-open-add','btn-empty-add','btn-nav-add','btn-map-add','btn-archive-add']
    .forEach(id=>document.getElementById(id)?.addEventListener('click',openAdd));
  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e=>{if(e.target.id==='modal-overlay')closeModal();});
  document.getElementById('btn-save-trip').addEventListener('click', saveTrip);
  document.getElementById('btn-delete-trip').addEventListener('click', deleteTrip);
  document.getElementById('btn-gps').addEventListener('click', requestGPS);
  document.getElementById('emoji-picker').addEventListener('click', e=>{
    const opt=e.target.closest('.emoji-opt'); if(opt){selectedEmoji=opt.dataset.emoji;updateEmojiPicker();}
  });
  const uploadArea=document.getElementById('image-upload-area');
  const imageInput=document.getElementById('image-input');
  uploadArea.addEventListener('click', e=>{if(e.target.id!=='btn-remove-image')imageInput.click();});
  imageInput.addEventListener('change', e=>handleImageUpload(e.target.files[0]));
  document.getElementById('btn-remove-image').addEventListener('click', e=>{
    e.stopPropagation(); pendingFile=null; imageRemovedByUser=true;
    document.getElementById('image-preview').style.display='none';
    document.getElementById('image-preview-wrap').style.display='flex';
    document.getElementById('btn-remove-image').classList.add('hidden');
    imageInput.value='';
  });
  document.querySelectorAll('[data-nav]').forEach(btn=>btn.addEventListener('click',()=>showScreen(btn.dataset.nav)));
  document.getElementById('btn-signout')?.addEventListener('click', logoutUser);
  document.getElementById('btn-export')?.addEventListener('click', exportJSON);
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
});
