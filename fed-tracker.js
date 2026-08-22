const $ = (selector) => document.querySelector(selector);
const refreshBtn = $("#refreshBtn");
const asOfInput = $("#asOf");
const statusEl = $("#status");
const metricsEl = $("#metrics");
const meetingTabs = $("#meetingTabs");
const meetingSelect = $("#meetingSelect");
const meetingTitle = $("#meetingTitle");
const meetingMeta = $("#meetingMeta");
const viewKicker = $("#viewKicker");
const viewMessage = $("#viewMessage");
const probabilityTable = $("#probabilityTable");
const contractRows = $("#contractRows");
const stripSource = $("#stripSource");
const notesEl = $("#notes");
const fedSourceLinks = $("#fedSourceLinks");
const historyControls = $("#historyControls");
const historyRange = $("#historyRange");
const outcomeFilters = $("#outcomeFilters");
const canvas = $("#fedChart");
const tooltip = $("#fedTooltip");
const fedIntentForm = $("#fedIntentForm");
const fedIntentPrompt = $("#fedIntentPrompt");
const fedIntentStatus = $("#fedIntentStatus");
const fedIntentMode = $("#fedIntentMode");
const fedModelHealth = $("#fedModelHealth");
const ctx = canvas.getContext("2d");
const COLORS = ["#0b66c3", "#00a8c6", "#f0a202", "#d1495b", "#6f55b5", "#248f60", "#7d8997"];
const state = {
  summary: null,
  selected: null,
  view: "current",
  history: new Map(),
  historyRequests: new Map(),
  viewRequestId: 0,
  renderHits: [],
  selectedOutcomes: new Set(),
  outcomesInitialized: false,
};

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatPercent(value, digits = 2) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}%` : "n/a";
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(value)) : "n/a";
}

function safeExternalLink(url, label) {
  try {
    const parsed = new URL(String(url));
    if (!["http:", "https:"].includes(parsed.protocol)) return escapeHtml(label);
    return `<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  } catch {
    return escapeHtml(label);
  }
}

function displayDate(value, options = {}) {
  if (!value) return "n/a";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { year: "numeric", month: options.short ? "short" : "long", day: "numeric" });
}

function setStatus(message, error = false) {
  statusEl.textContent = message; statusEl.classList.toggle("error", error);
}

async function getJson(url, timeout = 120000) {
  if (typeof window.fetch === "function") {
    const controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await window.fetch(url, { signal: controller.signal }); const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
      return payload;
    } finally { window.clearTimeout(timer); }
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open("GET", url, true); request.timeout = 120000;
    request.onload = () => {
      try { const payload = JSON.parse(request.responseText || "{}"); request.status >= 200 && request.status < 300 && !payload.error ? resolve(payload) : reject(new Error(payload.error || `Request failed with HTTP ${request.status}`)); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(new Error("Local data request failed.")); request.ontimeout = () => reject(new Error("Local data request timed out.")); request.send();
  });
}

function metric(label, value, detail) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail || "")}</small></article>`;
}

function selectedMeeting() {
  return state.summary?.meetings.find((meeting) => meeting.date === state.selected) || null;
}

function renderMetrics() {
  const summary = state.summary; const next = summary.meetings[0];
  metricsEl.innerHTML = [
    metric("Effective fed funds", formatPercent(summary.effr.value), `${summary.effr.source} | ${summary.effr.date || summary.asOf}`),
    metric("Current target", summary.targetRange.label, summary.targetRange.source?.source || "Federal Reserve"),
    metric("Next FOMC", next ? displayDate(next.date, { short: true }) : "Unavailable", next?.contract || ""),
    metric("Futures quotes", summary.asOf, summary.futures.provider),
  ].join("");
}

function renderMeetingNavigation() {
  meetingTabs.innerHTML = state.summary.meetings.map((meeting) => `<button class="${meeting.date === state.selected ? "active" : ""}" data-meeting="${meeting.date}"><span>${displayDate(meeting.date, { short: true })}</span><small>${escapeHtml(meeting.contract)}</small></button>`).join("");
  meetingSelect.innerHTML = state.summary.meetings.map((meeting) => `<option value="${meeting.date}" ${meeting.date === state.selected ? "selected" : ""}>${displayDate(meeting.date)} (${escapeHtml(meeting.contract)})</option>`).join("");
}

function renderContracts() {
  const futures = state.summary.futures; const official = futures.provider.includes("CME");
  stripSource.textContent = `${official ? "Official EOD settlement" : "Indicative close fallback"} | ${futures.tradeDate || "n/a"}`;
  contractRows.innerHTML = futures.contracts.map((row) => `<tr><td>${escapeHtml(row.month)}</td><td>${escapeHtml(row.contract)}</td><td>${escapeHtml(row.providerSymbol || "")}</td><td>${formatNumber(row.settle)}</td><td>${formatPercent(row.impliedRate)}</td><td>${formatNumber(row.volume)}</td><td>${formatNumber(row.openInterest)}</td></tr>`).join("");
}

function renderNotes() {
  const summary = state.summary; const extra = [];
  if (summary.futures.fallbackReason) extra.push(`Fallback used: ${summary.futures.fallbackReason}`);
  if (summary.rateLookupErrors?.length) extra.push(`Rate lookup details: ${summary.rateLookupErrors.join(" | ")}`);
  if (summary.network?.warnings?.length) extra.push(...summary.network.warnings);
  notesEl.innerHTML = [...summary.notes, ...extra].map((note) => `<li>${escapeHtml(note)}</li>`).join("");
}

function renderSources(extraSources = []) {
  const sources = [...(state.summary?.sources || []), ...extraSources];
  const unique = sources.filter((source, index) => source?.url && sources.findIndex((candidate) => candidate?.url === source.url) === index);
  fedSourceLinks.innerHTML = unique.map((source) => `<article class="source-card"><span>${escapeHtml(source.role || "Reference")}</span><strong>${safeExternalLink(source.url, source.name || source.url)}</strong><small>${escapeHtml(source.url)}</small></article>`).join("");
}

function prepareCanvas() {
  const rect = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
  const width = Math.max(720, rect.width || 1200); const height = Math.max(420, rect.height || 560);
  canvas.width = width * ratio; canvas.height = height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
  state.renderHits = [];
  return { width, height, plot: { x: 72, y: 38, w: width - 104, h: height - 112 } };
}

function drawProbabilityAxes(plot, categories) {
  ctx.font = "12px Bahnschrift, sans-serif";
  for (let tick = 0; tick <= 5; tick += 1) {
    const value = tick * 20; const y = plot.y + plot.h - (value / 100) * plot.h;
    ctx.strokeStyle = "#dce5ed"; ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ctx.fillStyle = "#44586b"; ctx.textAlign = "right"; ctx.fillText(`${value}%`, plot.x - 10, y + 4);
  }
  const slot = plot.w / Math.max(categories.length, 1);
  categories.forEach((category, index) => {
    const x = plot.x + slot * (index + 0.5); ctx.fillStyle = "#253d52"; ctx.textAlign = "center";
    ctx.fillText(category, x, plot.y + plot.h + 25);
  });
  return slot;
}

function drawCurrent(meeting) {
  const { plot } = prepareCanvas(); const categories = meeting.distribution.map((row) => row.targetRange); const slot = drawProbabilityAxes(plot, categories);
  meeting.distribution.forEach((row, index) => {
    const barWidth = Math.min(90, slot * 0.58); const h = plot.h * row.probability / 100; const x = plot.x + slot * (index + 0.5) - barWidth / 2; const y = plot.y + plot.h - h;
    const gradient = ctx.createLinearGradient(0, y, 0, y + h); gradient.addColorStop(0, "#0b66c3"); gradient.addColorStop(1, "#00a8c6"); ctx.fillStyle = gradient; ctx.fillRect(x, y, barWidth, h);
    ctx.fillStyle = "#18354d"; ctx.textAlign = "center"; ctx.font = "700 14px Bahnschrift, sans-serif"; ctx.fillText(`${row.probability.toFixed(1)}%`, x + barWidth / 2, Math.max(plot.y + 14, y - 8));
    state.renderHits.push({ x, y, w: barWidth, h, html: `<strong>${escapeHtml(row.targetRange)}</strong><span>${formatPercent(row.probability, 1)} | ${escapeHtml(row.action)}</span>` });
  });
}

function outcomesFromSnapshots(snapshots) {
  return [...new Set(snapshots.flatMap((snapshot) => snapshot.distribution.map((row) => row.targetRange)))].sort((a, b) => parseFloat(a) - parseFloat(b));
}

function probabilityFor(snapshot, outcome) {
  return snapshot.distribution.find((row) => row.targetRange === outcome)?.probability || 0;
}

function drawCompare(history) {
  const usable = history.comparisons.filter((row) => row.date && row.distribution.length); const outcomes = outcomesFromSnapshots(usable); const { plot } = prepareCanvas(); const slot = drawProbabilityAxes(plot, outcomes); const groupWidth = slot * 0.76; const barWidth = Math.max(4, groupWidth / Math.max(usable.length, 1));
  outcomes.forEach((outcome, outcomeIndex) => usable.forEach((snapshot, seriesIndex) => {
    const probability = probabilityFor(snapshot, outcome); const h = plot.h * probability / 100; const x = plot.x + slot * outcomeIndex + (slot - groupWidth) / 2 + seriesIndex * barWidth; const y = plot.y + plot.h - h;
    ctx.fillStyle = COLORS[seriesIndex % COLORS.length]; ctx.fillRect(x, y, Math.max(2, barWidth - 2), h);
    state.renderHits.push({ x, y, w: Math.max(2, barWidth - 2), h, html: `<strong>${escapeHtml(snapshot.label)} | ${escapeHtml(outcome)}</strong><span>${formatPercent(probability, 1)} as of ${escapeHtml(snapshot.date)}</span>` });
  }));
  let legendX = plot.x; ctx.font = "12px Bahnschrift, sans-serif";
  usable.forEach((snapshot, index) => { ctx.fillStyle = COLORS[index % COLORS.length]; ctx.fillRect(legendX, 12, 14, 4); ctx.fillStyle = "#253d52"; ctx.textAlign = "left"; const label = `${snapshot.label} (${snapshot.date})`; ctx.fillText(label, legendX + 20, 17); legendX += ctx.measureText(label).width + 54; });
}

function filteredHistoryRows(history) {
  const rows = history.history.filter((row) => row.distribution.length);
  if (!rows.length || historyRange.value === "ALL") return rows;
  const days = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366 }[historyRange.value] || 366;
  const lastDate = new Date(`${rows.at(-1).date}T00:00:00Z`);
  const firstDate = new Date(lastDate); firstDate.setUTCDate(firstDate.getUTCDate() - days);
  return rows.filter((row) => new Date(`${row.date}T00:00:00Z`) >= firstDate);
}

function renderOutcomeFilters(history) {
  const outcomes = outcomesFromSnapshots(history.history.filter((row) => row.distribution.length));
  if (!state.outcomesInitialized) { outcomes.forEach((outcome) => state.selectedOutcomes.add(outcome)); state.outcomesInitialized = true; }
  [...state.selectedOutcomes].forEach((outcome) => { if (!outcomes.includes(outcome)) state.selectedOutcomes.delete(outcome); });
  outcomeFilters.innerHTML = outcomes.map((outcome, index) => `<label style="--outcome-color:${COLORS[index % COLORS.length]}"><input type="checkbox" value="${escapeHtml(outcome)}" ${state.selectedOutcomes.has(outcome) ? "checked" : ""} /><span>${escapeHtml(outcome)}</span></label>`).join("");
}

function drawHistorical(history) {
  const rows = filteredHistoryRows(history); const allOutcomes = outcomesFromSnapshots(history.history.filter((row) => row.distribution.length)); const outcomes = allOutcomes.filter((outcome) => state.selectedOutcomes.has(outcome)); const { plot } = prepareCanvas();
  for (let tick = 0; tick <= 5; tick += 1) { const value = tick * 20; const y = plot.y + plot.h - plot.h * value / 100; ctx.strokeStyle = "#dce5ed"; ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke(); ctx.fillStyle = "#44586b"; ctx.textAlign = "right"; ctx.font = "12px Bahnschrift, sans-serif"; ctx.fillText(`${value}%`, plot.x - 10, y + 4); }
  if (!rows.length || !outcomes.length) { ctx.fillStyle = "#60788a"; ctx.textAlign = "center"; ctx.font = "600 15px Bahnschrift, sans-serif"; ctx.fillText(!rows.length ? "No history in this window" : "Select at least one target outcome", plot.x + plot.w / 2, plot.y + plot.h / 2); return; }
  const times = rows.map((row) => new Date(`${row.date}T00:00:00Z`).getTime()); const min = Math.min(...times); const max = Math.max(...times); const span = Math.max(86400000, max - min);
  const xFor = (time) => plot.x + ((time - min) / span) * plot.w; const yFor = (value) => plot.y + plot.h - value / 100 * plot.h;
  outcomes.forEach((outcome) => { const outcomeIndex = allOutcomes.indexOf(outcome); ctx.strokeStyle = COLORS[outcomeIndex % COLORS.length]; ctx.fillStyle = COLORS[outcomeIndex % COLORS.length]; ctx.lineWidth = 2.5; ctx.beginPath(); rows.forEach((row, index) => { const x = xFor(new Date(`${row.date}T00:00:00Z`).getTime()); const y = yFor(probabilityFor(row, outcome)); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); rows.forEach((row) => { const x = xFor(new Date(`${row.date}T00:00:00Z`).getTime()); const value = probabilityFor(row, outcome); const y = yFor(value); ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill(); state.renderHits.push({ x: x - 5, y: y - 5, w: 10, h: 10, html: `<strong>${escapeHtml(outcome)} | ${escapeHtml(row.date)}</strong><span>${formatPercent(value, 1)} | ${escapeHtml(row.quality || "indicative")}</span>` }); }); });
  for (let tick = 0; tick <= 5; tick += 1) { const ms = min + span * tick / 5; const x = xFor(ms); ctx.fillStyle = "#44586b"; ctx.textAlign = tick === 0 ? "left" : tick === 5 ? "right" : "center"; ctx.fillText(new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }), x, plot.y + plot.h + 26); }
  let legendX = plot.x; outcomes.forEach((outcome) => { const index = allOutcomes.indexOf(outcome); ctx.fillStyle = COLORS[index % COLORS.length]; ctx.fillRect(legendX, 12, 14, 4); ctx.fillStyle = "#253d52"; ctx.textAlign = "left"; ctx.fillText(outcome, legendX + 20, 17); legendX += ctx.measureText(outcome).width + 48; });
}

function currentTable(meeting) {
  return `<table><thead><tr><th>Target range after meeting</th><th>Implied action</th><th>Probability</th></tr></thead><tbody>${meeting.distribution.map((row) => `<tr><td><strong>${escapeHtml(row.targetRange)}</strong></td><td>${escapeHtml(row.action)}</td><td><strong>${formatPercent(row.probability, 1)}</strong></td></tr>`).join("")}</tbody></table>`;
}

function compareTable(history) {
  const usable = history.comparisons.filter((row) => row.date && row.distribution.length); const outcomes = outcomesFromSnapshots(usable);
  return `<table><thead><tr><th>Target range</th>${usable.map((row) => `<th>${escapeHtml(row.label)}<small>${escapeHtml(row.date)} | ${escapeHtml(row.quality || "unknown")}</small></th>`).join("")}</tr></thead><tbody>${outcomes.map((outcome) => `<tr><td><strong>${escapeHtml(outcome)}</strong></td>${usable.map((row) => `<td>${formatPercent(probabilityFor(row, outcome), 1)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function historyTable(history) {
  const rows = filteredHistoryRows(history).slice(-15).reverse(); const outcomes = outcomesFromSnapshots(history.history.filter((row) => row.distribution.length)).filter((outcome) => state.selectedOutcomes.has(outcome));
  return `<table><thead><tr><th>Date / quality</th>${outcomes.map((outcome) => `<th>${escapeHtml(outcome)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.date)}</strong><small>${escapeHtml(row.quality || "indicative")} | ${escapeHtml(row.provider || "")}</small></td>${outcomes.map((outcome) => `<td>${formatPercent(probabilityFor(row, outcome), 1)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function probabilitiesTable() {
  const meetings = state.summary.meetings; const outcomes = [...new Set(meetings.flatMap((meeting) => meeting.distribution.map((row) => row.targetRange)))].sort((a, b) => parseFloat(a) - parseFloat(b));
  return `<table class="probability-matrix"><thead><tr><th>Target range</th>${meetings.map((meeting) => `<th>${displayDate(meeting.date, { short: true })}</th>`).join("")}</tr></thead><tbody>${outcomes.map((outcome) => `<tr><td><strong>${escapeHtml(outcome)}</strong></td>${meetings.map((meeting) => { const p = meeting.distribution.find((row) => row.targetRange === outcome)?.probability || 0; return `<td style="--prob:${p / 100}">${p ? formatPercent(p, 1) : "-"}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`;
}

function historyKey(meeting, asOf) { return `${meeting}|${asOf || "latest"}|v1`; }

async function loadHistory(meeting, asOf) {
  const key = historyKey(meeting, asOf);
  if (state.history.has(key)) return state.history.get(key);
  if (state.historyRequests.has(key)) return state.historyRequests.get(key);
  viewMessage.innerHTML = `<span class="spinner"></span> Reconstructing dated settlement comparisons. This can take a moment the first time.`;
  const params = new URLSearchParams({ meeting }); if (asOf) params.set("asOf", asOf);
  const request = getJson(`/api/fed/history?${params}`)
    .then((payload) => { state.history.set(key, payload); return payload; })
    .finally(() => state.historyRequests.delete(key));
  state.historyRequests.set(key, request);
  return request;
}

async function renderView() {
  const requestId = ++state.viewRequestId;
  const selected = state.selected; const view = state.view; const asOf = asOfInput.value;
  const meeting = selectedMeeting(); if (!meeting) return;
  historyControls.classList.toggle("hidden", view !== "historical");
  renderMeetingNavigation(); meetingTitle.textContent = `${displayDate(meeting.date)} FOMC meeting`;
  meetingMeta.innerHTML = `<span>${escapeHtml(meeting.contract)}</span><strong>${formatPercent(meeting.impliedPostMeetingRate)} implied post-meeting rate</strong><small>${escapeHtml(meeting.postRateMethod)}</small>`;
  viewMessage.textContent = ""; tooltip.classList.add("hidden");
  if (view === "current") {
    viewKicker.textContent = "Current meeting probabilities"; drawCurrent(meeting); probabilityTable.innerHTML = currentTable(meeting);
    viewMessage.textContent = `Settlement ${formatNumber(meeting.settlement)} for ${meeting.contractMonth}; probabilities are cumulative target-range outcomes from today's range.`;
  } else if (view === "probabilities") {
    viewKicker.textContent = "All upcoming meetings"; drawCurrent(meeting); probabilityTable.innerHTML = probabilitiesTable();
    viewMessage.textContent = "The chart shows the selected meeting; the table compares every target range across all currently calculable meetings.";
  } else {
    viewKicker.textContent = view === "compare" ? "Current versus prior snapshots" : "Historical probability path";
    try {
      const history = await loadHistory(selected, asOf);
      if (requestId !== state.viewRequestId || selected !== state.selected || view !== state.view || asOf !== asOfInput.value) return;
      renderSources(history.sources || []);
      if (view === "compare") { drawCompare(history); probabilityTable.innerHTML = compareTable(history); }
      else { renderOutcomeFilters(history); drawHistorical(history); probabilityTable.innerHTML = historyTable(history); }
      const errors = history.comparisons.filter((row) => row.error);
      const fallbacks = history.comparisons.filter((row) => row.officialError && row.date);
      const meta = history.historyMeta || {};
      const coverage = meta.firstDate && meta.lastDate ? `<br><strong>Chart coverage:</strong> ${escapeHtml(meta.firstDate)} to ${escapeHtml(meta.lastDate)} | ${Number(meta.totalObservationCount || 0).toLocaleString("en-US")} observations | ${Number(meta.officialObservationCount || 0).toLocaleString("en-US")} official CME overrides.` : "";
      viewMessage.innerHTML = `${history.limitations.map(escapeHtml).join(" ")}${coverage}${fallbacks.length ? `<br><strong>Indicative comparison dates:</strong> ${fallbacks.map((row) => escapeHtml(row.label)).join(", ")}.` : ""}${errors.length ? `<br><strong>Unavailable snapshots:</strong> ${errors.map((row) => `${escapeHtml(row.label)}: ${escapeHtml(row.error)}`).join(" | ")}` : ""}${meta.indicativeError ? `<br><strong>Extended-history error:</strong> ${escapeHtml(meta.indicativeError)}` : ""}`;
    } catch (error) {
      if (requestId !== state.viewRequestId) return;
      prepareCanvas(); probabilityTable.innerHTML = ""; viewMessage.innerHTML = `<strong>Comparison unavailable:</strong> ${escapeHtml(error.message)}`;
    }
  }
}

async function loadFedTracker(force = false) {
  refreshBtn.disabled = true; setStatus("Fetching rates, calendar, and futures settlements...");
  try {
    const params = new URLSearchParams(); if (asOfInput.value) params.set("asOf", asOfInput.value); if (force) params.set("refresh", "1");
    const query = params.toString() ? `?${params}` : ""; const summary = await getJson(`/api/fed/summary${query}`);
    state.summary = summary; state.history.clear(); state.historyRequests.clear(); state.viewRequestId += 1;
    asOfInput.value = summary.asOf || summary.futures?.tradeDate || "";
    if (!summary.meetings.some((meeting) => meeting.date === state.selected)) state.selected = summary.meetings[0]?.date || null;
    renderMetrics(); renderMeetingNavigation(); renderContracts(); renderNotes(); renderSources(); await renderView();
    const cacheNote = summary.network?.usedStaleCache ? " Cached verified responses were used." : ""; setStatus(`Loaded ${summary.futures.contracts.length} contracts as of ${summary.asOf}.${cacheNote}`);
  } catch (error) { setStatus(error.message, true); } finally { refreshBtn.disabled = false; }
}

async function runFedIntent() {
  const prompt = fedIntentPrompt.value.trim();
  if (!prompt) {
    fedIntentStatus.textContent = "Enter a display request to change the dashboard view.";
    fedIntentStatus.classList.remove("error");
    return;
  }
  if (!state.summary?.meetings?.length) return;
  const submit = fedIntentForm.querySelector("button[type='submit']");
  submit.disabled = true;
  fedIntentStatus.textContent = "Mapping the request to verified tracker controls...";
  fedIntentStatus.classList.remove("error");
  try {
    const params = new URLSearchParams({
      q: prompt,
      meetings: state.summary.meetings.map((meeting) => meeting.date).join(","),
    });
    const payload = await getJson(`/api/fed/intent?${params}`);
    state.view = payload.spec.view;
    if (payload.spec.meetingDate) state.selected = payload.spec.meetingDate;
    historyRange.value = payload.spec.historyRange;
    state.selectedOutcomes.clear(); state.outcomesInitialized = false;
    document.querySelectorAll("[data-fed-view]").forEach((button) => button.classList.toggle("active", button.dataset.fedView === state.view));
    fedIntentMode.textContent = payload.usedModel ? `Validated local model · ${payload.model}` : "Deterministic parser";
    fedIntentStatus.textContent = `${payload.spec.view} view applied. The parser supplied display controls only; model-generated probability values: no.`;
    fedIntentStatus.classList.remove("error");
    await renderView();
  } catch (error) {
    fedIntentStatus.textContent = error.message;
    fedIntentStatus.classList.add("error");
  } finally {
    submit.disabled = false;
  }
}

async function loadFedModelHealth() {
  try {
    const payload = await getJson("/api/model/status");
    fedModelHealth.textContent = payload.message;
    fedModelHealth.classList.toggle("error", !payload.ready);
  } catch (error) {
    fedModelHealth.textContent = error.message;
    fedModelHealth.classList.add("error");
  }
}

meetingTabs.addEventListener("click", (event) => { const button = event.target.closest("[data-meeting]"); if (!button) return; state.selected = button.dataset.meeting; state.selectedOutcomes.clear(); state.outcomesInitialized = false; renderView(); });
meetingSelect.addEventListener("change", () => { state.selected = meetingSelect.value; state.selectedOutcomes.clear(); state.outcomesInitialized = false; renderView(); });
document.querySelectorAll("[data-fed-view]").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll("[data-fed-view]").forEach((row) => row.classList.toggle("active", row === button)); state.view = button.dataset.fedView; renderView(); }));
canvas.addEventListener("mousemove", (event) => { const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; const hit = state.renderHits.find((row) => x >= row.x && x <= row.x + row.w && y >= row.y && y <= row.y + row.h); if (!hit) { tooltip.classList.add("hidden"); return; } tooltip.innerHTML = hit.html; tooltip.style.left = `${Math.min(rect.width - 260, x + 14)}px`; tooltip.style.top = `${Math.max(8, y - 42)}px`; tooltip.classList.remove("hidden"); });
canvas.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
let resizeFrame = 0;
window.addEventListener("resize", () => { window.cancelAnimationFrame(resizeFrame); resizeFrame = window.requestAnimationFrame(() => { if (state.summary) renderView(); }); });
refreshBtn.addEventListener("click", () => loadFedTracker(true));
fedIntentForm.addEventListener("submit", (event) => { event.preventDefault(); runFedIntent(); });
historyRange.addEventListener("change", () => renderView());
outcomeFilters.addEventListener("change", (event) => {
  if (event.target.type !== "checkbox") return;
  if (event.target.checked) state.selectedOutcomes.add(event.target.value); else state.selectedOutcomes.delete(event.target.value);
  renderView();
});
$("#selectAllOutcomes").addEventListener("click", () => {
  const history = state.history.get(historyKey(state.selected, asOfInput.value)); if (!history) return;
  outcomesFromSnapshots(history.history.filter((row) => row.distribution.length)).forEach((outcome) => state.selectedOutcomes.add(outcome)); renderView();
});
$("#clearOutcomes").addEventListener("click", () => {
  const history = state.history.get(historyKey(state.selected, asOfInput.value)); if (!history) return;
  state.selectedOutcomes.clear(); outcomeFilters.querySelectorAll("input").forEach((input) => { input.checked = false; });
  drawHistorical(history); probabilityTable.innerHTML = historyTable(history);
});

const now = new Date(); const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10); asOfInput.max = localIso;
loadFedTracker();
loadFedModelHealth();
