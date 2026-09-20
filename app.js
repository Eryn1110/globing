/* Globing — offline itinerary planner
   All data lives in localStorage on this device/browser only.
   Nothing is sent anywhere. Use Export to back up or move devices. */

const STORAGE_KEY = 'globing-state-v1';

const TIME_SLOTS = (() => {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
})();

// ---------- State ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { trips: [], activeTripId: null };
    const parsed = JSON.parse(raw);
    if (!parsed.trips) return { trips: [], activeTripId: null };
    return parsed;
  } catch (e) {
    console.error('Failed to load state', e);
    return { trips: [], activeTripId: null };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state', e);
    alert('Could not save — your device storage may be full.');
  }
}

let state = loadState();
let activeDayDate = null; // date string currently shown in day view

// ---------- Helpers ----------

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function parseDateLocal(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateShort(dateStr) {
  const d = parseDateLocal(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDateHeading(dateStr) {
  const d = parseDateLocal(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function dayOfWeekShort(dateStr) {
  const d = parseDateLocal(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function getDaysArray(startStr, endStr) {
  const days = [];
  let cur = parseDateLocal(startStr);
  const end = parseDateLocal(endStr);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function getTrip(id) {
  return state.trips.find(t => t.id === id);
}

function ensureDay(trip, dateStr) {
  if (!trip.days[dateStr]) {
    trip.days[dateStr] = { notes: '', slots: {} };
  }
  return trip.days[dateStr];
}

// ---------- Attachments (ticket photos/PDFs, stored in IndexedDB) ----------
// Kept separate from localStorage because photos are much bigger than the
// JSON state blob, which gets rewritten on every keystroke elsewhere.

const ATTACH_DB_NAME = 'globing-files';
const ATTACH_STORE = 'attachments';
let attachDbPromise = null;

function openAttachDb() {
  if (attachDbPromise) return attachDbPromise;
  attachDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(ATTACH_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(ATTACH_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return attachDbPromise;
}

async function saveAttachment(key, name, type, dataUrl) {
  const db = await openAttachDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACH_STORE, 'readwrite');
    tx.objectStore(ATTACH_STORE).put({ key, name, type, dataUrl });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAttachment(key) {
  const db = await openAttachDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACH_STORE, 'readonly');
    const req = tx.objectStore(ATTACH_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteAttachment(key) {
  const db = await openAttachDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACH_STORE, 'readwrite');
    tx.objectStore(ATTACH_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Returns { key: {name, type} } for every stored attachment whose key starts with prefix.
async function getAttachmentsByPrefix(prefix) {
  const db = await openAttachDb();
  return new Promise((resolve, reject) => {
    const out = {};
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
    const tx = db.transaction(ATTACH_STORE, 'readonly');
    const req = tx.objectStore(ATTACH_STORE).openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out[cursor.value.key] = { name: cursor.value.name, type: cursor.value.type };
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Downscales photos so ticket snapshots don't balloon storage; PDFs pass through as-is.
async function processAttachmentFile(file) {
  if (!file.type.startsWith('image/')) {
    return fileToDataUrl(file);
  }
  const rawUrl = await fileToDataUrl(file);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = rawUrl;
  });
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (scale >= 1) return rawUrl;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

// Shared hidden <input type="file">, reused for every attach button so we don't
// create dozens of file inputs across a 48-slot day grid.
const attachFileInput = document.getElementById('attach-file-input');
let pendingAttachKey = null;
let onAttachSaved = null; // callback(key) run after a file is stored

function requestAttach(key, onSaved) {
  pendingAttachKey = key;
  onAttachSaved = onSaved;
  attachFileInput.value = '';
  attachFileInput.click();
}

attachFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const key = pendingAttachKey;
  const callback = onAttachSaved;
  pendingAttachKey = null;
  onAttachSaved = null;
  if (!file || !key) return;
  try {
    const dataUrl = await processAttachmentFile(file);
    await saveAttachment(key, file.name, file.type, dataUrl);
    if (callback) callback(key);
  } catch (err) {
    console.error('Attachment save failed', err);
    alert('Could not save that file.');
  }
});

function openAttachment(key) {
  getAttachment(key).then(record => {
    if (!record) return;
    const win = window.open();
    if (win) {
      win.document.write(
        record.type === 'application/pdf'
          ? `<iframe src="${record.dataUrl}" style="border:0;width:100%;height:100vh;"></iframe>`
          : `<img src="${record.dataUrl}" style="max-width:100%;display:block;margin:0 auto;">`
      );
    }
  });
}

// ---------- Elements ----------

const viewTrips = document.getElementById('view-trips');
const viewNewTrip = document.getElementById('view-new-trip');
const viewTrip = document.getElementById('view-trip');
const tripListEl = document.getElementById('trip-list');
const emptyStateEl = document.getElementById('empty-state');
const formNewTrip = document.getElementById('form-new-trip');

const tripTitleEl = document.getElementById('trip-title');
const tripDatesEl = document.getElementById('trip-dates');
const dayTabsEl = document.getElementById('day-tabs');
const dayViewEl = document.getElementById('day-view');
const tripDrawer = document.getElementById('trip-drawer');

function showView(view) {
  [viewTrips, viewNewTrip, viewTrip].forEach(v => { v.hidden = (v !== view); });
}

// ---------- Render: Trip list ----------

function renderTripList() {
  tripListEl.innerHTML = '';
  const sorted = [...state.trips].sort((a, b) => a.startDate.localeCompare(b.startDate));
  emptyStateEl.hidden = sorted.length > 0;

  sorted.forEach(trip => {
    const card = document.createElement('div');
    card.className = 'trip-card';

    const info = document.createElement('div');
    info.innerHTML = `
      <p class="trip-card-name">${escapeHtml(trip.name)}</p>
      <p class="trip-card-meta">${formatDateShort(trip.startDate)} – ${formatDateShort(trip.endDate)} · ${getDaysArray(trip.startDate, trip.endDate).length} days${trip.destinations.length ? ' · ' + trip.destinations.map(escapeHtml).join(', ') : ''}</p>
    `;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'trip-card-delete';
    deleteBtn.setAttribute('aria-label', `Delete ${trip.name}`);
    deleteBtn.textContent = '🗑';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTrip(trip.id);
    });

    const arrow = document.createElement('span');
    arrow.className = 'trip-card-arrow';
    arrow.textContent = '›';

    card.appendChild(info);
    card.appendChild(deleteBtn);
    card.appendChild(arrow);
    card.addEventListener('click', () => openTrip(trip.id));
    tripListEl.appendChild(card);
  });
}

function deleteTrip(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  if (!confirm(`Delete "${trip.name}" and everything in it? This can't be undone.`)) return;
  state.trips = state.trips.filter(t => t.id !== tripId);
  if (state.activeTripId === tripId) state.activeTripId = null;
  saveState();
  renderTripList();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Create-trip page ----------

document.getElementById('btn-new-trip').addEventListener('click', () => {
  formNewTrip.reset();
  showView(viewNewTrip);
  document.getElementById('input-trip-name').focus();
});

document.getElementById('btn-cancel-new-trip').addEventListener('click', () => {
  showView(viewTrips);
});

formNewTrip.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('input-trip-name').value.trim();
  const start = document.getElementById('input-trip-start').value;
  const end = document.getElementById('input-trip-end').value;
  if (!name || !start || !end) return;
  if (end < start) {
    alert('Return date is before the departure date.');
    return;
  }
  const trip = {
    id: uid(),
    name,
    startDate: start,
    endDate: end,
    destinations: [],
    tickets: [],
    days: {}
  };
  getDaysArray(start, end).forEach(d => ensureDay(trip, d));
  state.trips.push(trip);
  saveState();
  formNewTrip.reset();
  renderTripList();
  openTrip(trip.id);
});

// ---------- Open / navigate ----------

function openTrip(tripId) {
  state.activeTripId = tripId;
  saveState();
  const trip = getTrip(tripId);
  if (!trip) return;
  activeDayDate = trip.startDate;
  showView(viewTrip);
  tripDrawer.hidden = true;
  renderTripDetail(trip);
}

document.getElementById('btn-back').addEventListener('click', () => {
  showView(viewTrips);
  renderTripList();
});

document.getElementById('btn-trip-menu').addEventListener('click', () => {
  tripDrawer.hidden = !tripDrawer.hidden;
});

document.getElementById('btn-quick-new-trip').addEventListener('click', () => {
  formNewTrip.reset();
  showView(viewNewTrip);
  document.getElementById('input-trip-name').focus();
});

// ---------- Render: Trip detail ----------

function renderTripDetail(trip) {
  tripTitleEl.textContent = trip.name;
  tripDatesEl.textContent = `${formatDateShort(trip.startDate)} – ${formatDateShort(trip.endDate)}`;
  renderDrawer(trip);
  renderDayTabs(trip);
  renderDayView(trip, activeDayDate);
}

// ---------- Drawer: settings ----------

function renderDrawer(trip) {
  document.getElementById('edit-trip-name').value = trip.name;
  document.getElementById('edit-trip-start').value = trip.startDate;
  document.getElementById('edit-trip-end').value = trip.endDate;

  const chipRow = document.getElementById('destination-chips');
  chipRow.innerHTML = '';
  trip.destinations.forEach((dest, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(dest)} <button aria-label="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      trip.destinations.splice(i, 1);
      saveState();
      renderDrawer(trip);
      renderTripDetail(trip);
    });
    chipRow.appendChild(chip);
  });

  const ticketList = document.getElementById('ticket-list');
  ticketList.innerHTML = '';
  trip.tickets.forEach((tk, i) => {
    const attachKey = `ticket-${tk.id}`;
    const row = document.createElement('div');
    row.className = 'ticket-row';

    const text = document.createElement('div');
    text.className = 'ticket-row-text';
    text.innerHTML = `
      <div class="ticket-row-label">${escapeHtml(tk.label)}</div>
      ${tk.detail ? `<div class="ticket-row-detail">${escapeHtml(tk.detail)}</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'ticket-row-actions';
    actions.appendChild(buildAttachControl(attachKey));

    const removeBtn = document.createElement('button');
    removeBtn.setAttribute('aria-label', 'Remove ticket');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      trip.tickets.splice(i, 1);
      deleteAttachment(attachKey).catch(() => {});
      saveState();
      renderDrawer(trip);
    });
    actions.appendChild(removeBtn);

    row.appendChild(text);
    row.appendChild(actions);
    ticketList.appendChild(row);
  });
}

// Builds a small "attach ticket file" control: shows a 📎 button when empty,
// or a filename chip (tap to view, × to remove) once a file is stored.
// Renders synchronously in its empty state, then upgrades itself once the
// IndexedDB lookup resolves.
function buildAttachControl(key) {
  const wrap = document.createElement('span');
  wrap.className = 'attach-control';

  function renderEmpty() {
    wrap.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'attach-btn';
    btn.type = 'button';
    btn.textContent = '📎';
    btn.title = 'Attach ticket file';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      requestAttach(key, () => renderFilled());
    });
    wrap.appendChild(btn);
  }

  function renderFilled(nameOverride) {
    getAttachment(key).then(record => {
      if (!record) { renderEmpty(); return; }
      wrap.innerHTML = '';
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `<span>📎 ${escapeHtml(record.name)}</span>`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openAttachment(key);
      });
      const removeBtn = document.createElement('button');
      removeBtn.className = 'attach-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove attachment';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAttachment(key).then(renderEmpty);
      });
      chip.appendChild(removeBtn);
      wrap.appendChild(chip);
    });
  }

  getAttachment(key).then(record => {
    if (record) renderFilled();
  });
  renderEmpty();
  return wrap;
}

document.getElementById('edit-trip-name').addEventListener('change', (e) => {
  const trip = getTrip(state.activeTripId);
  trip.name = e.target.value.trim() || trip.name;
  saveState();
  renderTripDetail(trip);
});

document.getElementById('edit-trip-start').addEventListener('change', (e) => {
  updateTripDates(e.target.value, null);
});
document.getElementById('edit-trip-end').addEventListener('change', (e) => {
  updateTripDates(null, e.target.value);
});

function updateTripDates(newStart, newEnd) {
  const trip = getTrip(state.activeTripId);
  const start = newStart || trip.startDate;
  const end = newEnd || trip.endDate;
  if (end < start) {
    alert('Return date is before the departure date.');
    renderDrawer(trip);
    return;
  }
  trip.startDate = start;
  trip.endDate = end;
  getDaysArray(start, end).forEach(d => ensureDay(trip, d));
  saveState();
  if (!trip.days[activeDayDate]) activeDayDate = start;
  renderTripDetail(trip);
}

document.getElementById('btn-add-destination').addEventListener('click', () => {
  const input = document.getElementById('input-destination');
  const val = input.value.trim();
  if (!val) return;
  const trip = getTrip(state.activeTripId);
  trip.destinations.push(val);
  saveState();
  input.value = '';
  renderDrawer(trip);
  renderTripDetail(trip);
});
document.getElementById('input-destination').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-add-destination').click(); }
});

document.getElementById('btn-add-ticket').addEventListener('click', () => {
  const labelInput = document.getElementById('input-ticket-label');
  const detailInput = document.getElementById('input-ticket-detail');
  const label = labelInput.value.trim();
  if (!label) return;
  const trip = getTrip(state.activeTripId);
  trip.tickets.push({ id: uid(), label, detail: detailInput.value.trim() });
  saveState();
  labelInput.value = '';
  detailInput.value = '';
  renderDrawer(trip);
});

document.getElementById('btn-delete-trip').addEventListener('click', () => {
  const trip = getTrip(state.activeTripId);
  if (!trip) return;
  if (!confirm(`Delete "${trip.name}" and everything in it? This can't be undone.`)) return;
  state.trips = state.trips.filter(t => t.id !== trip.id);
  state.activeTripId = null;
  saveState();
  showView(viewTrips);
  renderTripList();
});

// ---------- Day tabs ----------

function renderDayTabs(trip) {
  dayTabsEl.innerHTML = '';
  const days = getDaysArray(trip.startDate, trip.endDate);
  days.forEach((dateStr, i) => {
    const tab = document.createElement('div');
    tab.className = 'day-tab' + (dateStr === activeDayDate ? ' active' : '');
    tab.innerHTML = `<span class="day-tab-num">${i + 1}</span><span class="day-tab-dow">${dayOfWeekShort(dateStr)} ${formatDateShort(dateStr).split(' ')[1]}</span>`;
    tab.addEventListener('click', () => {
      activeDayDate = dateStr;
      renderDayTabs(trip);
      renderDayView(trip, dateStr);
    });
    dayTabsEl.appendChild(tab);
  });
}

// ---------- Day view: notes + 30-min slot grid ----------

function renderDayView(trip, dateStr) {
  const day = ensureDay(trip, dateStr);
  dayViewEl.innerHTML = '';

  const heading = document.createElement('p');
  heading.className = 'day-date-heading';
  heading.textContent = formatDateHeading(dateStr);
  dayViewEl.appendChild(heading);

  const notesBlock = document.createElement('div');
  notesBlock.className = 'notes-block';
  notesBlock.innerHTML = `<label for="notes-${dateStr}">Notes for the day</label>`;
  const notesArea = document.createElement('textarea');
  notesArea.id = `notes-${dateStr}`;
  notesArea.placeholder = 'Reservations to confirm, packing reminders, backup plans…';
  notesArea.value = day.notes || '';
  notesArea.addEventListener('input', debounce(() => {
    day.notes = notesArea.value;
    saveState();
  }, 300));
  notesBlock.appendChild(notesArea);
  dayViewEl.appendChild(notesBlock);

  const grid = document.createElement('div');
  grid.className = 'slot-grid';

  TIME_SLOTS.forEach(time => {
    const row = document.createElement('div');
    const isHourStart = time.endsWith(':00');
    row.className = 'slot-row' + (isHourStart ? ' hour-start' : '');

    const slotData = day.slots[time] || { title: '', ticket: '' };
    if (slotData.title || slotData.ticket) row.classList.add('filled');

    const timeEl = document.createElement('div');
    timeEl.className = 'slot-time';
    timeEl.textContent = isHourStart ? formatHourLabel(time) : '';

    const fields = document.createElement('div');
    fields.className = 'slot-fields';

    const attractionInput = document.createElement('input');
    attractionInput.type = 'text';
    attractionInput.className = 'slot-input-attraction';
    attractionInput.placeholder = 'Add attraction / plan';
    attractionInput.value = slotData.title || '';

    const ticketInput = document.createElement('input');
    ticketInput.type = 'text';
    ticketInput.className = 'slot-input-ticket';
    ticketInput.placeholder = 'Ticket / booking ref';
    ticketInput.value = slotData.ticket || '';

    const commit = debounce(() => {
      const title = attractionInput.value.trim();
      const ticket = ticketInput.value.trim();
      if (!title && !ticket) {
        delete day.slots[time];
        row.classList.remove('filled');
      } else {
        day.slots[time] = { title, ticket };
        row.classList.add('filled');
      }
      saveState();
    }, 300);

    attractionInput.addEventListener('input', commit);
    ticketInput.addEventListener('input', commit);

    const ticketRow = document.createElement('div');
    ticketRow.className = 'slot-ticket-row';
    ticketRow.appendChild(ticketInput);
    ticketRow.appendChild(buildAttachControl(`slot-${trip.id}-${dateStr}-${time}`));

    fields.appendChild(attractionInput);
    fields.appendChild(ticketRow);

    row.appendChild(timeEl);
    row.appendChild(fields);
    grid.appendChild(row);
  });

  dayViewEl.appendChild(grid);
}

function formatHourLabel(time) {
  const [h] = time.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}${period}`;
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// ---------- Export / Import ----------

document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `globing-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported.trips) throw new Error('Not a Globing backup file');
      const merge = confirm('Add these trips to your current list? Cancel to replace everything instead.');
      if (merge) {
        const existingIds = new Set(state.trips.map(t => t.id));
        imported.trips.forEach(t => {
          if (existingIds.has(t.id)) t.id = uid();
          state.trips.push(t);
        });
      } else {
        state = imported;
      }
      saveState();
      renderTripList();
      alert('Import complete.');
    } catch (err) {
      alert('Could not read that file — is it a Globing backup?');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------- Service worker (offline) ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline caching is a bonus, not required for the app to work */
    });
  });
}

// ---------- Init ----------

renderTripList();
if (state.activeTripId && getTrip(state.activeTripId)) {
  openTrip(state.activeTripId);
}
