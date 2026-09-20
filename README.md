# Globing — offline itinerary planner

A small, self-contained web app for planning trips hour by hour: a travel period, destinations, tickets/bookings, and a day-by-day calendar broken into 30-minute slots where you can note the attraction and its ticket.

**Important:** your trip data is stored only in your phone's browser (via `localStorage`). GitHub just hosts the app's code/design — it does not store or sync your itinerary. See **Backups** below.

## 1. Put it on GitHub

1. Create a new repository on GitHub (e.g. `globing`), public or private.
2. Upload all the files in this folder (`index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, `README.md`) to the repo root — either drag-and-drop in the GitHub web UI ("Add file → Upload files"), or:
   ```bash
   cd globing
   git init
   git add .
   git commit -m "Globing itinerary app"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/globing.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, branch **main**, folder **/(root)**. Save.
4. GitHub gives you a URL like `https://YOUR-USERNAME.github.io/globing/`. It can take a minute to go live.

## 2. Install it on your phone

**iPhone (Safari):** open the GitHub Pages URL → tap the Share icon → **Add to Home Screen**. It now opens full-screen like a normal app, with its own icon.

**Android (Chrome):** open the URL → tap the **⋮** menu → **Add to Home screen** / **Install app**.

Open it once while you have signal so the service worker can cache the app shell — after that it launches and works with no connection at all (airplane mode included). Only the very first load needs the internet.

## 3. Using it

- **Home screen**: create a trip with a name and travel period (start/end date). Days are generated automatically.
- **Inside a trip**, tap **⋯** to open trip settings: adjust dates, add destinations, and log tickets/bookings that aren't tied to one time slot (flights, hotel confirmations, rail passes).
- Scroll the **day tabs** to jump between days of the trip.
- Each day has a **notes** box at the top, then a scrollable grid in 30-minute increments — tap any slot to type the attraction/plan and its ticket reference.

## Backups

Since data lives only on this device/browser, use the **⭳ export** button on the trips screen occasionally to save a JSON backup (e.g. to iCloud/Google Drive/email). Use **⭱ import** to restore it, or move trips to another phone.

## Updating the app later

Edit the files and push to GitHub again (or re-upload via the web UI) — GitHub Pages redeploys automatically. Your saved trips aren't affected, since they live in the browser, not in the code.
