/* Globing — optional cloud sync for shared trips (Firestore).
   Only text data syncs (activities, notes, dates, destinations, the trip-level
   ticket list, and costs) — ticket/attraction PHOTOS and PDFs stay local to
   whichever phone attached them; they are never uploaded anywhere.

   If firebase-config.js still has its placeholder values (or the Firebase
   scripts fail to load, e.g. no network), this whole file quietly does
   nothing: CloudSync.configured stays false and the app behaves exactly as
   it does with no sharing set up at all — fully local, fully offline. */

const CloudSync = (() => {
  const cfg = window.FIREBASE_CONFIG || {};
  const looksConfigured =
    cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY' &&
    cfg.projectId && cfg.projectId !== 'YOUR_PROJECT_ID';

  let db = null;
  if (looksConfigured && window.firebase) {
    try {
      firebase.initializeApp(cfg);
      db = firebase.firestore();
    } catch (e) {
      console.error('Firebase init failed', e);
    }
  }

  const listeners = {};   // shareCode -> unsubscribe fn
  const pushTimers = {};  // tripId -> timeout handle

  function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips 0/O/1/I to avoid mixups
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  // Debounced full-document push to trips/{shareCode}.
  function pushTrip(trip) {
    if (!db || !trip.shareCode) return;
    clearTimeout(pushTimers[trip.id]);
    pushTimers[trip.id] = setTimeout(() => {
      const payload = Object.assign({}, trip, {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      db.collection('trips').doc(trip.shareCode).set(payload)
        .catch(e => console.error('Cloud sync push failed', e));
    }, 500);
  }

  // Live-subscribes to a shareCode. onData(data) fires when the doc changes
  // on the server — our own optimistic local writes are filtered out via
  // hasPendingWrites, so this only fires for genuinely remote changes.
  function subscribe(shareCode, onData, onError) {
    if (!db) return () => {};
    unsubscribe(shareCode);
    const unsub = db.collection('trips').doc(shareCode).onSnapshot(
      snap => {
        if (snap.metadata.hasPendingWrites) return;
        if (snap.exists) onData(snap.data());
      },
      err => { console.error('Cloud sync listen failed', err); if (onError) onError(err); }
    );
    listeners[shareCode] = unsub;
    return unsub;
  }

  function unsubscribe(shareCode) {
    if (listeners[shareCode]) {
      listeners[shareCode]();
      delete listeners[shareCode];
    }
  }

  async function fetchTripOnce(shareCode) {
    if (!db) return null;
    const doc = await db.collection('trips').doc(shareCode).get();
    return doc.exists ? doc.data() : null;
  }

  return {
    get configured() { return !!db; },
    generateCode,
    pushTrip,
    subscribe,
    unsubscribe,
    fetchTripOnce
  };
})();
