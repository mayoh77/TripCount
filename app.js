/* ════════════════════════════════════
   TripCount – app.js
   Full PWA logic with localStorage
════════════════════════════════════ */

const STORAGE_KEY = 'tripcount_trips';

// ── Gradient palettes for auto-bg ──
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

// ── State ──
let trips = [];
let currentTripId = null; // for edit
let selectedEmoji = '🏖️';

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  loadTrips();
  renderHome();
  renderArchive();
  bindEvents();
  registerSW();
});

// ── Service Worker ──
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ── Storage ──
function loadTrips() {
  try {
    trips = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch { trips = []; }
}

function saveTrips() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trips));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── Date helpers ──
function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(dateStr); target.setHours(0,0,0,0);
  return Math.ceil((target - today) / 86400000);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function tripDuration(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start), e = new Date(end);
  return Math.max(1, Math.ceil((e - s) / 86400000));
}

// Progress: percentage of wait time elapsed
function waitProgress(trip) {
  const created = new Date(trip.createdAt);
  const start   = new Date(trip.startDate);
  const today   = new Date();
  if (today >= start) return 100;
  const total = start - created;
  const elapsed = today - created;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

function getGradient(trip) {
  // Use stored index or hash from id
  const idx = (trip.gradientIndex !== undefined)
    ? trip.gradientIndex
    : Math.abs(trip.id.charCodeAt(0)) % GRADIENTS.length;
  return GRADIENTS[idx];
}

// ── Render: Home ──
function renderHome() {
  const upcoming = trips
    .filter(t => daysUntil(t.startDate) >= 0)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  const heroSection = document.getElementById('hero-section');
  const tripList = document.getElementById('trip-list');
  const emptyState = document.getElementById('empty-state');
  const countLabel = document.getElementById('trip-count-label');

  // Hero
  if (upcoming.length > 0) {
    const next = upcoming[0];
    const days = daysUntil(next.startDate);
    heroSection.innerHTML = buildHeroCard(next, days);
    heroSection.querySelector('.hero-card').addEventListener('click', () => openDetail(next.id));
  } else {
    heroSection.innerHTML = '';
  }

  // Trip list (upcoming, sorted)
  tripList.innerHTML = '';
  if (upcoming.length === 0) {
    emptyState.classList.remove('hidden');
    countLabel.textContent = '';
  } else {
    emptyState.classList.add('hidden');
    countLabel.textContent = `${upcoming.length} Reise${upcoming.length !== 1 ? 'n' : ''}`;
    upcoming.forEach(t => {
      const card = buildTripCard(t);
      tripList.appendChild(card);
    });
  }
}

function buildHeroCard(trip, days) {
  const bg = trip.image
    ? `background-image:url(${trip.image})`
    : `background:${getGradient(trip)}`;

  const daysText = days === 0 ? 'Heute!' : days === 1 ? '1' : days;
  const unit = days === 0 ? '' : days === 1 ? '<span class="unit">Tag</span>' : '<span class="unit">Tage</span>';

  return `
  <div class="hero-card">
    <div class="hero-bg" style="${bg}"></div>
    <div class="hero-overlay"></div>
    <div class="hero-emoji">${trip.emoji || '✈️'}</div>
    <div class="hero-content">
      <div class="hero-badge">Nächste Reise</div>
      <div class="hero-days">${daysText}${unit}</div>
      <div class="hero-dest">
        <svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        ${escHtml(trip.destination)} · ${formatDate(trip.startDate)}
      </div>
    </div>
  </div>`;
}

function buildTripCard(trip) {
  const days = daysUntil(trip.startDate);
  const bg = trip.image
    ? `background-image:url(${trip.image});background-size:cover;background-position:center`
    : `background:${getGradient(trip)}`;

  let pillClass = 'countdown-pill';
  let pillText = '';
  if (days < 0)        { pillClass += ' past'; pillText = 'Vergangen'; }
  else if (days === 0) { pillClass += ' soon'; pillText = 'Heute! 🎉'; }
  else if (days <= 14) { pillClass += ' soon'; pillText = `${days} Tag${days !== 1 ? 'e' : ''}`; }
  else                 { pillText = `${days} Tage`; }

  const prog = waitProgress(trip);

  const div = document.createElement('div');
  div.className = 'trip-card';
  div.dataset.id = trip.id;
  div.innerHTML = `
    <div class="trip-thumb">
      <div class="trip-thumb-inner" style="${bg}">${trip.image ? '' : (trip.emoji || '✈️')}</div>
    </div>
    <div class="trip-info">
      <div>
        <div class="trip-name">${escHtml(trip.destination)}</div>
        <div class="trip-date">${formatDate(trip.startDate)}${trip.endDate ? ' – ' + formatDate(trip.endDate) : ''}</div>
      </div>
      <div class="trip-bottom">
        <div class="${pillClass}">${pillText}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${prog}%"></div></div>
      </div>
    </div>`;
  div.addEventListener('click', () => openDetail(trip.id));
  return div;
}

// ── Render: Archive ──
function renderArchive() {
  const past = trips
    .filter(t => daysUntil(t.startDate) < 0)
    .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

  const list = document.getElementById('archive-list');
  const empty = document.getElementById('archive-empty');
  list.innerHTML = '';

  if (past.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    past.forEach(t => {
      const card = buildTripCard(t);
      list.appendChild(card);
    });
  }
}

// ── Detail Screen ──
function openDetail(id) {
  const trip = trips.find(t => t.id === id);
  if (!trip) return;

  const days = daysUntil(trip.startDate);
  const duration = tripDuration(trip.startDate, trip.endDate);
  const prog = waitProgress(trip);

  const bg = trip.image
    ? `background-image:url(${trip.image});background-size:cover;background-position:center`
    : `background:${getGradient(trip)}`;

  let daysLabel = '', daysUnit = '';
  if (days < 0)      { daysLabel = 'Vorbei';   daysUnit = ''; }
  else if (days === 0){ daysLabel = 'Heute!';  daysUnit = '🎉'; }
  else               { daysLabel = days;       daysUnit = 'Tage'; }

  // Build checklist HTML
  const checklist = (trip.checklist || []);
  const checklistHTML = checklist.map((item, i) => `
    <div class="checklist-item" data-idx="${i}">
      <div class="check-circle ${item.done ? 'done' : ''}" data-idx="${i}">
        ${item.done ? '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
      </div>
      <span class="check-label ${item.done ? 'done-text' : ''}">${escHtml(item.text)}</span>
    </div>`).join('');

  const notesHTML = trip.notes
    ? `<div class="notes-box" style="margin-bottom:18px;">
         <div class="section-heading" style="margin-bottom:8px;"><h3>Notizen</h3></div>
         <p>${escHtml(trip.notes)}</p>
       </div>` : '';

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <div class="detail-hero-img" style="${bg}">${trip.image ? '' : (trip.emoji || '✈️')}</div>
      <div class="detail-hero-overlay"></div>
      <button class="detail-back" id="detail-back-btn">
        <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <button class="detail-edit" id="detail-edit-btn">
        <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    </div>
    <div class="detail-scroll">
      <div style="margin-bottom:18px;">
        <div class="detail-title">${escHtml(trip.destination)}</div>
        <div class="detail-sub">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          ${formatDate(trip.startDate)}${trip.endDate ? ' – ' + formatDate(trip.endDate) : ''} · ${duration} Nacht${duration !== 1 ? 'e' : ''}
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-icon">⏳</div>
          <div class="stat-val">${daysLabel}</div>
          <div class="stat-unit">${daysUnit}</div>
        </div>
        <div class="stat-box">
          <div class="stat-icon">🌅</div>
          <div class="stat-val">${duration}</div>
          <div class="stat-unit">Reisetage</div>
        </div>
        <div class="stat-box">
          <div class="stat-icon">✅</div>
          <div class="stat-val">${checklist.filter(c=>c.done).length}/${checklist.length}</div>
          <div class="stat-unit">Aufgaben</div>
        </div>
        <div class="stat-box">
          <div class="stat-icon">${trip.emoji || '✈️'}</div>
          <div class="stat-val" style="font-size:1rem;padding-top:4px;">${prog}%</div>
          <div class="stat-unit">Wartezeit vorbei</div>
        </div>
      </div>

      ${days >= 0 ? `
      <div class="progress-section">
        <div class="progress-section-top">
          <span>Countdown-Fortschritt</span>
          <strong>${prog}% der Zeit verstrichen</strong>
        </div>
        <div class="progress-bar" style="height:8px;">
          <div class="progress-fill" style="width:${prog}%"></div>
        </div>
      </div>` : ''}

      ${notesHTML}

      <div class="section-heading"><h3>Packliste</h3></div>
      <div class="checklist" id="detail-checklist">${checklistHTML}</div>
      <div class="add-check-row">
        <input type="text" id="new-check-input" placeholder="Neue Aufgabe …" />
        <button id="btn-add-check">+ Add</button>
      </div>
    </div>`;

  // Events
  document.getElementById('detail-back-btn').addEventListener('click', () => goBack());
  document.getElementById('detail-edit-btn').addEventListener('click', () => openEdit(trip.id));

  // Checklist toggle
  document.getElementById('detail-checklist').addEventListener('click', e => {
    const circle = e.target.closest('.check-circle');
    if (!circle) return;
    const idx = parseInt(circle.dataset.idx);
    const t = trips.find(x => x.id === id);
    if (!t || !t.checklist[idx]) return;
    t.checklist[idx].done = !t.checklist[idx].done;
    saveTrips();
    openDetail(id); // re-render
  });

  // Add checklist item
  document.getElementById('btn-add-check').addEventListener('click', () => addChecklistItem(id));
  document.getElementById('new-check-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addChecklistItem(id);
  });

  showScreen('detail');
}

function addChecklistItem(tripId) {
  const input = document.getElementById('new-check-input');
  const text = input.value.trim();
  if (!text) return;
  const t = trips.find(x => x.id === tripId);
  if (!t) return;
  if (!t.checklist) t.checklist = [];
  t.checklist.push({ text, done: false });
  saveTrips();
  openDetail(tripId);
}

function goBack() {
  showScreen('home');
  renderHome();
}

// ── Add / Edit Modal ──
function openAdd() {
  currentTripId = null;
  selectedEmoji = '🏖️';
  document.getElementById('modal-title').textContent = 'Neue Reise';
  document.getElementById('input-dest').value = '';
  document.getElementById('input-start').value = '';
  document.getElementById('input-end').value = '';
  document.getElementById('input-notes').value = '';
  document.getElementById('image-preview').style.display = 'none';
  document.getElementById('image-preview-wrap').style.display = 'flex';
  document.getElementById('btn-remove-image').classList.add('hidden');
  document.getElementById('btn-delete-trip').classList.add('hidden');
  document.getElementById('form-error').classList.add('hidden');
  updateEmojiPicker();
  openModal();
}

function openEdit(id) {
  const trip = trips.find(t => t.id === id);
  if (!trip) return;
  currentTripId = id;
  selectedEmoji = trip.emoji || '🏖️';
  document.getElementById('modal-title').textContent = 'Reise bearbeiten';
  document.getElementById('input-dest').value = trip.destination;
  document.getElementById('input-start').value = trip.startDate;
  document.getElementById('input-end').value = trip.endDate || '';
  document.getElementById('input-notes').value = trip.notes || '';
  document.getElementById('btn-delete-trip').classList.remove('hidden');
  document.getElementById('form-error').classList.add('hidden');

  if (trip.image) {
    document.getElementById('image-preview').src = trip.image;
    document.getElementById('image-preview').style.display = 'block';
    document.getElementById('image-preview-wrap').style.display = 'none';
    document.getElementById('btn-remove-image').classList.remove('hidden');
  } else {
    document.getElementById('image-preview').style.display = 'none';
    document.getElementById('image-preview-wrap').style.display = 'flex';
    document.getElementById('btn-remove-image').classList.add('hidden');
  }

  updateEmojiPicker();
  openModal();
}

function openModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('show'));
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('show');
  setTimeout(() => overlay.classList.add('hidden'), 300);
}

function saveTrip() {
  const dest  = document.getElementById('input-dest').value.trim();
  const start = document.getElementById('input-start').value;
  const end   = document.getElementById('input-end').value;
  const notes = document.getElementById('input-notes').value.trim();
  const imgEl = document.getElementById('image-preview');
  const image = imgEl.style.display !== 'none' ? imgEl.src : null;

  const errEl = document.getElementById('form-error');
  if (!dest) { showFormError('Bitte gib ein Reiseziel ein.'); return; }
  if (!start) { showFormError('Bitte wähle ein Abreisedatum.'); return; }
  if (end && end < start) { showFormError('Rückkehr kann nicht vor der Abreise liegen.'); return; }
  errEl.classList.add('hidden');

  if (currentTripId) {
    // Edit
    const t = trips.find(x => x.id === currentTripId);
    t.destination = dest;
    t.startDate   = start;
    t.endDate     = end || null;
    t.notes       = notes;
    t.emoji       = selectedEmoji;
    if (image) t.image = image;
    else if (!image && imgEl.style.display === 'none') t.image = null;
  } else {
    // New
    trips.push({
      id: generateId(),
      destination: dest,
      startDate: start,
      endDate: end || null,
      notes,
      emoji: selectedEmoji,
      image: image || null,
      checklist: [],
      createdAt: new Date().toISOString(),
      gradientIndex: Math.floor(Math.random() * GRADIENTS.length),
    });
  }

  saveTrips();
  renderHome();
  renderArchive();
  closeModal();
  showToast(currentTripId ? '✏️ Reise aktualisiert!' : '✈️ Reise gespeichert!');
}

function deleteTrip() {
  if (!currentTripId) return;
  if (!confirm('Diese Reise wirklich löschen?')) return;
  trips = trips.filter(t => t.id !== currentTripId);
  saveTrips();
  renderHome();
  renderArchive();
  closeModal();
  showToast('🗑️ Reise gelöscht');
}

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Emoji picker ──
function updateEmojiPicker() {
  document.querySelectorAll('.emoji-opt').forEach(el => {
    el.classList.toggle('selected', el.dataset.emoji === selectedEmoji);
  });
}

// ── Image upload ──
function handleImageUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('image-preview').src = e.target.result;
    document.getElementById('image-preview').style.display = 'block';
    document.getElementById('image-preview-wrap').style.display = 'none';
    document.getElementById('btn-remove-image').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

// ── Screen navigation ──
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  if (target) { target.classList.add('active'); }
}

// ── Toast ──
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 300);
  }, 2200);
}

// ── Escape HTML ──
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Bind all events ──
function bindEvents() {
  // Add buttons
  document.getElementById('btn-open-add').addEventListener('click', openAdd);
  document.getElementById('btn-empty-add').addEventListener('click', openAdd);
  document.getElementById('btn-nav-add').addEventListener('click', openAdd);
  document.getElementById('btn-nav-add-map')?.addEventListener('click', openAdd);
  document.getElementById('btn-nav-add-archive')?.addEventListener('click', openAdd);

  // Modal
  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.getElementById('btn-save-trip').addEventListener('click', saveTrip);
  document.getElementById('btn-delete-trip').addEventListener('click', deleteTrip);

  // Emoji picker
  document.getElementById('emoji-picker').addEventListener('click', e => {
    const opt = e.target.closest('.emoji-opt');
    if (!opt) return;
    selectedEmoji = opt.dataset.emoji;
    updateEmojiPicker();
  });

  // Image upload
  const uploadArea = document.getElementById('image-upload-area');
  const imageInput = document.getElementById('image-input');
  uploadArea.addEventListener('click', e => {
    if (e.target.id === 'btn-remove-image') return;
    imageInput.click();
  });
  imageInput.addEventListener('change', e => handleImageUpload(e.target.files[0]));
  document.getElementById('btn-remove-image').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('image-preview').style.display = 'none';
    document.getElementById('image-preview-wrap').style.display = 'flex';
    document.getElementById('btn-remove-image').classList.add('hidden');
    imageInput.value = '';
  });

  // Nav
  document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = btn.dataset.screen;
      showScreen(s);
    });
  });

  // Settings
  document.getElementById('btn-clear-data').addEventListener('click', () => {
    if (confirm('Alle Reisen unwiderruflich löschen?')) {
      trips = [];
      saveTrips();
      renderHome();
      renderArchive();
      showToast('🗑️ Alle Daten gelöscht');
    }
  });
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(trips, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tripcount-backup.json';
    a.click(); URL.revokeObjectURL(url);
    showToast('📤 Export erfolgreich!');
  });
}
