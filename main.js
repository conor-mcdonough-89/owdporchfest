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
    }))
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng))
    .sort((a, b) => minutesFromHHMM(a.start_time) - minutesFromHHMM(b.start_time));
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
// stays crisp on any screen. One filled teardrop + an inner dot.
function makePorchIcon() {
  const svg = `
    <svg class="porch-pin" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 1.5 C8 1.5 1.5 8.5 1.5 17 C1.5 27.5 17 42.5 17 42.5 C17 42.5 32.5 27.5 32.5 17 C32.5 8.5 26 1.5 17 1.5 Z"
            fill="currentColor" stroke="#9e4429" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="17" cy="16.5" r="5" fill="#f6efe2"/>
    </svg>`;
  return L.divIcon({
    className: "porch-pin-wrap",
    html: svg,
    iconSize: [34, 44],
    iconAnchor: [17, 42],
    popupAnchor: [0, -36],
  });
}

function popupHTML(row) {
  return `
    <div class="popup-card">
      <p class="popup-card__eyebrow">${escapeHTML(timeRange(row.start_time, row.end_time))}</p>
      <h4>${escapeHTML(row.name)}</h4>
      <p class="meta">
        <strong>${escapeHTML(row.style || "Live music")}</strong><br/>
        ${escapeHTML(row.address)}
      </p>
      <p class="blurb">${escapeHTML(row.description)}</p>
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

  const icon = makePorchIcon();
  const markers = {};
  const bounds = [];

  rows.forEach((row, i) => {
    const m = L.marker([row.lat, row.lng], {
      icon,
      alt: `${row.name} — ${row.style || "performance"} at ${row.address}`,
      keyboard: true,
      riseOnHover: true,
    }).addTo(map);

    m.bindPopup(popupHTML(row), {
      closeButton: true,
      autoPanPadding: [24, 24],
      maxWidth: 280,
    });

    // Light up the corresponding schedule row when a marker is focused/opened.
    m.on("popupopen", () => highlightScheduleRow(i, false));
    m.on("popupclose", () => highlightScheduleRow(-1, false));

    markers[i] = m;
    bounds.push([row.lat, row.lng]);
  });

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  }

  return { map, markers };
}

/* ---------- schedule ---------- */

let mapInstance = null;
let markerIndex = {};
let rowEls = [];

function highlightScheduleRow(activeIdx, scroll = false) {
  rowEls.forEach((el, i) => {
    if (i === activeIdx) {
      el.classList.add("is-active");
      if (scroll) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      el.classList.remove("is-active");
    }
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
      highlightScheduleRow(i, false);
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
    status.textContent = `${rows.length} porches on the program, sorted by start time.`;
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
