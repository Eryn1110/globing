# Globing — offline itinerary planner

A small, self-contained web app for planning trips hour by hour: a travel period, destinations, trip-level tickets/bookings, and a day-by-day itinerary where you add activities one at a time with a time, a ticket reference, an optional ticket photo/PDF, and a cost note.

**Important:** by default, your trip data is stored only in your phone's browser (`localStorage` + `IndexedDB` for attachments). GitHub just hosts the app's code — it doesn't store or sync anything on its own. Optional cloud sharing (below) changes this for trips you explicitly choose to share.

## 1. Put it on GitHub

1. Create a new repository on GitHub (e.g. `globing`), public or private.
2. Upload **all** the files in this folder to the repo root — either drag-and-drop in the GitHub web UI ("Add file → Upload files"), or:
   ```bash
   cd globing
   git init
   git add .
   git commit -m "Globing itinerary app"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/globing.git
   git push -u origin main
   ```
   Files: `index.html`, `style.css`, `app.js`, `firebase-config.js`, `cloud-sync.js`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, `bg-art.jpg`, `README.md`.
3. In the repo, go to **Settings → Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, branch **main**, folder **/(root)**. Save.
4. GitHub gives you a URL like `https://YOUR-USERNAME.github.io/globing/`. It can take a minute to go live.

## 2. Install it on your phone

**iPhone (Safari):** open the GitHub Pages URL → tap the Share icon → **Add to Home Screen**.

**Android (Chrome):** open the URL → tap the **⋮** menu → **Add to Home screen** / **Install app**.

Open it once while you have signal so the service worker can cache the app shell — after that it launches and works with no connection at all. Only the very first load needs the internet.

## 3. Using it

- **Trip list**: "+ New trip" for a fresh one, or "Have a code? Join a shared trip" to join one someone shared with you (see Sharing below).
- **Inside a trip**, tap **⋯** for settings: dates, destinations, trip-level tickets/bookings, and sharing.
- **Day tabs** across the top jump between days. "Mark day done" on a day turns its tab into a green checkmark.
- Each day has a **notes** box, then a list of **activities** you add one at a time — each with a time, a title, a ticket reference, a 📎 for a ticket photo/PDF, and a repeatable **payments** list (who paid, how much, in what currency) for splitting costs across multiple people.
- Trip settings (⋯) has a **"Who paid what"** summary — running totals per person across every payment in the whole trip.

## Sharing a trip with someone else (optional)

By default this is off, and the app is 100% local/offline as described above. Turning it on requires a free Firebase project — takes about 5 minutes, no credit card:

1. Go to [firebase.google.com](https://firebase.google.com), sign in, click **Add project** (any name), skip Google Analytics if asked.
2. In the project, go to **Build → Firestore Database → Create database**. Start in **production mode**, pick any region.
3. Once created, go to the **Rules** tab and replace the contents with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /trips/{tripId} {
         allow read, write: if true;
       }
     }
   }
   ```
   **What this means:** anyone who has a trip's share code can read/write that trip — there's no login. It's the same security model as a Google Doc link: convenient, but don't share the code publicly, and treat it as appropriate only for casual trip planning, not sensitive data. Click **Publish**.
4. Go to **Project settings** (⚙ next to "Project Overview") → scroll to **Your apps** → click the web icon (`</>`) → register an app (any nickname, no hosting needed) → it shows a `firebaseConfig` object.
5. Open `firebase-config.js` in this folder and replace the placeholder values with the ones from that config object. Push the updated file to GitHub.

That's it — once deployed, every trip's settings (⋯) will show a **Share this trip** button. Tap it to get a 6-character code; the other person taps **"Have a code? Join a shared trip"** on the trip list and enters it. From then on, activities, notes, dates, destinations, day-done status, and costs sync live between both phones (usually within a second or two).

**What does *not* sync:** ticket photos/PDFs stay local to whichever phone attached them — Firestore isn't built for large files, so this was left out to keep the free tier comfortably sufficient and the setup simple. Each phone can still attach its own copy of a ticket if needed.

**Testing note:** this whole thing can't be demonstrated in a Claude chat preview — the sandboxed preview blocks the outside network calls Firestore needs. It only works once actually deployed to GitHub Pages.

## Backups

The **⭳ export** button on the trips screen saves a JSON backup (e.g. to iCloud/Google Drive/email); **⭱ import** restores it. Attachments and live-sharing status aren't included in the backup file — only text data.

## Updating the app later

Edit the files and push to GitHub again — GitHub Pages redeploys automatically. Your saved trips aren't affected, since they live in the browser (and, for shared trips, in Firestore), not in the code.
