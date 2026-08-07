// Infra Budget Dashboard — vanilla JS, no build step, no external dependencies.
// Budget data is fetched live from the Google Sheet (see sheet.js). Daily expense
// entries are a separate log that persists in this browser via localStorage.

const CATEGORY_COLORS = {
  "Bricks / Wall Paint / Flooring / Tile": "#e07a5f",
  "Wooden Work (Desk, Door, Laminate, Pelmet)": "#f2cc8f",
  "Electrical Wiring": "#81b29a",
  "Window / Faculty Chair / Blinds": "#3d5a80",
  "Direct Purchase Item (Electrical Gadget)": "#9381ff",
  "Corridor / Stair Branding & Other": "#adb5bd",
};

const CAMPUS_COLORS = {
  HITECH: "#e07a5f",
  IITM: "#3d5a80",
  NGF: "#81b29a",
};

const LS_KEY = "infraBudgetExpenses_v1";
const AUTO_REFRESH_MS = 60000;

let DATA = SEED_DATA_FALLBACK;

function formatINR(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "₹" + Math.abs(Math.round(n)).toLocaleString("en-IN");
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

// ---------- Spent, tracked live in the Google Sheet's "Spent" columns ----------

function computeSheetSpentByCategory() {
  const totals = {};
  getAllCategories().forEach((c) => (totals[c] = 0));
  DATA.campuses.forEach((campus) => {
    campus.types.forEach((type) => {
      Object.entries(type.categories).forEach(([cat, val]) => {
        if (totals[cat] === undefined) return;
        totals[cat] += (val.spent || 0) * type.rooms;
      });
    });
  });
  return totals;
}

function computeSheetSpentByCampus() {
  const totals = {};
  DATA.campuses.forEach((campus) => {
    totals[campus.name] = campus.types.reduce((sum, type) => {
      const typeSpent = Object.values(type.categories).reduce((s, v) => s + (v.spent || 0), 0) * type.rooms;
      return sum + typeSpent;
    }, 0);
  });
  return totals;
}

function computeSheetSpentTotal() {
  return Object.values(computeSheetSpentByCampus()).reduce((a, b) => a + b, 0);
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
  center.innerHTML = `<div class="donut-total">${formatINR(total)}</div><div class="donut-total-label">${opts.centerLabel || "Total"}</div>`;
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
        <span class="legend-dot" style="background:${d.color}"></span>
        <span class="legend-label">${d.label}</span>
        <span class="legend-value">${formatINR(d.value)}</span>
        <span class="legend-pct">${pct}%</span>
      `;
      legend.appendChild(row);
    });
  wrap.appendChild(legend);

  container.innerHTML = "";
  container.appendChild(wrap);
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
    card.innerHTML = `
      <div class="campus-card-header">
        <span class="campus-dot" style="background:${CAMPUS_COLORS[campus.name] || "#999"}"></span>
        <h3>${campus.name}</h3>
        <span class="campus-rooms">${campus.totalRooms} classrooms</span>
      </div>
      <div class="campus-stats">
        <div><span class="stat-label">Estimated Budget</span><span class="stat-value">${formatINR(campus.totalEstimated)}</span></div>
        <div><span class="stat-label">BOQ Final Cost</span><span class="stat-value">${formatINR(campus.finalProjectCost)}</span></div>
        <div><span class="stat-label">Variance</span><span class="stat-value ${variance >= 0 ? "pos" : "neg"}">${formatINR(variance)}</span></div>
        <div><span class="stat-label">Total Spend</span><span class="stat-value">${formatINR(spentByThisCampus)}</span></div>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${pctUsed}%; background:${CAMPUS_COLORS[campus.name] || "#999"}"></div>
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

    container.appendChild(card);
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

  document.getElementById("sum-estimated").textContent = formatINR(g.totalEstimatedProjectCost);
  document.getElementById("sum-final").textContent = formatINR(g.finalProjectCost);
  document.getElementById("sum-variance").textContent = formatINR(g.variance);
  document.getElementById("sum-variance").className = "stat-value " + (g.variance >= 0 ? "pos" : "neg");
  document.getElementById("sum-rooms").textContent = g.totalRooms;
  document.getElementById("sum-spent").textContent = formatINR(spent);
  document.getElementById("sum-remaining").textContent = formatINR(remaining);
  document.getElementById("sum-remaining").className = "stat-value " + (remaining >= 0 ? "pos" : "neg");

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

function setSyncStatus(text, isError) {
  const el = document.getElementById("sync-status");
  el.textContent = text;
  el.className = "sync-status" + (isError ? " sync-error" : "");
}

async function syncFromSheet(isManual) {
  const btn = document.getElementById("sync-btn");
  if (btn) btn.disabled = true;
  setSyncStatus("🔄 Syncing from Google Sheet…", false);
  try {
    const { data, syncedAt } = await fetchLiveData();
    DATA = data;
    const time = new Date(syncedAt).toLocaleTimeString("en-IN");
    setSyncStatus(`✅ Live — last synced ${time}`, false);
    renderAll();
  } catch (err) {
    const cached = getCachedLiveData();
    if (cached) {
      DATA = cached.data;
      const time = new Date(cached.syncedAt).toLocaleTimeString("en-IN");
      setSyncStatus(`⚠️ Sheet unreachable — showing cached data from ${time}`, true);
    } else {
      DATA = SEED_DATA_FALLBACK;
      setSyncStatus("⚠️ Sheet unreachable — showing built-in fallback data", true);
    }
    renderAll();
    if (isManual) console.error(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- Init ----------

document.addEventListener("DOMContentLoaded", () => {
  const cached = getCachedLiveData();
  if (cached) DATA = cached.data;

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

  renderAll();
  syncFromSheet(false);
  setInterval(() => syncFromSheet(false), AUTO_REFRESH_MS);
});
