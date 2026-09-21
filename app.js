/* Globing — offline itinerary planner
   All data lives in localStorage on this device/browser only.
   Nothing is sent anywhere. Use Export to back up or move devices. */

const STORAGE_KEY = 'globing-state-v1';

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
    trip.days[dateStr] = { notes: '', activities: [], completed: false };
  }
  if (!trip.days[dateStr].activities) {
    trip.days[dateStr].activities = [];
  }
  if (typeof trip.days[dateStr].completed !== 'boolean') {
    trip.days[dateStr].completed = false;
  }
  return trip.days[dateStr];
}

// One-time upgrade for trips created before the switch from a fixed
// 30-minute grid to an add-activities-as-you-go list. Turns any leftover
// day.slots entries into day.activities, carrying attachments across too.
async function migrateLegacyDays() {
  let changed = false;
  for (const trip of state.trips) {
    for (const dateStr in trip.days) {
      const day = trip.days[dateStr];
      if (day.slots) {
        day.activities = day.activities || [];
        for (const time in day.slots) {
          const slot = day.slots[time];
          if (!slot || (!slot.title && !slot.ticket)) continue;
          const newId = uid();
          day.activities.push({ id: newId, time, title: slot.title || '', ticket: slot.ticket || '', cost: '' });
          const oldKey = `slot-${trip.id}-${dateStr}-${time}`;
          const newKey = `activity-${trip.id}-${dateStr}-${newId}`;
          try {
            const record = await getAttachment(oldKey);
            if (record) {
              await saveAttachment(newKey, record.name, record.type, record.dataUrl);
              await deleteAttachment(oldKey);
            }
          } catch (e) { /* no attachment for that slot — fine */ }
        }
        delete day.slots;
        changed = true;
      }
    }
  }
  if (changed) saveState();
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
    const day = ensureDay(trip, dateStr);
    const tab = document.createElement('div');
    tab.className = 'day-tab' + (dateStr === activeDayDate ? ' active' : '') + (day.completed ? ' completed' : '');
    tab.innerHTML = `
      ${day.completed ? '<span class="day-tab-check">✓</span>' : ''}
      <span class="day-tab-num">${i + 1}</span>
      <span class="day-tab-dow">${dayOfWeekShort(dateStr)} ${formatDateShort(dateStr).split(' ')[1]}</span>
    `;
    tab.addEventListener('click', () => {
      activeDayDate = dateStr;
      renderDayTabs(trip);
      renderDayView(trip, dateStr);
    });
    dayTabsEl.appendChild(tab);
  });
}

// ---------- Day view: notes + activity list (add one at a time) ----------

function renderDayView(trip, dateStr) {
  const day = ensureDay(trip, dateStr);
  dayViewEl.innerHTML = '';

  const headingRow = document.createElement('div');
  headingRow.className = 'day-heading-row';

  const heading = document.createElement('p');
  heading.className = 'day-date-heading';
  heading.textContent = formatDateHeading(dateStr);

  const doneToggle = document.createElement('button');
  doneToggle.type = 'button';
  doneToggle.className = 'day-done-toggle' + (day.completed ? ' done' : '');
  doneToggle.textContent = day.completed ? '✓ Day done' : 'Mark day done';
  doneToggle.addEventListener('click', () => {
    day.completed = !day.completed;
    saveState();
    renderDayView(trip, dateStr);
    renderDayTabs(trip);
  });

  headingRow.appendChild(heading);
  headingRow.appendChild(doneToggle);
  dayViewEl.appendChild(headingRow);

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

  const list = document.createElement('div');
  list.className = 'activity-list';

  const sorted = [...day.activities].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  if (sorted.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Nothing planned yet — add the first activity below.';
    list.appendChild(empty);
  }

  sorted.forEach(activity => {
    list.appendChild(buildActivityRow(trip, dateStr, day, activity));
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-add-activity';
  addBtn.textContent = '+ Add activity';
  addBtn.addEventListener('click', () => {
    const lastTime = sorted.length ? sorted[sorted.length - 1].time : '09:00';
    const newActivity = { id: uid(), time: lastTime, title: '', ticket: '', cost: '' };
    day.activities.push(newActivity);
    saveState();
    renderDayView(trip, dateStr);
    // Focus the newly added row's title field.
    const row = dayViewEl.querySelector(`[data-activity-id="${newActivity.id}"] .activity-title`);
    if (row) row.focus();
  });
  list.appendChild(addBtn);

  dayViewEl.appendChild(list);
}

function buildActivityRow(trip, dateStr, day, activity) {
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.dataset.activityId = activity.id;

  const timeCol = document.createElement('div');
  timeCol.className = 'activity-time-col';
  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'activity-time-input';
  timeInput.value = activity.time || '09:00';
  timeInput.addEventListener('change', () => {
    activity.time = timeInput.value;
    saveState();
    renderDayView(trip, dateStr); // re-sort into chronological order
  });
  timeCol.appendChild(timeInput);

  const body = document.createElement('div');
  body.className = 'activity-body';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'activity-title';
  titleInput.placeholder = 'What are you doing? e.g. Heading to Pearson';
  titleInput.value = activity.title || '';

  const ticketInput = document.createElement('input');
  ticketInput.type = 'text';
  ticketInput.className = 'activity-ticket';
  ticketInput.placeholder = 'Ticket / booking ref';
  ticketInput.value = activity.ticket || '';

  const costInput = document.createElement('input');
  costInput.type = 'text';
  costInput.className = 'activity-cost';
  costInput.placeholder = 'Cost, e.g. Ivan, 36 CAD';
  costInput.value = activity.cost || '';

  const commitText = debounce(() => {
    activity.title = titleInput.value.trim();
    activity.ticket = ticketInput.value.trim();
    activity.cost = costInput.value.trim();
    saveState();
  }, 300);
  titleInput.addEventListener('input', commitText);
  ticketInput.addEventListener('input', commitText);
  costInput.addEventListener('input', commitText);

  const ticketRow = document.createElement('div');
  ticketRow.className = 'activity-ticket-row';
  ticketRow.appendChild(ticketInput);
  ticketRow.appendChild(costInput);
  ticketRow.appendChild(buildAttachControl(`activity-${trip.id}-${dateStr}-${activity.id}`));

  body.appendChild(titleInput);
  body.appendChild(ticketRow);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'activity-delete';
  deleteBtn.setAttribute('aria-label', 'Remove activity');
  deleteBtn.textContent = '🗑';
  deleteBtn.addEventListener('click', () => {
    day.activities = day.activities.filter(a => a.id !== activity.id);
    deleteAttachment(`activity-${trip.id}-${dateStr}-${activity.id}`).catch(() => {});
    saveState();
    renderDayView(trip, dateStr);
  });

  row.appendChild(timeCol);
  row.appendChild(body);
  row.appendChild(deleteBtn);
  return row;
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

// Upgrade any trips saved under the old fixed time-grid format, then
// re-render whichever page is showing so the converted data appears.
migrateLegacyDays().then(() => {
  renderTripList();
  if (state.activeTripId && getTrip(state.activeTripId)) {
    renderTripDetail(getTrip(state.activeTripId));
  }
});
