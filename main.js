/* =========================================================================
   OWD Porchfest — main.js
   Loads performance data from a published Google Sheet (CSV) or falls back
   to the bundled /data/performances.csv, then renders the map and schedule.
   ========================================================================= */

/* -------------------------------------------------------------------------
   ADMIN: to update the lineup, do the following in Google Sheets:
     1. Open your performances sheet.
     2. Make sure the columns match exactly (case-sensitive):
        name, address, lat, lng, start_time, end_time, style, description
        (lat/lng as decimal degrees; start_time/end_time in 24h "HH:MM".)
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
      description: (r.description || "").trim(),
      host: (r.host || "").trim(),
    }))
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng))
    .sort((a, b) => minutesFromHHMM(a.start_time) - minutesFromHHMM(b.start_time));
}

// Multiple acts at the same address collapse to a single pin; the popup then
// stacks the sets. Key by lat/lng rounded to 5dp (~1 m) so tiny typos in the
// sheet don't accidentally split a porch across two pins.
function groupByLocation(rows) {
  const groups = new Map();
  rows.forEach((row, i) => {
    const order = i + 1;
    const key = `${row.lat.toFixed(5)},${row.lng.toFixed(5)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        lat: row.lat,
        lng: row.lng,
        address: row.address,
        sets: [],
      });
    }
    groups.get(key).sets.push({ ...row, order, rowIndex: i });
  });
  return Array.from(groups.values());
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
      <circle cx="28" cy="7" r="6" fill="#9e4429" stroke="#f6efe2" stroke-width="1.5"/>
      <text x="28" y="7.5" text-anchor="middle" dominant-baseline="central"
            font-family="Fraunces, Georgia, serif" font-weight="700"
            font-size="7" fill="#f6efe2">+${stackSize - 1}</text>
    </g>` : "";
  const svg = `
    <svg class="porch-pin" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 1.5 C8 1.5 1.5 8.5 1.5 17 C1.5 27.5 17 42.5 17 42.5 C17 42.5 32.5 27.5 32.5 17 C32.5 8.5 26 1.5 17 1.5 Z"
            fill="currentColor" stroke="#9e4429" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="17" cy="16.5" r="7" fill="#f6efe2"/>
      <text x="17" y="17" text-anchor="middle" dominant-baseline="central"
            font-family="Fraunces, Georgia, serif" font-weight="600"
            font-size="${fontSize}" fill="#9e4429">${escapeHTML(text)}</text>
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

// Inner block shared by single-set and stacked popups.
function popupItemInner(row) {
  const eyebrow = `Set ${row.order} · ${timeRange(row.start_time, row.end_time)}`;
  const hostLine = row.host
    ? `<br/><span class="hosted-by">Hosted by ${escapeHTML(row.host)}</span>`
    : "";
  return `
    <p class="popup-card__eyebrow">${escapeHTML(eyebrow)}</p>
    <h4>${escapeHTML(row.name)}</h4>
    <p class="meta">
      <strong>${escapeHTML(row.style || "Live music")}</strong><br/>
      ${escapeHTML(row.address)}${hostLine}
    </p>
    <p class="blurb">${escapeHTML(row.description)}</p>
  `;
}

function groupPopupHTML(group) {
  if (group.sets.length === 1) {
    return `<div class="popup-card">${popupItemInner(group.sets[0])}</div>`;
  }
  const items = group.sets
    .map((s) => `<div class="popup-item">${popupItemInner(s)}</div>`)
    .join('<hr class="popup-divider"/>');
  return `
    <div class="popup-card popup-card--stacked">
      <div class="popup-stack-header">
        <p class="popup-card__eyebrow">This porch</p>
        <p class="popup-stack-title">${group.sets.length} sets &middot; ${escapeHTML(group.address)}</p>
      </div>
      ${items}
    </div>
  `;
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
    const firstOrder = group.sets[0].order;
    const altParts = group.sets
      .map((s) => `Set ${s.order} ${s.name}`)
      .join(", ");
    const m = L.marker([group.lat, group.lng], {
      icon: makePorchIcon(firstOrder, group.sets.length),
      alt: `${group.address} — ${altParts}`,
      keyboard: true,
      riseOnHover: true,
    }).addTo(map);

    m.bindPopup(groupPopupHTML(group), {
      closeButton: true,
      autoPanPadding: [24, 24],
      maxWidth: group.sets.length > 1 ? 320 : 280,
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
      `${row.name}, ${row.style || "music"}, ${timeRange(row.start_time, row.end_time)} at ${row.address}. Activate to show on map.`
    );

    tr.innerHTML = `
      <td class="time">${escapeHTML(timeRange(row.start_time, row.end_time))}</td>
      <td class="location">${escapeHTML(row.address)}</td>
      <td class="band">${escapeHTML(row.name)}</td>
      <td class="style">${row.style ? `<span>${escapeHTML(row.style)}</span>` : ""}</td>
    `;

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
