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

// Saves locally, and — only if this trip has sharing turned on — also
// pushes the change up to Firestore so anyone else viewing the trip sees it.
function commitTripChange(trip) {
  saveState();
  if (trip && trip.shared && trip.shareCode && typeof CloudSync !== 'undefined' && CloudSync.configured) {
    CloudSync.pushTrip(trip);
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
  const day = trip.days[dateStr];
  if (!day.activities) {
    day.activities = [];
  }
  if (typeof day.completed !== 'boolean') {
    day.completed = false;
  }
  // Upgrade from the old single freeform "cost" text field to a repeatable
  // list of structured {payer, amount, currency} payments. The old text
  // (e.g. "Ivan, 36 CAD") becomes a single payment with that text as the
  // payer name, so nothing is silently lost — just left for manual tidy-up.
  day.activities.forEach(activity => {
    if (!activity.payments) {
      activity.payments = [];
      if (activity.cost && activity.cost.trim()) {
        activity.payments.push({ id: uid(), payer: activity.cost.trim(), amount: '', currency: '' });
      }
      delete activity.cost;
    }
    if (!activity.todos) {
      activity.todos = [];
    }
  });
  return day;
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
          day.activities.push({ id: newId, time, title: slot.title || '', ticket: slot.ticket || '', payments: [] });
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

// One-time upgrade from "one attachment per activity" (a single fixed
// IndexedDB key) to "multiple ticket files per activity" (a list of
// attachment ids, each with its own key). Any attachment found under the
// old key gets moved to the new scheme so nothing is lost.
async function migrateLegacyAttachments() {
  let changed = false;
  for (const trip of state.trips) {
    for (const dateStr in trip.days) {
      const day = trip.days[dateStr];
      for (const activity of (day.activities || [])) {
        if (activity.attachmentIds) continue; // already on the new scheme
        activity.attachmentIds = [];
        const oldKey = `activity-${trip.id}-${dateStr}-${activity.id}`;
        try {
          const record = await getAttachment(oldKey);
          if (record) {
            const newAttId = uid();
            const newKey = `${oldKey}-${newAttId}`;
            await saveAttachment(newKey, record.name, record.type, record.dataUrl);
            await deleteAttachment(oldKey);
            activity.attachmentIds.push(newAttId);
          }
        } catch (e) { /* no legacy attachment for that activity — fine */ }
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
const viewJoinTrip = document.getElementById('view-join-trip');
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
  [viewTrips, viewNewTrip, viewJoinTrip, viewTrip].forEach(v => { v.hidden = (v !== view); });
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
      <p class="trip-card-name">${escapeHtml(trip.name)}${trip.shared ? ' <span class="shared-badge">🔗 Shared</span>' : ''}</p>
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
    days: {},
    shared: false,
    shareCode: null
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
  if (!tripDrawer.hidden) {
    const trip = getTrip(state.activeTripId);
    if (trip) renderDrawer(trip); // refresh so the expense summary is never stale
  }
});

document.getElementById('btn-quick-new-trip').addEventListener('click', () => {
  formNewTrip.reset();
  showView(viewNewTrip);
  document.getElementById('input-trip-name').focus();
});

// ---------- Join a shared trip ----------

const formJoinTrip = document.getElementById('form-join-trip');

document.getElementById('btn-join-trip').addEventListener('click', () => {
  formJoinTrip.reset();
  document.getElementById('join-trip-hint').textContent = '';
  showView(viewJoinTrip);
  document.getElementById('input-join-code').focus();
});

document.getElementById('btn-cancel-join-trip').addEventListener('click', () => {
  showView(viewTrips);
});

formJoinTrip.addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = document.getElementById('join-trip-hint');
  const codeInput = document.getElementById('input-join-code');
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;

  if (typeof CloudSync === 'undefined' || !CloudSync.configured) {
    hint.textContent = 'Cloud sharing isn\u2019t set up for this deployment yet.';
    return;
  }

  hint.textContent = 'Looking for that trip…';
  try {
    const remote = await CloudSync.fetchTripOnce(code);
    if (!remote) {
      hint.textContent = 'No trip found with that code — double-check and try again.';
      return;
    }
    const localId = uid();
    const trip = Object.assign({}, remote, { id: localId, shared: true, shareCode: code });
    if (!trip.days) trip.days = {};
    getDaysArray(trip.startDate, trip.endDate).forEach(d => ensureDay(trip, d));
    state.trips.push(trip);
    saveState();
    subscribeSharedTrip(trip);
    showView(viewTrips);
    renderTripList();
    openTrip(localId);
  } catch (err) {
    console.error(err);
    hint.textContent = 'Something went wrong joining that trip.';
  }
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
      commitTripChange(trip);
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
      commitTripChange(trip);
      renderDrawer(trip);
    });
    actions.appendChild(removeBtn);

    row.appendChild(text);
    row.appendChild(actions);
    ticketList.appendChild(row);
  });

  renderExpenseSummary(trip);
  renderSharingPanel(trip);
}

// Builds the Sharing section of the drawer: "Share this trip" when not yet
// shared, or the code + copy/stop controls once it is. Does nothing (shows a
// note instead) if no Firebase config has been set up for this deployment.
function renderSharingPanel(trip) {
  const panel = document.getElementById('sharing-panel');
  panel.innerHTML = '';

  if (typeof CloudSync === 'undefined' || !CloudSync.configured) {
    const p = document.createElement('p');
    p.className = 'drawer-hint';
    p.textContent = 'Cloud sharing isn\u2019t set up for this deployment yet — see the README for how to add it.';
    panel.appendChild(p);
    return;
  }

  if (!trip.shared) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = 'Share this trip';
    btn.addEventListener('click', () => {
      trip.shared = true;
      trip.shareCode = CloudSync.generateCode();
      commitTripChange(trip);
      subscribeSharedTrip(trip);
      renderDrawer(trip);
    });
    panel.appendChild(btn);
    return;
  }

  const codeBlock = document.createElement('div');
  codeBlock.className = 'share-code-block';
  codeBlock.innerHTML = `
    <p class="share-code-label">Trip code — share it with your travel companion</p>
    <p class="share-code-value">${trip.shareCode}</p>
  `;
  panel.appendChild(codeBlock);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'sharing-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn-small';
  copyBtn.textContent = 'Copy code';
  copyBtn.addEventListener('click', () => {
    const code = trip.shareCode;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code)
        .then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1500);
        })
        .catch(() => alert(`Code: ${code}`));
    } else {
      alert(`Code: ${code}`);
    }
  });

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'btn-danger btn-danger-inline';
  stopBtn.textContent = 'Stop syncing on this device';
  stopBtn.addEventListener('click', () => {
    if (!confirm('Stop syncing this trip on this device? Your travel companion keeps their copy — this device keeps its current data but won\u2019t update anymore.')) return;
    CloudSync.unsubscribe(trip.shareCode);
    trip.shared = false;
    trip.shareCode = null;
    saveState();
    renderDrawer(trip);
  });

  actionsRow.appendChild(copyBtn);
  actionsRow.appendChild(stopBtn);
  panel.appendChild(actionsRow);
}

// Starts (or restarts) a live Firestore listener for a shared trip. Safe to
// call repeatedly — CloudSync.subscribe replaces any existing listener for
// the same code. No-ops entirely if sharing isn't configured.
function subscribeSharedTrip(trip) {
  if (typeof CloudSync === 'undefined' || !CloudSync.configured) return;
  if (!trip.shared || !trip.shareCode) return;
  CloudSync.subscribe(trip.shareCode, (remoteData) => handleRemoteTripUpdate(trip.shareCode, remoteData));
}

// Fires when a shared trip changes on someone else's phone. Merges the
// remote data in, keeping this device's own local trip id (attachments are
// keyed by it) and re-renders — unless the person is actively typing in the
// day view right now, in which case we save quietly and let the next
// natural render pick it up, so we don't yank focus mid-keystroke.
function handleRemoteTripUpdate(shareCode, remoteData) {
  const trip = state.trips.find(t => t.shareCode === shareCode);
  if (!trip) return;
  const localId = trip.id;
  Object.assign(trip, remoteData, { id: localId, shared: true, shareCode });
  if (!trip.days) trip.days = {};
  getDaysArray(trip.startDate, trip.endDate).forEach(d => ensureDay(trip, d));
  saveState();

  const typing = document.activeElement && dayViewEl.contains(document.activeElement);

  if (state.activeTripId === localId && !viewTrip.hidden && !typing) {
    renderTripDetail(trip);
  }
  if (!viewTrips.hidden) {
    renderTripList();
  }
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
  commitTripChange(trip);
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
  commitTripChange(trip);
  if (!trip.days[activeDayDate]) activeDayDate = start;
  renderTripDetail(trip);
}

document.getElementById('btn-add-destination').addEventListener('click', () => {
  const input = document.getElementById('input-destination');
  const val = input.value.trim();
  if (!val) return;
  const trip = getTrip(state.activeTripId);
  trip.destinations.push(val);
  commitTripChange(trip);
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
  commitTripChange(trip);
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
    commitTripChange(trip);
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
    commitTripChange(trip);
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
    const newActivity = { id: uid(), time: lastTime, title: '', ticket: '', payments: [] };
    day.activities.push(newActivity);
    commitTripChange(trip);
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

  const header = document.createElement('div');
  header.className = 'activity-header';

  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'activity-time-input';
  timeInput.value = activity.time || '09:00';
  timeInput.addEventListener('change', () => {
    activity.time = timeInput.value;
    commitTripChange(trip);
    renderDayView(trip, dateStr); // re-sort into chronological order
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'activity-delete';
  deleteBtn.setAttribute('aria-label', 'Remove activity');
  deleteBtn.textContent = '🗑';
  deleteBtn.addEventListener('click', () => {
    day.activities = day.activities.filter(a => a.id !== activity.id);
    (activity.attachmentIds || []).forEach(attId => {
      deleteAttachment(`activity-${trip.id}-${dateStr}-${activity.id}-${attId}`).catch(() => {});
    });
    commitTripChange(trip);
    renderDayView(trip, dateStr);
  });

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'activity-title';
  titleInput.placeholder = 'Activity name';
  titleInput.value = activity.title || '';

  header.appendChild(timeInput);
  header.appendChild(titleInput);
  header.appendChild(deleteBtn);

  const addressInput = document.createElement('input');
  addressInput.type = 'text';
  addressInput.className = 'activity-address';
  addressInput.placeholder = 'Address';
  addressInput.value = activity.address || '';

  const hoursInput = document.createElement('input');
  hoursInput.type = 'text';
  hoursInput.className = 'activity-hours';
  hoursInput.placeholder = 'Operating hours';
  hoursInput.value = activity.hours || '';

  const addressRow = document.createElement('div');
  addressRow.className = 'activity-address-row';
  addressRow.appendChild(addressInput);
  addressRow.appendChild(hoursInput);

  const ticketInput = document.createElement('input');
  ticketInput.type = 'text';
  ticketInput.className = 'activity-ticket';
  ticketInput.placeholder = 'Ticket / booking ref';
  ticketInput.value = activity.ticket || '';

  const commitText = debounce(() => {
    activity.title = titleInput.value.trim();
    activity.address = addressInput.value.trim();
    activity.hours = hoursInput.value.trim();
    activity.ticket = ticketInput.value.trim();
    commitTripChange(trip);
  }, 300);
  titleInput.addEventListener('input', commitText);
  addressInput.addEventListener('input', commitText);
  hoursInput.addEventListener('input', commitText);
  ticketInput.addEventListener('input', commitText);

  const ticketRow = document.createElement('div');
  ticketRow.className = 'activity-ticket-row';
  ticketRow.appendChild(ticketInput);

  row.appendChild(header);
  row.appendChild(addressRow);
  row.appendChild(buildTodosSection(trip, dateStr, activity));
  row.appendChild(ticketRow);
  row.appendChild(buildAttachmentsSection(trip, dateStr, activity));
  row.appendChild(buildPaymentsSection(trip, dateStr, activity));
  return row;
}

// Repeatable "to do" checklist under one activity — e.g. under "Go to
// attraction X": Ride cable car / Buy souvenir / Eat abc. Each item has a
// checkbox, text, and a remove button.
function buildTodosSection(trip, dateStr, activity) {
  const section = document.createElement('div');
  section.className = 'todos-section';

  function rerender() {
    section.innerHTML = '';
    (activity.todos || []).forEach((todo, idx) => {
      section.appendChild(buildTodoRow(trip, activity, todo, idx, rerender));
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-add-todo';
    addBtn.textContent = activity.todos && activity.todos.length ? '+ Add another to-do' : '+ Add to-do';
    addBtn.addEventListener('click', () => {
      if (!activity.todos) activity.todos = [];
      activity.todos.push({ id: uid(), text: '', done: false });
      commitTripChange(trip);
      rerender();
      const inputs = section.querySelectorAll('.todo-text');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    section.appendChild(addBtn);
  }

  rerender();
  return section;
}

function buildTodoRow(trip, activity, todo, idx, rerender) {
  const row = document.createElement('div');
  row.className = 'todo-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'todo-checkbox';
  checkbox.checked = !!todo.done;
  checkbox.addEventListener('change', () => {
    todo.done = checkbox.checked;
    commitTripChange(trip);
    textInput.classList.toggle('todo-done', todo.done);
  });

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'todo-text' + (todo.done ? ' todo-done' : '');
  textInput.placeholder = 'e.g. Ride the cable car';
  textInput.value = todo.text || '';
  textInput.addEventListener('input', debounce(() => {
    todo.text = textInput.value.trim();
    commitTripChange(trip);
  }, 300));

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'todo-remove';
  removeBtn.setAttribute('aria-label', 'Remove to-do');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    activity.todos.splice(idx, 1);
    commitTripChange(trip);
    rerender();
  });

  row.appendChild(checkbox);
  row.appendChild(textInput);
  row.appendChild(removeBtn);
  return row;
}

// Multiple ticket files per activity — each attachment gets its own
// IndexedDB key (activity-{tripId}-{dateStr}-{activityId}-{attachmentId});
// activity.attachmentIds lists which ones belong to this activity.
function buildAttachmentsSection(trip, dateStr, activity) {
  const section = document.createElement('div');
  section.className = 'attachments-section';

  function rerender() {
    section.innerHTML = '';
    const chipRow = document.createElement('div');
    chipRow.className = 'attachment-chip-row';
    section.appendChild(chipRow);

    (activity.attachmentIds || []).forEach(attId => {
      const key = `activity-${trip.id}-${dateStr}-${activity.id}-${attId}`;
      getAttachment(key).then(record => {
        if (!record) return;
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
          deleteAttachment(key).then(() => {
            activity.attachmentIds = activity.attachmentIds.filter(id => id !== attId);
            commitTripChange(trip);
            rerender();
          });
        });
        chip.appendChild(removeBtn);
        chipRow.appendChild(chip);
      });
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'attach-btn-labeled';
    addBtn.textContent = '📎 Add ticket file';
    addBtn.addEventListener('click', () => {
      const newAttId = uid();
      const key = `activity-${trip.id}-${dateStr}-${activity.id}-${newAttId}`;
      requestAttach(key, () => {
        if (!activity.attachmentIds) activity.attachmentIds = [];
        activity.attachmentIds.push(newAttId);
        commitTripChange(trip);
        rerender();
      });
    });
    section.appendChild(addBtn);
  }

  rerender();
  return section;
}

// Builds the repeatable "who paid" list for one activity: each payment is a
// payer name, an amount, and a currency, with its own remove button, plus
// an "+ Add payment" control. Re-renders itself in place on any change so
// the parent activity row doesn't need a full re-render (which would drop
// focus mid-edit).
function buildPaymentsSection(trip, dateStr, activity) {
  const section = document.createElement('div');
  section.className = 'payments-section';

  function rerender() {
    section.innerHTML = '';
    activity.payments.forEach((payment, idx) => {
      section.appendChild(buildPaymentRow(trip, payment, idx, activity, rerender));
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-add-payment';
    addBtn.textContent = activity.payments.length ? '+ Add another payment' : '+ Add payment';
    addBtn.addEventListener('click', () => {
      activity.payments.push({ id: uid(), payer: '', amount: '', currency: trip.lastCurrency || '' });
      commitTripChange(trip);
      rerender();
      const lastRow = section.querySelectorAll('.payment-payer');
      if (lastRow.length) lastRow[lastRow.length - 1].focus();
    });
    section.appendChild(addBtn);
    refreshPayerDatalist(trip);
  }

  rerender();
  return section;
}

function buildPaymentRow(trip, payment, idx, activity, rerender) {
  const row = document.createElement('div');
  row.className = 'payment-row';

  const payerInput = document.createElement('input');
  payerInput.type = 'text';
  payerInput.className = 'payment-payer';
  payerInput.placeholder = 'Who paid';
  payerInput.value = payment.payer || '';
  payerInput.setAttribute('list', 'payer-names');

  const amountInput = document.createElement('input');
  amountInput.type = 'number';
  amountInput.inputMode = 'decimal';
  amountInput.step = '0.01';
  amountInput.min = '0';
  amountInput.className = 'payment-amount';
  amountInput.placeholder = '0';
  amountInput.value = payment.amount === undefined ? '' : payment.amount;

  const currencyInput = document.createElement('input');
  currencyInput.type = 'text';
  currencyInput.className = 'payment-currency';
  currencyInput.placeholder = 'CAD';
  currencyInput.maxLength = 6;
  currencyInput.value = payment.currency || '';

  const commit = debounce(() => {
    payment.payer = payerInput.value.trim();
    payment.amount = amountInput.value;
    payment.currency = currencyInput.value.trim().toUpperCase();
    if (payment.currency) trip.lastCurrency = payment.currency;
    commitTripChange(trip);
    refreshPayerDatalist(trip);
  }, 300);
  payerInput.addEventListener('input', commit);
  amountInput.addEventListener('input', commit);
  currencyInput.addEventListener('input', commit);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'payment-remove';
  removeBtn.setAttribute('aria-label', 'Remove payment');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    activity.payments.splice(idx, 1);
    commitTripChange(trip);
    rerender();
  });

  row.appendChild(payerInput);
  row.appendChild(amountInput);
  row.appendChild(currencyInput);
  row.appendChild(removeBtn);
  return row;
}

// Keeps a single shared <datalist> of every payer name used anywhere in the
// current trip, so payer inputs can suggest names already typed once.
function refreshPayerDatalist(trip) {
  let datalist = document.getElementById('payer-names');
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = 'payer-names';
    document.body.appendChild(datalist);
  }
  const names = new Set();
  Object.values(trip.days).forEach(day => {
    (day.activities || []).forEach(a => (a.payments || []).forEach(p => {
      if (p.payer) names.add(p.payer);
    }));
  });
  datalist.innerHTML = '';
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    datalist.appendChild(opt);
  });
}

// Totals every payment in the trip by payer, split by currency (currencies
// aren't converted/summed together — "120 CAD, 40 USD" stays two figures).
function computeExpenseSummary(trip) {
  const totals = {};
  Object.values(trip.days).forEach(day => {
    (day.activities || []).forEach(activity => {
      (activity.payments || []).forEach(p => {
        const amount = parseFloat(p.amount);
        if (!p.payer || isNaN(amount)) return;
        const currency = (p.currency || '').trim();
        if (!totals[p.payer]) totals[p.payer] = {};
        totals[p.payer][currency] = (totals[p.payer][currency] || 0) + amount;
      });
    });
  });
  return totals;
}

function renderExpenseSummary(trip) {
  const container = document.getElementById('expense-summary');
  if (!container) return;
  container.innerHTML = '';
  const totals = computeExpenseSummary(trip);
  const payers = Object.keys(totals).sort();

  if (payers.length === 0) {
    const p = document.createElement('p');
    p.className = 'drawer-hint';
    p.textContent = 'No payments logged yet — add one from any activity\u2019s "+ Add payment".';
    container.appendChild(p);
    return;
  }

  payers.forEach(payer => {
    const row = document.createElement('div');
    row.className = 'expense-row';
    const parts = Object.entries(totals[payer]).map(([currency, amount]) => {
      const rounded = Math.round(amount * 100) / 100;
      return currency ? `${rounded} ${currency}` : `${rounded}`;
    });
    row.innerHTML = `<span class="expense-payer">${escapeHtml(payer)}</span><span class="expense-amount">${parts.join(', ')}</span>`;
    container.appendChild(row);
  });
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
          // Don't carry sharing state across an import — re-share explicitly
          // if wanted, so we never accidentally start pushing to someone
          // else's live trip code.
          t.shared = false;
          t.shareCode = null;
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

// Start live listeners for any trips already shared, so updates from a
// travel companion arrive even while sitting on the trip list.
state.trips.forEach(trip => subscribeSharedTrip(trip));

// Upgrade any trips saved under the old fixed time-grid format, then
// re-render whichever page is showing so the converted data appears.
migrateLegacyDays()
  .then(() => migrateLegacyAttachments())
  .then(() => {
    renderTripList();
    if (state.activeTripId && getTrip(state.activeTripId)) {
      renderTripDetail(getTrip(state.activeTripId));
    }
  });
