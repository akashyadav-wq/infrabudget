// Infra Budget Dashboard — vanilla JS, no build step, no external dependencies.
// Budget data is fetched live from the Google Sheet (see sheet.js). Daily expense
// entries are a separate log that persists in this browser via localStorage.

// A vibrant, LED/neon-inspired palette — reads as a modern control-room
// dashboard rather than flat corporate pastels, while staying legible.
const CATEGORY_COLORS = {
  "Bricks / Wall Paint / Flooring / Tile": "#ff3864",
  "Wooden Work (Desk, Door, Laminate, Pelmet)": "#ffc93c",
  "Electrical Wiring": "#00e6c3",
  "Window / Faculty Chair / Blinds": "#4e7cff",
  "Direct Purchase Item (Electrical Gadget)": "#a259ff",
  "Corridor / Stair Branding & Other": "#94a3b8",
};

const CAMPUS_COLORS = {
  HITECH: "#ff3864",
  IITM: "#4e7cff",
  NGF: "#00e6c3",
};

const LS_KEY = "infraBudgetExpenses_v1";
const AUTO_REFRESH_MS = 60000;

let DATA = SEED_DATA_FALLBACK;
let SPENT_DETAIL = [];

function formatINR(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "₹" + Math.abs(Math.round(n)).toLocaleString("en-IN");
}

// Animates an element's number counting up from a start value to an end
// value, so figures "run" into place instead of snapping instantly.
// alwaysFromZero=true (used for elements that are freshly created each
// render, e.g. inside innerHTML-rebuilt cards) makes it count up from 0
// every single time, so the animation plays on every page open/refresh.
function animateNumber(el, endValue, formatFn = formatINR, opts = {}) {
  const { duration = 900, alwaysFromZero = false } = opts;
  const startValue = alwaysFromZero ? 0 : Number(el.dataset.rawValue || 0);
  el.dataset.rawValue = endValue;
  if (!alwaysFromZero && startValue === endValue) {
    el.textContent = formatFn(endValue);
    return;
  }
  el.classList.remove("value-flash");
  void el.offsetWidth; // restart the flash animation
  el.classList.add("value-flash");

  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = startValue + (endValue - startValue) * eased;
    el.textContent = formatFn(current);
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = formatFn(endValue);
  }
  requestAnimationFrame(tick);
}

// Scans a freshly-rendered container for [data-final] placeholders and
// animates each one counting up from 0 — used for donut totals, legend
// values, and campus cards, which are rebuilt (not mutated) on every render.
function activateNumberAnimations(container) {
  container.querySelectorAll("[data-final]").forEach((el) => {
    const finalValue = parseFloat(el.dataset.final);
    const formatFn = el.dataset.format === "int" ? (n) => Math.round(n).toString() : formatINR;
    animateNumber(el, finalValue, formatFn, { alwaysFromZero: true, duration: el.dataset.duration ? Number(el.dataset.duration) : 900 });
  });
}

function loadExpenses() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveExpenses(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

// ---------- Derived data from DATA ----------

function getAllCategories() {
  return Object.keys(CATEGORY_COLORS).filter((c) => c !== "Corridor / Stair Branding & Other");
}

const DIRECT_PURCHASE_CATEGORY = "Direct Purchase Item (Electrical Gadget)";

function computeCategoryTotals() {
  const totals = {};
  getAllCategories().forEach((c) => (totals[c] = 0));
  DATA.campuses.forEach((campus) => {
    campus.types.forEach((type) => {
      Object.entries(type.categories).forEach(([cat, val]) => {
        if (totals[cat] === undefined) return;
        totals[cat] += val.final * type.rooms;
      });
    });
  });

  // "Already item of this cost" (items already on hand) reduces how much
  // Direct Purchase actually needed to spend — not the corridor/branding cost.
  const alreadyItemSum = DATA.campuses.reduce((s, c) => s + (c.alreadyItemCost || 0), 0);
  totals[DIRECT_PURCHASE_CATEGORY] = Math.max(0, totals[DIRECT_PURCHASE_CATEGORY] - alreadyItemSum);

  const categorySum = Object.values(totals).reduce((a, b) => a + b, 0);
  const other = Math.max(0, DATA.grandTotal.finalProjectCost - categorySum);
  totals["Corridor / Stair Branding & Other"] = other;
  return totals;
}

function computeCampusTotals() {
  const totals = {};
  DATA.campuses.forEach((c) => {
    totals[c.name] = c.finalProjectCost;
  });
  return totals;
}

// ---------- Spent, aggregated live from the Google Sheet's "Spent" tab ----------
// (item-level payment log) rather than Summary NCR's own Spent columns —
// the "Spent" tab is the actual source of truth the site records payments in.

// Groups a Spent-tab line item's category label into the same 5 buckets
// Summary NCR uses, so category totals line up across both tabs.
function mapSpentCategoryToSummaryCategory(rawCategory) {
  const n = normalizeName(rawCategory);
  if (n.includes("DIRECT PURCHASE")) return "Direct Purchase Item (Electrical Gadget)";
  if (n.includes("CIVIL")) return "Bricks / Wall Paint / Flooring / Tile";
  if (n.includes("WOODEN")) return "Wooden Work (Desk, Door, Laminate, Pelmet)";
  if (n.includes("INTERIOR") || n.includes("FURNITURE")) return "Window / Faculty Chair / Blinds";
  if (n.includes("ELECTRICAL")) return "Electrical Wiring";
  return null;
}

function computeSheetSpentByCategory() {
  const totals = {};
  getAllCategories().forEach((c) => (totals[c] = 0));
  SPENT_DETAIL.forEach((block) => {
    block.items.forEach((it) => {
      const cat = mapSpentCategoryToSummaryCategory(it.category);
      if (cat && totals[cat] !== undefined) totals[cat] += it.paid;
    });
  });
  return totals;
}

function computeSheetSpentByCampus() {
  const totals = {};
  DATA.campuses.forEach((c) => (totals[c.name] = 0));
  SPENT_DETAIL.forEach((block) => {
    const key = normalizeName(block.campus);
    const campus = DATA.campuses.find((c) => normalizeName(c.name) === key || key.includes(normalizeName(c.name)));
    if (!campus) return;
    const blockPaid = block.items.reduce((s, it) => s + it.paid, 0);
    totals[campus.name] += blockPaid;
  });
  return totals;
}

function computeSheetSpentTotal() {
  return SPENT_DETAIL.reduce((sum, block) => sum + block.items.reduce((s, it) => s + it.paid, 0), 0);
}

// ---------- Donut chart (pure CSS conic-gradient) ----------

function renderDonut(container, data, opts = {}) {
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  let angleStart = 0;
  const stops = data
    .map((d) => {
      const angleEnd = angleStart + (d.value / total) * 360;
      const stop = `${d.color} ${angleStart}deg ${angleEnd}deg`;
      angleStart = angleEnd;
      return stop;
    })
    .join(", ");

  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";

  const donut = document.createElement("div");
  donut.className = "donut";
  donut.style.background = `conic-gradient(${stops})`;

  const center = document.createElement("div");
  center.className = "donut-center";
  center.innerHTML = `<div class="donut-total" data-final="${total}">₹0</div><div class="donut-total-label">${opts.centerLabel || "Total"}</div>`;
  donut.appendChild(center);
  wrap.appendChild(donut);

  const legend = document.createElement("div");
  legend.className = "legend";
  data
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .forEach((d) => {
      const pct = ((d.value / total) * 100).toFixed(1);
      const row = document.createElement("div");
      row.className = "legend-row";
      row.innerHTML = `
        <span class="legend-dot" style="background:${d.color}; box-shadow: 0 0 8px ${d.color}"></span>
        <span class="legend-label">${d.label}</span>
        <span class="legend-value" data-final="${d.value}">₹0</span>
        <span class="legend-pct">${pct}%</span>
      `;
      legend.appendChild(row);
    });
  wrap.appendChild(legend);

  container.innerHTML = "";
  container.appendChild(wrap);
  activateNumberAnimations(container);
}

// ---------- Campus / classroom breakdown cards ----------

function renderCampusCards(container) {
  container.innerHTML = "";
  DATA.campuses.forEach((campus) => {
    const spentByThisCampus = computeCombinedSpent().byCampus[campus.name] || 0;
    const pctUsed = Math.min(100, (spentByThisCampus / campus.totalEstimated) * 100);
    const variance = campus.totalEstimated - campus.finalProjectCost;

    const card = document.createElement("div");
    card.className = "campus-card";
    const campusColor = CAMPUS_COLORS[campus.name] || "#999";
    card.innerHTML = `
      <div class="campus-card-header">
        <span class="campus-dot" style="background:${campusColor}; box-shadow: 0 0 10px ${campusColor}, 0 0 2px ${campusColor}"></span>
        <h3>${campus.name}</h3>
        <span class="campus-rooms">${campus.totalRooms} classrooms</span>
      </div>
      <div class="campus-stats">
        <div><span class="stat-label">Estimated Budget</span><span class="stat-value" data-final="${campus.totalEstimated}">₹0</span></div>
        <div><span class="stat-label">BOQ Final Cost</span><span class="stat-value" data-final="${campus.finalProjectCost}">₹0</span></div>
        <div><span class="stat-label">Variance</span><span class="stat-value ${variance >= 0 ? "pos" : "neg"}" data-final="${variance}">₹0</span></div>
        <div class="clickable spend-cell" data-campus-click="${campus.name}" title="Click to see item-wise payment breakdown"><span class="stat-label">Total Spend <span class="click-hint">🔍</span></span><span class="stat-value" data-final="${spentByThisCampus}">₹0</span></div>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:0%; background:linear-gradient(90deg, ${campusColor}, ${campusColor}cc); box-shadow: 0 0 8px ${campusColor}88" data-final-width="${pctUsed}"></div>
      </div>
      <div class="progress-caption">${pctUsed.toFixed(1)}% of estimated budget spent</div>
      <button class="toggle-btn" type="button">Show classroom-type breakdown ▾</button>
      <div class="campus-detail" hidden></div>
    `;

    const detail = card.querySelector(".campus-detail");
    detail.innerHTML = campus.types
      .map((type) => {
        const rows = Object.entries(type.categories)
          .map(
            ([cat, val]) => `
            <tr>
              <td>${cat}</td>
              <td>${formatINR(val.est)}</td>
              <td>${formatINR(val.final)}</td>
              <td>${formatINR(val.spent || 0)}</td>
              <td>${formatINR((val.spent || 0) * type.rooms)}</td>
            </tr>`
          )
          .join("");
        return `
          <div class="type-block">
            <div class="type-block-header">
              <strong>${type.name}</strong> — ${type.rooms} rooms
              <span>Final cost/room: ${formatINR(type.costPerClassroomFinal)}</span>
            </div>
            <div class="table-scroll">
            <table class="cat-table">
              <thead><tr><th>Category</th><th>Est. cost/room</th><th>Final cost/room</th><th>Spent/room</th><th>Total spent</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            </div>
          </div>`;
      })
      .join("");

    const btn = card.querySelector(".toggle-btn");
    btn.addEventListener("click", () => {
      const hidden = detail.hasAttribute("hidden");
      if (hidden) {
        detail.removeAttribute("hidden");
        btn.textContent = "Hide classroom-type breakdown ▴";
      } else {
        detail.setAttribute("hidden", "");
        btn.textContent = "Show classroom-type breakdown ▾";
      }
    });

    card.querySelector(".spend-cell").addEventListener("click", () => openSpentModal(campus.name));

    container.appendChild(card);
    activateNumberAnimations(card);

    const fill = card.querySelector(".progress-fill");
    const targetWidth = fill.dataset.finalWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = targetWidth + "%"; }));
  });
}

// ---------- Expense log (manual, local-only entries) ----------

function computeLocalSpent() {
  const expenses = loadExpenses();
  const byCampus = {};
  const byCategory = {};
  let total = 0;
  expenses.forEach((e) => {
    total += e.amount;
    byCampus[e.campus] = (byCampus[e.campus] || 0) + e.amount;
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  });
  return { total, byCampus, byCategory, expenses };
}

// Combines the live "Spent" columns from the Google Sheet with any manual
// entries logged locally (for spend that hasn't made it into the sheet yet).
function computeCombinedSpent() {
  const sheetByCampus = computeSheetSpentByCampus();
  const sheetByCategory = computeSheetSpentByCategory();
  const local = computeLocalSpent();

  const byCampus = { ...sheetByCampus };
  Object.entries(local.byCampus).forEach(([k, v]) => (byCampus[k] = (byCampus[k] || 0) + v));

  const byCategory = { ...sheetByCategory };
  Object.entries(local.byCategory).forEach(([k, v]) => (byCategory[k] = (byCategory[k] || 0) + v));

  return { total: computeSheetSpentTotal() + local.total, byCampus, byCategory };
}

function populateFormSelects() {
  const campusSelect = document.getElementById("exp-campus");
  const typeSelect = document.getElementById("exp-type");
  const categorySelect = document.getElementById("exp-category");

  const prevCampus = campusSelect.value;
  campusSelect.innerHTML = DATA.campuses.map((c) => `<option value="${c.name}">${c.name}</option>`).join("");
  if (DATA.campuses.some((c) => c.name === prevCampus)) campusSelect.value = prevCampus;

  function refreshTypes() {
    const campus = DATA.campuses.find((c) => c.name === campusSelect.value) || DATA.campuses[0];
    typeSelect.innerHTML = campus.types.map((t) => `<option value="${t.name}">${t.name}</option>`).join("");
  }
  campusSelect.onchange = refreshTypes;
  refreshTypes();

  categorySelect.innerHTML = getAllCategories().map((c) => `<option value="${c}">${c}</option>`).join("");
}

function renderExpenseTable() {
  const tbody = document.querySelector("#expense-table tbody");
  const { expenses } = computeLocalSpent();
  const sorted = [...expenses].sort((a, b) => (a.date < b.date ? 1 : -1));

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Abhi tak koi kharcha entry nahi hui hai — neeche form se add karein.</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted
    .map(
      (e) => `
      <tr data-id="${e.id}">
        <td>${e.date}</td>
        <td>${e.campus}</td>
        <td>${e.type}</td>
        <td>${e.category}</td>
        <td>${formatINR(e.amount)}</td>
        <td>${e.note || ""}</td>
        <td><button class="delete-btn" data-id="${e.id}" title="Delete">✕</button></td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const remaining = loadExpenses().filter((e) => e.id !== id);
      saveExpenses(remaining);
      renderAll();
    });
  });
}

function renderTrendChart() {
  const container = document.getElementById("trend-chart");
  const { expenses } = computeLocalSpent();
  if (expenses.length === 0) {
    container.innerHTML = `<div class="empty-row">Trend yahan dikhega jaise hi aap expense entries add karenge.</div>`;
    return;
  }
  const byDate = {};
  expenses.forEach((e) => {
    byDate[e.date] = (byDate[e.date] || 0) + e.amount;
  });
  const dates = Object.keys(byDate).sort();
  let cumulative = 0;
  const points = dates.map((d) => {
    cumulative += byDate[d];
    return { date: d, daily: byDate[d], cumulative };
  });
  const max = Math.max(...points.map((p) => p.daily));

  container.innerHTML = `
    <div class="trend-bars">
      ${points
        .map((p) => {
          const h = Math.max(4, (p.daily / max) * 100);
          return `
          <div class="trend-bar-col">
            <div class="trend-bar" style="height:${h}%" title="${p.date}: ${formatINR(p.daily)}"></div>
            <div class="trend-bar-label">${p.date.slice(5)}</div>
          </div>`;
        })
        .join("")}
    </div>
    <div class="trend-caption">Cumulative logged so far: <strong>${formatINR(cumulative)}</strong></div>
  `;
}

function renderSummary() {
  const g = DATA.grandTotal;
  const spent = computeCombinedSpent().total;
  const remaining = g.totalEstimatedProjectCost - spent;

  document.getElementById("sum-variance").className = "stat-value " + (g.variance >= 0 ? "pos" : "neg");
  document.getElementById("sum-remaining").className = "stat-value " + (remaining >= 0 ? "pos" : "neg");

  animateNumber(document.getElementById("sum-estimated"), g.totalEstimatedProjectCost);
  animateNumber(document.getElementById("sum-final"), g.finalProjectCost);
  animateNumber(document.getElementById("sum-variance"), g.variance);
  animateNumber(document.getElementById("sum-rooms"), g.totalRooms, (n) => Math.round(n).toString());
  animateNumber(document.getElementById("sum-spent"), spent);
  animateNumber(document.getElementById("sum-remaining"), remaining);

  const pct = Math.min(100, (spent / g.totalEstimatedProjectCost) * 100);
  document.getElementById("overall-progress-fill").style.width = pct + "%";
  document.getElementById("overall-progress-caption").textContent =
    pct.toFixed(1) + "% of total estimated budget spent";
}

function renderNotes() {
  document.getElementById("notes-list").innerHTML = DATA.notes.map((n) => `<li>${n}</li>`).join("");
}

function renderAll() {
  renderSummary();
  renderNotes();

  const campusTotals = computeCampusTotals();
  renderDonut(
    document.getElementById("donut-campus"),
    Object.entries(campusTotals).map(([label, value]) => ({
      label,
      value,
      color: CAMPUS_COLORS[label] || "#999",
    })),
    { centerLabel: "BOQ Final Cost" }
  );

  const categoryTotals = computeCategoryTotals();
  renderDonut(
    document.getElementById("donut-category"),
    Object.entries(categoryTotals).map(([label, value]) => ({
      label,
      value,
      color: CATEGORY_COLORS[label] || "#999",
    })),
    { centerLabel: "BOQ Final Cost" }
  );

  const spent = computeCombinedSpent();
  const spentByCategoryData = getAllCategories().map((c) => ({
    label: c,
    value: spent.byCategory[c] || 0,
    color: CATEGORY_COLORS[c],
  }));
  if (spentByCategoryData.some((d) => d.value > 0)) {
    renderDonut(document.getElementById("donut-spent"), spentByCategoryData, { centerLabel: "Total Spend" });
  } else {
    document.getElementById("donut-spent").innerHTML =
      '<div class="empty-row">Sheet ke "Spent" column me ya neeche expense log me entry hote hi yahan dikhega.</div>';
  }

  renderCampusCards(document.getElementById("campus-cards"));
  populateFormSelects();
  renderExpenseTable();
  renderTrendChart();
}

// ---------- Live sync with Google Sheet ----------

function setSyncStatus(text, isError, isLive) {
  const el = document.getElementById("sync-status");
  el.innerHTML = (isLive ? '<span class="live-dot"></span>' : "") + text;
  el.className = "sync-status" + (isError ? " sync-error" : "");
}

async function syncFromSheet(isManual) {
  const btn = document.getElementById("sync-btn");
  if (btn) btn.disabled = true;
  setSyncStatus("🔄 Syncing from Google Sheet…", false, false);
  try {
    const { data, syncedAt } = await fetchLiveData();
    DATA = data;
    const time = new Date(syncedAt).toLocaleTimeString("en-IN");
    setSyncStatus(`Live — last synced ${time}`, false, true);
    renderAll();
  } catch (err) {
    const cached = getCachedLiveData();
    if (cached) {
      DATA = cached.data;
      const time = new Date(cached.syncedAt).toLocaleTimeString("en-IN");
      setSyncStatus(`⚠️ Sheet unreachable — showing cached data from ${time}`, true, false);
    } else {
      DATA = SEED_DATA_FALLBACK;
      setSyncStatus("⚠️ Sheet unreachable — showing built-in fallback data", true, false);
    }
    renderAll();
    if (isManual) console.error(err);
  } finally {
    if (btn) btn.disabled = false;
  }

  try {
    const { blocks } = await fetchSpentDetail();
    SPENT_DETAIL = blocks;
  } catch (err) {
    const cached = getCachedSpentDetail();
    SPENT_DETAIL = cached ? cached.blocks : [];
  }
  // Spent totals (summary cards, donut, campus cards) are derived from
  // SPENT_DETAIL, so re-render the whole dashboard once it's in, not just the modal.
  renderAll();
  if (!document.getElementById("spent-modal-overlay").hidden) renderSpentModalBody(currentModalCampusFilter);
}

// ---------- Payment breakdown modal (from the Sheet's "Spent" tab) ----------

let currentModalCampusFilter = null;

function blockMatchesCampus(block, campusFilter) {
  if (!campusFilter) return true;
  return normalizeName(block.campus) === normalizeName(campusFilter) || normalizeName(block.campus).includes(normalizeName(campusFilter));
}

function pctColorClass(pct) {
  if (pct >= 100) return "pos";
  if (pct <= 0) return "neg";
  return "warn";
}

// Conditional-formatting bucket for a line item, based on % paid — drives
// both the row tint and the badge shown in the % Paid column.
function paymentStatus(pct) {
  if (pct >= 100) return { rowClass: "row-status-full", label: "✅ Paid" };
  if (pct > 0) return { rowClass: "row-status-partial", label: "🟡 Partial" };
  return { rowClass: "row-status-none", label: "🔴 Unpaid" };
}

function renderSpentModalBody(campusFilter) {
  const body = document.getElementById("spent-modal-body");
  const title = document.getElementById("spent-modal-title");
  try {
    title.textContent = campusFilter ? `💸 Payment Breakdown — ${campusFilter}` : "💸 Payment Breakdown — All Campuses";
    renderSpentModalBodyInner(body, campusFilter);
  } catch (err) {
    body.innerHTML = `<div class="empty-row">Kuch gadbad ho gayi breakdown load karte waqt. "🔄 Refresh now" try kijiye, ya thodi der baad phir kholiye.<br><small>${(err && err.message) || err}</small></div>`;
  }
}

function renderSpentModalBodyInner(body, campusFilter) {
  const blocks = SPENT_DETAIL.filter((b) => blockMatchesCampus(b, campusFilter));

  if (!blocks.length) {
    body.innerHTML = `<div class="empty-row">Is campus ke liye "Spent" tab me abhi koi item-wise data nahi mila (ya sheet abhi load ho rahi hai). "🔄 Refresh now" try kijiye.</div>`;
    return;
  }

  body.innerHTML = blocks
    .map((block) => {
      const gross = block.gross || {
        total: block.items.reduce((s, i) => s + i.total, 0),
        paid: block.items.reduce((s, i) => s + i.paid, 0),
        remaining: block.items.reduce((s, i) => s + i.remaining, 0),
      };
      const grossPct = gross.total > 0 ? (gross.paid / gross.total) * 100 : 0;

      const rows = block.items
        .map((it) => {
          const status = paymentStatus(it.pct);
          return `
          <tr class="${status.rowClass}">
            <td>${it.category}</td>
            <td>${it.item}</td>
            <td>${formatINR(it.total)}</td>
            <td class="${it.paid > 0 ? "pos" : ""}">${formatINR(it.paid)}</td>
            <td class="${it.remaining > 0 ? "neg" : "pos"}">${formatINR(it.remaining)}</td>
            <td class="pct-cell ${pctColorClass(it.pct)}">
              <div class="pct-bar-track"><div class="pct-bar-fill" style="width:${Math.min(100, Math.max(0, it.pct))}%"></div></div>
              <span class="pct-badge">${status.label} · ${it.pct.toFixed(1)}%</span>
            </td>
            <td>${it.remarks || ""}</td>
          </tr>`;
        })
        .join("");

      return `
        <div class="spent-block">
          <div class="spent-block-header">
            <h3>${block.displayName}</h3>
            <div class="spent-block-gross">
              <span>Total: <strong>${formatINR(gross.total)}</strong></span>
              <span>Paid: <strong class="pos">${formatINR(gross.paid)}</strong></span>
              <span>Remaining: <strong class="neg">${formatINR(gross.remaining)}</strong></span>
              <span>${grossPct.toFixed(1)}% paid</span>
            </div>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${Math.min(100, grossPct)}%"></div>
          </div>
          <div class="table-scroll">
            <table class="cat-table spent-table">
              <thead><tr><th>Category</th><th>Item</th><th>Total</th><th>Paid</th><th>Remaining</th><th>% Paid</th><th>Remarks</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    })
    .join("");
}

function openSpentModal(campusFilter) {
  currentModalCampusFilter = campusFilter || null;
  renderSpentModalBody(currentModalCampusFilter);
  document.getElementById("spent-modal-overlay").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSpentModal() {
  document.getElementById("spent-modal-overlay").hidden = true;
  document.body.style.overflow = "";
}

// ---------- Init ----------

document.addEventListener("DOMContentLoaded", () => {
  // Modal close/escape/backdrop wiring goes FIRST and unconditionally, so the
  // popup can always be dismissed even if something else below throws.
  document.getElementById("spent-modal-close").addEventListener("click", closeSpentModal);
  document.getElementById("spent-modal-overlay").addEventListener("click", (evt) => {
    if (evt.target.id === "spent-modal-overlay") closeSpentModal();
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && !document.getElementById("spent-modal-overlay").hidden) closeSpentModal();
  });
  document.getElementById("sum-spent-card").addEventListener("click", () => openSpentModal(null));
  document.getElementById("donut-spent-card").addEventListener("click", () => openSpentModal(null));

  const cached = getCachedLiveData();
  if (cached) DATA = cached.data;

  const cachedSpent = getCachedSpentDetail();
  if (cachedSpent) SPENT_DETAIL = cachedSpent.blocks;

  populateFormSelects();

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("exp-date").value = today;

  document.getElementById("expense-form").addEventListener("submit", (evt) => {
    evt.preventDefault();
    const amount = parseFloat(document.getElementById("exp-amount").value);
    if (!amount || amount <= 0) return;

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      date: document.getElementById("exp-date").value,
      campus: document.getElementById("exp-campus").value,
      type: document.getElementById("exp-type").value,
      category: document.getElementById("exp-category").value,
      amount,
      note: document.getElementById("exp-note").value.trim(),
    };
    const list = loadExpenses();
    list.push(entry);
    saveExpenses(list);
    evt.target.reset();
    document.getElementById("exp-date").value = today;
    renderAll();
  });

  document.getElementById("sync-btn").addEventListener("click", () => syncFromSheet(true));

  const themeBtn = document.getElementById("theme-toggle");
  function applyThemeIcon() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    themeBtn.textContent = isDark ? "☀️" : "🌙";
  }
  applyThemeIcon();
  themeBtn.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("infraBudgetTheme", next);
    applyThemeIcon();
  });

  renderAll();
  syncFromSheet(false);
  setInterval(() => syncFromSheet(false), AUTO_REFRESH_MS);
});
