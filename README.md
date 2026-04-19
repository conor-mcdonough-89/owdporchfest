# OWD Porchfest

A static landing page for OWD Porchfest — our neighborhood concert day.

Plain HTML, CSS, and JavaScript. No framework, no build step. Deploys to Vercel (or any static host) as-is.

## File layout

```
.
├── index.html          # markup
├── styles.css          # design tokens + all styles
├── main.js             # CSV load, map, schedule
├── assets/             # SVG logo + decorations (swap these for final art)
│   ├── logo.svg
│   ├── bunting.svg
│   ├── soundwave.svg
│   ├── star.svg
│   └── noise.svg
└── data/
    └── performances.csv  # fallback lineup (used if the Google Sheet isn't set)
```

All external libraries (Leaflet, PapaParse, Google Fonts) load from CDNs.

## Run locally

Because `main.js` fetches a CSV via `fetch()`, opening `index.html` straight from disk will work in some browsers but fail in others (CORS rules on `file://`). Easiest path is a tiny static server:

```bash
# from the project root
python3 -m http.server 8080
# then open http://localhost:8080
```

Or with Node:

```bash
npx serve .
```

## Deploy to Vercel

From the project root:

```bash
vercel deploy        # preview
vercel deploy --prod # production
```

No config needed. Vercel treats this as a static site and serves `index.html` at the root.

## Updating the lineup (for admins)

The map and schedule are driven by one CSV. You have two options:

### Option A (recommended): edit a Google Sheet, site auto-updates

1. Open your performances Google Sheet.
2. Make sure the columns match exactly (case-sensitive, in this order):

   ```
   name, address, lat, lng, start_time, end_time, style, description, host
   ```

   - `lat` / `lng` — decimal degrees (e.g. `41.8231`, `-71.4128`).
   - `start_time` / `end_time` — 24-hour `HH:MM` (e.g. `13:30`).
   - `host` — optional. If filled in, the map popup will read "Hosted by …". Leave blank to omit.

3. In Google Sheets: **File → Share → Publish to web**.
4. In the dialog: pick the correct tab, choose **Comma-separated values (.csv)**, and click **Publish**. Copy the URL Google gives you — it will look like:

   ```
   https://docs.google.com/spreadsheets/d/e/XXXXXXXX/pub?gid=0&single=true&output=csv
   ```

5. Open `main.js` and paste that URL into the `SHEET_CSV_URL` constant at the top:

   ```js
   const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/XXXX/pub?...&output=csv";
   ```

6. Commit and redeploy. From now on, edits to the published sheet will appear on the site on the next page load (Google caches published CSVs for a few minutes).

If the sheet is ever empty, unpublished, or unreachable, the site quietly falls back to `data/performances.csv` so the page never breaks.

### Option B: edit `data/performances.csv` directly

For small neighborhoods or one-off edits, just open `data/performances.csv`, edit the rows, commit, and redeploy.

## Customizing the design

All colors, fonts, and spacing tokens live at the top of `styles.css` under `:root`. Retune the palette or typography from that one block:

```css
--color-accent:  #c25a3a;   /* dominant accent — terracotta */
--font-display:  "Fraunces", ...;
--font-body:     "Nunito", ...;
```

To swap the logo, replace `assets/logo.svg` (the inline copy in `index.html` also uses the same SVG paths — replace both or switch to an `<img>`).

The map basemap is set in `main.js` at `TILE_URL`. CartoDB Positron is the default; swap to Stadia "Stamen Toner Lite" or any other tile provider by changing `TILE_URL` and `TILE_ATTRIBUTION`.

## Notes

- The neighborhood center in `main.js` (`NEIGHBORHOOD_CENTER`) is a placeholder — update it before launch.
- The sample `data/performances.csv` uses arbitrary Providence-area coordinates for demo purposes.
