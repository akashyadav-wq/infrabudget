// Live sync with the "Summary NCR" tab of the reference Google Sheet.
// Works because the sheet is shared as "Anyone with the link — Viewer";
// Google's gviz CSV export endpoint allows cross-origin GET requests, so we
// can fetch it directly from the browser with no backend/server needed.

const SHEET_ID = "1vy5tEtQcKWiHitelbyEpM_pNdM42-F8cxyuQDcBBfYc";
const SHEET_TAB = "Summary NCR";
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;

const SPENT_TAB = "Spent";
const SPENT_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SPENT_TAB)}`;

const LIVE_CACHE_KEY = "infraBudgetLiveData_v1";
const SPENT_CACHE_KEY = "infraBudgetSpentDetail_v1";

// Column indices in the "Summary NCR" sheet (0-based).
// Each category now has 3 columns: Est. cost/room, Final cost/room, Spent/room.
const COL = {
  NAME: 0,
  BRICKS_EST: 1, BRICKS_FINAL: 2, BRICKS_SPENT: 3,
  WOODEN_EST: 4, WOODEN_FINAL: 5, WOODEN_SPENT: 6,
  ELECTRICAL_EST: 7, ELECTRICAL_FINAL: 8, ELECTRICAL_SPENT: 9,
  WINDOW_EST: 10, WINDOW_FINAL: 11, WINDOW_SPENT: 12,
  DIRECT_EST: 13, DIRECT_FINAL: 14, DIRECT_SPENT: 15,
  COST_PER_ROOM_EST: 16,
  COST_PER_ROOM_FINAL: 17,
  COST_PER_ROOM_SPENT: 18,
  TOTAL_ROOMS: 19,
  TOTAL_CLASSROOM_COST: 20,
  CORRIDOR_COST: 21,
  TOTAL_ESTIMATED_PROJECT_COST: 22,
  ALREADY_ITEM_COST: 23,
  FINAL_PROJECT_COST: 24,
  VARIANCE: 25,
};

// "Spent" values in the sheet are per-classroom (same basis as Est/Final) —
// multiply by a type's room count to get the total spent for that category.
const CATEGORY_COLUMN_PAIRS = [
  ["Bricks / Wall Paint / Flooring / Tile", COL.BRICKS_EST, COL.BRICKS_FINAL, COL.BRICKS_SPENT],
  ["Wooden Work (Desk, Door, Laminate, Pelmet)", COL.WOODEN_EST, COL.WOODEN_FINAL, COL.WOODEN_SPENT],
  ["Electrical Wiring", COL.ELECTRICAL_EST, COL.ELECTRICAL_FINAL, COL.ELECTRICAL_SPENT],
  ["Window / Faculty Chair / Blinds", COL.WINDOW_EST, COL.WINDOW_FINAL, COL.WINDOW_SPENT],
  ["Direct Purchase Item (Electrical Gadget)", COL.DIRECT_EST, COL.DIRECT_FINAL, COL.DIRECT_SPENT],
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
  CATEGORY_COLUMN_PAIRS.forEach(([label, estCol, finalCol, spentCol]) => {
    categories[label] = { est: money(cells[estCol]), final: money(cells[finalCol]), spent: money(cells[spentCol]) };
  });
  return {
    name,
    rooms: intVal(cells[COL.TOTAL_ROOMS]) || 1,
    costPerClassroomEst: money(cells[COL.COST_PER_ROOM_EST]),
    costPerClassroomFinal: money(cells[COL.COST_PER_ROOM_FINAL]),
    costPerClassroomSpent: money(cells[COL.COST_PER_ROOM_SPENT]),
    alreadyItemCost: money(cells[COL.ALREADY_ITEM_COST]),
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
      // "Already item of this cost" sometimes sits on the campus header row
      // (e.g. HITECH), sometimes on a classroom-type row (e.g. IITM Tech) —
      // add up wherever the sheet has it, per-campus.
      alreadyItemCost: money(headerRow[COL.ALREADY_ITEM_COST]) + types.reduce((s, t) => s + (t.alreadyItemCost || 0), 0),
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

// ---------- "Spent" tab: item-level payment breakdown, per campus ----------
//
// Sheet layout: repeating blocks, one per campus —
//   <Campus Name>, "Iteam", "Total Amount", "Amount Paid", "Remaining", "% Payment Done", "Remarks"   <- block header
//   <Category or blank>, <Item>, <total>, <paid>, <remaining>, <pct>, <remarks>                        <- line items
//   ...
//   "Gross", "", <total>, <paid>, <remaining>                                                          <- block footer
//
// Category (col 0) is only filled on the first item of each category group;
// blank cells belong to the most recent category above them.

function parsePercent(cell, total, paid) {
  const raw = String(cell || "").replace("%", "").trim();
  const n = parseFloat(raw);
  if (!isNaN(n)) return n;
  return total > 0 ? (paid / total) * 100 : 0;
}

function buildSpentBlocksFromRows(rows) {
  const blocks = [];
  let current = null;
  let lastCategory = "";

  rows.forEach((r) => {
    const col0 = (r[0] || "").trim();
    const col1 = (r[1] || "").trim();

    if (normalizeName(col1) === "ITEAM") {
      current = { campus: col0 || "Untitled", items: [], gross: null };
      blocks.push(current);
      lastCategory = "";
      return;
    }
    if (!current) return;

    if (normalizeName(col0) === "GROSS") {
      current.gross = { total: money(r[2]), paid: money(r[3]), remaining: money(r[4]) };
      current = null;
      return;
    }

    const item = col1;
    if (!item) return;
    if (col0) lastCategory = col0;
    const total = money(r[2]);
    const paid = money(r[3]);
    current.items.push({
      category: lastCategory,
      item,
      total,
      paid,
      remaining: r[4] !== undefined && r[4] !== "" ? money(r[4]) : total - paid,
      pct: parsePercent(r[5], total, paid),
      remarks: (r[6] || "").trim(),
    });
  });

  // Disambiguate blocks that share the same campus label (e.g. two "IITM" blocks).
  const seen = {};
  blocks.forEach((b) => {
    seen[b.campus] = (seen[b.campus] || 0) + 1;
  });
  const counters = {};
  blocks.forEach((b) => {
    if (seen[b.campus] > 1) {
      counters[b.campus] = (counters[b.campus] || 0) + 1;
      b.displayName = `${b.campus} (${counters[b.campus]})`;
    } else {
      b.displayName = b.campus;
    }
  });

  return blocks;
}

async function fetchSpentDetail() {
  const res = await fetch(SPENT_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  const rows = parseCSV(text);
  const blocks = buildSpentBlocksFromRows(rows);
  localStorage.setItem(SPENT_CACHE_KEY, JSON.stringify({ blocks, syncedAt: Date.now() }));
  return { blocks, syncedAt: Date.now() };
}

function getCachedSpentDetail() {
  try {
    const cached = JSON.parse(localStorage.getItem(SPENT_CACHE_KEY));
    if (cached && cached.blocks) return cached;
  } catch (e) {}
  return null;
}
