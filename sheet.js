// Live sync with the "Summary NCR" tab of the reference Google Sheet.
// Works because the sheet is shared as "Anyone with the link — Viewer";
// Google's gviz CSV export endpoint allows cross-origin GET requests, so we
// can fetch it directly from the browser with no backend/server needed.

const SHEET_ID = "1vy5tEtQcKWiHitelbyEpM_pNdM42-F8cxyuQDcBBfYc";
const SHEET_TAB = "Summary NCR";
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;

const LIVE_CACHE_KEY = "infraBudgetLiveData_v1";

// Column indices in the "Summary NCR" sheet (0-based).
const COL = {
  NAME: 0,
  BRICKS_EST: 1, BRICKS_FINAL: 2,
  WOODEN_EST: 3, WOODEN_FINAL: 4,
  ELECTRICAL_EST: 5, ELECTRICAL_FINAL: 6,
  WINDOW_EST: 7, WINDOW_FINAL: 8,
  DIRECT_EST: 9, DIRECT_FINAL: 10,
  COST_PER_ROOM_EST: 11,
  COST_PER_ROOM_FINAL: 12,
  TOTAL_ROOMS: 13,
  TOTAL_CLASSROOM_COST: 14,
  CORRIDOR_COST: 15,
  TOTAL_ESTIMATED_PROJECT_COST: 16,
  ALREADY_ITEM_COST: 17,
  FINAL_PROJECT_COST: 18,
  VARIANCE: 19,
};

const CATEGORY_COLUMN_PAIRS = [
  ["Bricks / Wall Paint / Flooring / Tile", COL.BRICKS_EST, COL.BRICKS_FINAL],
  ["Wooden Work (Desk, Door, Laminate, Pelmet)", COL.WOODEN_EST, COL.WOODEN_FINAL],
  ["Electrical Wiring", COL.ELECTRICAL_EST, COL.ELECTRICAL_FINAL],
  ["Window / Faculty Chair / Blinds", COL.WINDOW_EST, COL.WINDOW_FINAL],
  ["Direct Purchase Item (Electrical Gadget)", COL.DIRECT_EST, COL.DIRECT_FINAL],
];

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function normalizeName(s) {
  return (s || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function money(cell) {
  if (!cell) return 0;
  const cleaned = String(cell).replace(/[₹,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function intVal(cell) {
  return Math.round(money(cell));
}

function buildType(name, cells) {
  const categories = {};
  CATEGORY_COLUMN_PAIRS.forEach(([label, estCol, finalCol]) => {
    categories[label] = { est: money(cells[estCol]), final: money(cells[finalCol]) };
  });
  return {
    name,
    rooms: intVal(cells[COL.TOTAL_ROOMS]) || 1,
    costPerClassroomEst: money(cells[COL.COST_PER_ROOM_EST]),
    costPerClassroomFinal: money(cells[COL.COST_PER_ROOM_FINAL]),
    categories,
  };
}

// Maps normalized sheet row-name -> where it belongs in the output structure.
// If the sheet's row names ever change, update this table to match.
const CAMPUS_SCHEMA = [
  { key: "HITECH", childKeys: ["NON-STEP CLASSROOM", "STEP CLASSROOM"], childNames: ["Non-step Classroom", "Step Classroom"] },
  { key: "IITM", childKeys: ["IITM TECH", "IITM MANAGEMENT"], childNames: ["IITM Tech", "IITM Management"] },
  { key: "NGF", childKeys: ["NGF"], childNames: ["NGF Classroom"] },
];

function buildDataFromRows(rows) {
  const rowMap = {};
  rows.slice(1).forEach((r) => {
    const key = normalizeName(r[COL.NAME]);
    if (key) rowMap[key] = r;
  });

  const campuses = CAMPUS_SCHEMA.map(({ key, childKeys, childNames }) => {
    const headerRow = rowMap[key];
    if (!headerRow) return null;
    const types = childKeys
      .map((ck, i) => (rowMap[ck] ? buildType(childNames[i], rowMap[ck]) : null))
      .filter(Boolean);
    return {
      name: key,
      totalEstimated: money(headerRow[COL.TOTAL_ESTIMATED_PROJECT_COST]) ||
        types.reduce((s, t) => s + Object.values(t.categories).reduce((a, c) => a + c.est, 0) * t.rooms, 0),
      finalProjectCost: money(headerRow[COL.FINAL_PROJECT_COST]),
      corridorCost: money(headerRow[COL.CORRIDOR_COST]),
      totalRooms: intVal(headerRow[COL.TOTAL_ROOMS]) || types.reduce((s, t) => s + t.rooms, 0),
      types,
    };
  }).filter(Boolean);

  const gTotalRow = rowMap["G TOTAL"];
  const grandTotal = gTotalRow
    ? {
        totalRooms: intVal(gTotalRow[COL.TOTAL_ROOMS]),
        totalEstimatedProjectCost: money(gTotalRow[COL.TOTAL_ESTIMATED_PROJECT_COST]),
        finalProjectCost: money(gTotalRow[COL.FINAL_PROJECT_COST]),
        variance: money(gTotalRow[COL.VARIANCE]),
      }
    : {
        totalRooms: campuses.reduce((s, c) => s + c.totalRooms, 0),
        totalEstimatedProjectCost: campuses.reduce((s, c) => s + c.totalEstimated, 0),
        finalProjectCost: campuses.reduce((s, c) => s + c.finalProjectCost, 0),
        variance: 0,
      };

  return { campuses, grandTotal, notes: SEED_DATA_FALLBACK.notes };
}

async function fetchLiveData() {
  const res = await fetch(SHEET_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  const rows = parseCSV(text);
  const data = buildDataFromRows(rows);
  if (!data.campuses.length) throw new Error("Sheet returned no recognizable rows");
  localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify({ data, syncedAt: Date.now() }));
  return { data, syncedAt: Date.now(), source: "live" };
}

function getCachedLiveData() {
  try {
    const cached = JSON.parse(localStorage.getItem(LIVE_CACHE_KEY));
    if (cached && cached.data) return { ...cached, source: "cache" };
  } catch (e) {}
  return null;
}
