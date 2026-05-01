/* =========================================================================
   OWD Porchfest — main.js
   Loads performance data from a published Google Sheet (CSV) or falls back
   to the bundled /data/performances.csv, then renders the map and schedule.
   ========================================================================= */

/* -------------------------------------------------------------------------
   ADMIN: to update the lineup, do the following in Google Sheets:
     1. Open your performances sheet.
     2. Make sure the columns match exactly (case-sensitive):
        name, address, lat, lng, start_time, end_time, style, link
        (lat/lng as decimal degrees; start_time/end_time in 24h "HH:MM".
        link is an optional URL — when present, a "Learn more" link
        appears next to the band name in the schedule. Leave blank to omit.)
     3. File → Share → Publish to web.
     4. In the dialog, pick the correct sheet/tab and choose "Comma-separated
        values (.csv)". Click Publish. Copy the URL Google gives you.
     5. Paste that URL into SHEET_CSV_URL below and redeploy. Done.
   If SHEET_CSV_URL is empty or unreachable, the site falls back to
   /data/performances.csv so the page keeps working.
   ------------------------------------------------------------------------- */
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSnsJNsV7fHu5V0AYOWaZtqc2OIt-k4t-NE_2c3SLnmKFvDUu__L3kEKkYw-Yv6eOKJYnHvCLFuEOOP/pub?output=csv";
const LOCAL_CSV_URL = "data/performances.csv";

// TODO: replace center coords with the actual neighborhood center before launch.
const NEIGHBORHOOD_CENTER = [41.8238, -71.4135];
const DEFAULT_ZOOM = 16;

// Warm, folksy basemap. CartoDB Positron reads cleanly against the cream page.
// Alternative: Stadia "Stamen Toner Lite" — swap tileUrl + attribution if desired.
const TILE_URL =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>';

/* ---------- small helpers ---------- */

const $ = (sel) => document.querySelector(sel);

// 24h "HH:MM" -> "12:30 pm" (lowercase, tight, editorial)
function formatTime(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr, 10);
  const m = (mStr || "00").padStart(2, "0");
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === "00" ? `${hour12} ${suffix}` : `${hour12}:${m} ${suffix}`;
}

function timeRange(start, end) {
  const s = formatTime(start);
  const e = formatTime(end);
  if (s && e) return `${s} – ${e}`;
  return s || e || "";
}

function minutesFromHHMM(hhmm) {
  if (!hhmm) return Number.POSITIVE_INFINITY;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(h)) return Number.POSITIVE_INFINITY;
  return h * 60 + (Number.isNaN(m) ? 0 : m);
}

function escapeHTML(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- data loading ---------- */

async function loadCSV(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (!results || !results.data) return reject(new Error("No data"));
        resolve(results.data);
      },
      error: (err) => reject(err),
    });
  });
}

function normalizeRows(rows) {
  return rows
    .map((r) => ({
      name: (r.name || "").trim(),
      address: (r.address || "").trim(),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
      start_time: (r.start_time || "").trim(),
      end_time: (r.end_time || "").trim(),
      style: (r.style || "").trim(),
      link: (r.link || "").trim(),
      host: (r.host || "").trim(),
    }))
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng))
    .sort((a, b) => minutesFromHHMM(a.start_time) - minutesFromHHMM(b.start_time));
}

function locationKey(row) {
  return `${row.lat.toFixed(5)},${row.lng.toFixed(5)}`;
}

// Mutates rows in place to add `porchNumber`. Porches are numbered by the
// earliest start_time at each lat/lng (rounded to 5dp ~ 1 m so tiny typos in
// the sheet don't split a porch across two pins). All acts at the same porch
// share a number, matching the pin label on the map.
function assignPorchNumbers(rows) {
  const earliestByKey = new Map();
  rows.forEach((row) => {
    const key = locationKey(row);
    const m = minutesFromHHMM(row.start_time);
    if (!earliestByKey.has(key) || m < earliestByKey.get(key)) {
      earliestByKey.set(key, m);
    }
  });
  const orderedKeys = Array.from(earliestByKey.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);
  const numberByKey = new Map(orderedKeys.map((k, i) => [k, i + 1]));
  rows.forEach((row) => {
    row.porchNumber = numberByKey.get(locationKey(row));
  });
}

// Multiple acts at the same address collapse to a single pin; the popup then
// stacks the sets. Assumes `assignPorchNumbers` has already run so every row
// carries its porch number.
function groupByLocation(rows) {
  const groups = new Map();
  rows.forEach((row, i) => {
    const key = locationKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        lat: row.lat,
        lng: row.lng,
        address: row.address,
        number: row.porchNumber,
        sets: [],
      });
    }
    groups.get(key).sets.push({ ...row, rowIndex: i });
  });

  const arr = Array.from(groups.values());
  arr.forEach((g) => {
    g.sets.sort(
      (a, b) => minutesFromHHMM(a.start_time) - minutesFromHHMM(b.start_time)
    );
  });
  arr.sort((a, b) => a.number - b.number);
  return arr;
}

async function loadPerformances() {
  if (SHEET_CSV_URL) {
    try {
      const rows = await loadCSV(SHEET_CSV_URL);
      const clean = normalizeRows(rows);
      if (clean.length) return { rows: clean, source: "sheet" };
      console.warn("Sheet returned no rows, falling back to local CSV.");
    } catch (err) {
      console.warn("Sheet fetch failed, falling back to local CSV.", err);
    }
  }
  const rows = await loadCSV(LOCAL_CSV_URL);
  return { rows: normalizeRows(rows), source: "local" };
}

/* ---------- map ---------- */

// A custom SVG pin as a Leaflet divIcon so it inherits our accent color and
// stays crisp on any screen. Teardrop + inner circle with the set-order number.
// When stackSize > 1, a small "+N" badge is drawn in the top-right to signal
// that multiple sets share this porch.
function makePorchIcon(label, stackSize = 1) {
  const text = String(label ?? "");
  const fontSize = text.length > 1 ? 9 : 11;
  const badge = stackSize > 1 ? `
    <g>
      <circle cx="28" cy="7" r="6" fill="#D54838" stroke="#ffffff" stroke-width="1.5"/>
      <text x="28" y="7.5" text-anchor="middle" dominant-baseline="central"
            font-family="Fraunces, Georgia, serif" font-weight="700"
            font-size="7" fill="#ffffff">+${stackSize - 1}</text>
    </g>` : "";
  const svg = `
    <svg class="porch-pin" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 1.5 C8 1.5 1.5 8.5 1.5 17 C1.5 27.5 17 42.5 17 42.5 C17 42.5 32.5 27.5 32.5 17 C32.5 8.5 26 1.5 17 1.5 Z"
            fill="currentColor" stroke="#D54838" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="17" cy="16.5" r="7" fill="#ffffff"/>
      <text x="17" y="17" text-anchor="middle" dominant-baseline="central"
            font-family="Fraunces, Georgia, serif" font-weight="600"
            font-size="${fontSize}" fill="#D54838">${escapeHTML(text)}</text>
      ${badge}
    </svg>`;
  return L.divIcon({
    className: "porch-pin-wrap",
    html: svg,
    iconSize: [34, 44],
    iconAnchor: [17, 42],
    popupAnchor: [0, -36],
  });
}

// Inner block shared by single-set and stacked popups. When `prefix` is set
// (single-set popup) it prepends the porch label to the time-range eyebrow;
// stacked items just show the time since the porch label sits in the header.
function popupItemInner(row, prefix = "") {
  const time = timeRange(row.start_time, row.end_time);
  const eyebrow = prefix ? `${prefix} · ${time}` : time;
  const hostLine = row.host
    ? `<br/><span class="hosted-by">Hosted by ${escapeHTML(row.host)}</span>`
    : "";
  const linkLine = row.link
    ? `<p class="blurb"><a class="learn-more" href="${escapeHTML(row.link)}" target="_blank" rel="noopener">Learn more</a></p>`
    : "";
  return `
    <p class="popup-card__eyebrow">${escapeHTML(eyebrow)}</p>
    <h4>${escapeHTML(row.name)}</h4>
    <p class="meta">
      <strong>${escapeHTML(row.style || "Live music")}</strong><br/>
      ${escapeHTML(row.address)}${hostLine}
    </p>
    ${linkLine}
  `;
}

function groupPopupHTML(group) {
  if (group.sets.length === 1) {
    return `<div class="popup-card">${popupItemInner(group.sets[0], `Porch ${group.number}`)}</div>`;
  }
  const items = group.sets
    .map((s) => `<div class="popup-item">${popupItemInner(s)}</div>`)
    .join("");
  return `
    <div class="popup-card popup-card--stacked">
      <div class="popup-stack-header">
        <p class="popup-card__eyebrow">Porch ${group.number}</p>
        <p class="popup-stack-title">${group.sets.length} sets &middot; ${escapeHTML(group.address)}</p>
      </div>
      <div class="popup-stack-items" data-count="${group.sets.length}">${items}</div>
    </div>
  `;
}

// Leaflet caps the popup at this width; side-by-side sets need more room.
function popupMaxWidthFor(setCount) {
  if (setCount <= 1) return 280;
  if (setCount === 2) return 480;
  return 640; // 3+ sets — wraps to two rows via auto-fit grid
}

function buildMap(rows) {
  const map = L.map("map", {
    center: NEIGHBORHOOD_CENTER,
    zoom: DEFAULT_ZOOM,
    scrollWheelZoom: false,
    zoomControl: true,
  });

  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(map);

  const groups = groupByLocation(rows);
  const markersByRowIndex = {};
  const bounds = [];

  groups.forEach((group) => {
    const altParts = group.sets.map((s) => s.name).join(", ");
    const m = L.marker([group.lat, group.lng], {
      icon: makePorchIcon(group.number, group.sets.length),
      alt: `Porch ${group.number}, ${group.address} — ${altParts}`,
      keyboard: true,
      riseOnHover: true,
    }).addTo(map);

    m.bindPopup(groupPopupHTML(group), {
      closeButton: true,
      autoPanPadding: [24, 24],
      maxWidth: popupMaxWidthFor(group.sets.length),
    });

    const rowIndices = group.sets.map((s) => s.rowIndex);
    m.on("popupopen", () => highlightScheduleRows(rowIndices));
    m.on("popupclose", () => highlightScheduleRows([]));

    group.sets.forEach((s) => {
      markersByRowIndex[s.rowIndex] = m;
    });
    bounds.push([group.lat, group.lng]);
  });

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  }

  return { map, markers: markersByRowIndex };
}

/* ---------- schedule ---------- */

let mapInstance = null;
let markerIndex = {};
let rowEls = [];

function highlightScheduleRows(indices) {
  const set = new Set(indices);
  rowEls.forEach((el, i) => {
    el.classList.toggle("is-active", set.has(i));
  });
}

function buildSchedule(rows) {
  const tbody = $("#schedule-body");
  tbody.innerHTML = "";
  rowEls = [];

  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.setAttribute("tabindex", "0");
    tr.setAttribute("role", "button");
    tr.setAttribute(
      "aria-label",
      `Porch ${row.porchNumber}, ${row.name}, ${row.style || "music"}, ${timeRange(row.start_time, row.end_time)} at ${row.address}. Activate to show on map.`
    );

    const learnMore = row.link
      ? `<div><a class="learn-more" href="${escapeHTML(row.link)}" target="_blank" rel="noopener">Learn more</a></div>`
      : "";
    const porchNum = row.porchNumber != null ? row.porchNumber : "";
    tr.innerHTML = `
      <td class="porch-num"><span aria-label="Porch number">${escapeHTML(String(porchNum))}</span></td>
      <td class="time"><span>${escapeHTML(timeRange(row.start_time, row.end_time))}</span></td>
      <td class="location">${escapeHTML(row.address)}</td>
      <td class="band">${escapeHTML(row.name)}${learnMore}</td>
      <td class="style">${row.style ? `<span>${escapeHTML(row.style)}</span>` : ""}</td>
    `;

    const learnMoreEl = tr.querySelector(".learn-more");
    if (learnMoreEl) {
      // Don't let the row's click handler swallow the link or yank the user
      // back to the map when they're trying to follow it.
      learnMoreEl.addEventListener("click", (e) => e.stopPropagation());
    }

    const activate = () => {
      const marker = markerIndex[i];
      if (!mapInstance || !marker) return;
      // Smoothly pan to the porch; open its popup.
      mapInstance.flyTo([row.lat, row.lng], Math.max(mapInstance.getZoom(), 17), {
        duration: 0.7,
      });
      marker.openPopup();
      highlightScheduleRows([i]);
      // Scroll the map into view on small screens so it's actually visible.
      document.getElementById("map-section").scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    };

    tr.addEventListener("click", activate);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    tbody.appendChild(tr);
    rowEls.push(tr);
  });

  const status = $("#schedule-status");
  if (!rows.length) {
    status.textContent = "The lineup is still coming together — check back soon.";
  } else {
    const porches = new Set(rows.map((r) => `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`)).size;
    const setsWord = rows.length === 1 ? "set" : "sets";
    const porchWord = porches === 1 ? "porch" : "porches";
    status.textContent = `${rows.length} ${setsWord} across ${porches} ${porchWord}, sorted by start time.`;
  }
}

/* ---------- reveal animation ---------- */

function runReveal() {
  const items = document.querySelectorAll(".reveal");
  items.forEach((el, i) => {
    // Staggered entrance; respects prefers-reduced-motion via CSS.
    setTimeout(() => el.classList.add("is-in"), 60 + i * 70);
  });
}

/* ---------- boot ---------- */

async function boot() {
  $("#year").textContent = new Date().getFullYear();
  runReveal();

  try {
    const { rows, source } = await loadPerformances();
    if (source === "local" && !SHEET_CSV_URL) {
      console.info("[Porchfest] Using bundled /data/performances.csv. Paste your published Google Sheet URL into SHEET_CSV_URL in main.js to go live.");
    }
    assignPorchNumbers(rows);
    const { map, markers } = buildMap(rows);
    mapInstance = map;
    markerIndex = markers;
    buildSchedule(rows);
  } catch (err) {
    console.error("Failed to load performances:", err);
    $("#schedule-status").textContent =
      "We couldn't load the lineup right now. Please refresh in a moment.";
  }
}

document.addEventListener("DOMContentLoaded", boot);
