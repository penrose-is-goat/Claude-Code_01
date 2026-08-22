const $ = (selector) => document.querySelector(selector);

const refs = {
  updated: $("#auctionUpdated"), coverage: $("#auctionCoverage"), refresh: $("#refreshAuctions"),
  latestBanner: $("#latestBanner"), upcomingTape: $("#upcomingTape"), queryForm: $("#auctionQueryForm"),
  prompt: $("#auctionPrompt"), useModel: $("#useAuctionModel"), modelStatus: $("#modelStatus"),
  queryMode: $("#queryMode"), queryStatus: $("#queryStatus"), resolved: $("#resolvedQuery"),
  summary: $("#auctionSummary"), chart: $("#auctionChart"), tooltip: $("#auctionTooltip"),
  chartTitle: $("#chartTitle"), chartKicker: $("#chartKicker"), chartAudit: $("#chartAudit"),
  chartPanel: $("#auctionChartPanel"),
  queryTable: $("#queryTable"), latestResults: $("#latestResults"), upcomingTable: $("#upcomingTable"),
  resultType: $("#resultType"), resultSearch: $("#resultSearch"), resultCount: $("#resultCount"),
  sources: $("#auctionSources"), detail: $("#auctionDetail"), detailContent: $("#auctionDetailContent"),
};

const state = { dashboard: null, query: null, latestLimit: 15, page: 0, chartHits: [], queryRequestId: 0, queryController: null, sort: { key: "auctionDate", direction: -1 } };
const ctx = refs.chart.getContext("2d");
const METRICS = {
  bidToCoverRatio: { label: "Bid-to-cover ratio", digits: 2, format: "number" },
  stopOutValue: { label: "Auction stop-out", digits: 3, format: "percent" },
  highYield: { label: "High yield", digits: 3, format: "percent" },
  highDiscountRate: { label: "High discount rate", digits: 3, format: "percent" },
  highInvestmentRate: { label: "Investment rate", digits: 3, format: "percent" },
  highDiscountMargin: { label: "High discount margin", digits: 3, format: "number" },
  offeringAmount: { label: "Offering amount", digits: 0, format: "currency" },
  somaAccepted: { label: "SOMA accepted", digits: 0, format: "currency" },
  indirectBidderShare: { label: "Indirect bidder share", digits: 1, format: "percent" },
  directBidderShare: { label: "Direct bidder share", digits: 1, format: "percent" },
  primaryDealerShare: { label: "Primary dealer share", digits: 1, format: "percent" },
};

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function safeUrl(value) {
  try { const parsed = new URL(String(value)); return parsed.protocol === "https:" && /(^|\.)treasury\.gov$|(^|\.)treasurydirect\.gov$/.test(parsed.hostname) ? parsed.href : ""; }
  catch { return ""; }
}

function displayDate(value, short = false) {
  if (!value) return "n/a";
  return new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { year: "numeric", month: short ? "short" : "long", day: "numeric" });
}

function compactMoney(value) {
  const amount = Number(value); if (!Number.isFinite(amount)) return "n/a";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(amount);
}

function numberText(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "n/a";
}

function metricValue(value, metric) {
  if (!Number.isFinite(Number(value))) return "n/a";
  const meta = METRICS[metric] || { digits: 2, format: "number" };
  if (meta.format === "currency") return compactMoney(value);
  return `${Number(value).toFixed(meta.digits)}${meta.format === "percent" ? "%" : ""}`;
}

async function getJson(url, { signal = null, timeout = 120000 } = {}) {
  const controller = new AbortController(); const relayAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", relayAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal }); const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    window.clearTimeout(timer); if (signal) signal.removeEventListener("abort", relayAbort);
  }
}

async function loadModelStatus() {
  try {
    const payload = await getJson("/api/model/status");
    refs.modelStatus.textContent = payload.ready
      ? `${payload.message} It is used only for unfamiliar wording; Treasury records still supply every value.`
      : payload.message;
  } catch (error) {
    refs.modelStatus.textContent = error.message;
  }
}

function sourceLink(url, label) {
  const safe = safeUrl(url); return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : "";
}

function auctionLabel(row) {
  const type = row.type || row.securityType || "Treasury";
  const term = row.securityTerm || row.term || row.originalSecurityTerm || "Auction";
  return `${term} ${type}`.replace(/\s+/g, " ");
}

function tenorLineage(row) {
  const current = row.securityTerm;
  const original = row.term || row.originalSecurityTerm;
  return current && original && current !== original ? `Original ${original} - ` : "";
}

function resultMetric(row) {
  const value = row.stopOutValue ?? row.highYield ?? row.highDiscountRate ?? row.highDiscountMargin;
  const label = row.stopOutLabel || (row.type === "Bill" ? "High rate" : row.type === "FRN" ? "High margin" : "High yield");
  return { label, value };
}

function renderBanners() {
  const latest = state.dashboard.latestResult || state.dashboard.latest?.[0];
  const upcoming = state.dashboard.upcoming || [];
  if (latest) {
    const stop = resultMetric(latest); const pdf = latest.resultPdfUrl || latest.pdfResultUrl;
    refs.latestBanner.innerHTML = `<div class="tape-label"><span class="live-dot"></span> Latest result</div><h2>${escapeHtml(auctionLabel(latest))}</h2><p>${displayDate(latest.auctionDate, true)} · ${escapeHtml(tenorLineage(latest))}${escapeHtml(latest.reopening ? "Reopening" : "New issue")} · ${escapeHtml(latest.cusip || "")}</p><div class="tape-metrics"><strong><small>${escapeHtml(stop.label)}</small>${numberText(stop.value, 3)}%</strong><strong><small>Bid-to-cover</small>${numberText(latest.bidToCoverRatio, 2)}</strong><strong><small>Offering</small>${compactMoney(latest.offeringAmount)}</strong></div><div class="tape-actions"><button data-auction-key="${escapeHtml(latest.auctionKey || latest.key || "")}">Inspect result</button>${sourceLink(pdf, "Official result PDF")}</div>`;
  }
  refs.upcomingTape.innerHTML = upcoming.slice(0, 4).map((row, index) => `<article class="tape-card upcoming-card"><div class="tape-label">${index === 0 ? "Next auction" : "Announced"}</div><h3>${escapeHtml(auctionLabel(row))}</h3><p>${displayDate(row.auctionDate, true)} · ${escapeHtml(tenorLineage(row))}${escapeHtml(row.closingTimeCompetitive || "")}</p><div class="tape-metrics"><strong><small>Offering</small>${compactMoney(row.offeringAmount)}</strong><strong><small>Issue date</small>${displayDate(row.issueDate, true)}</strong></div>${sourceLink(row.announcementPdfUrl || row.pdfAnnouncementUrl, "Official announcement")}</article>`).join("") || `<article class="tape-card"><h3>No future auction announcement is currently in the feed.</h3></article>`;
}

function renderSources() {
  const defaults = [
    { role: "Structured auction records", name: "TreasuryDirect Securities API", url: "https://www.treasurydirect.gov/TA_WS/securities/search?format=json" },
    { role: "Official query and downloads", name: "Treasury Auction Query", url: "https://www.treasurydirect.gov/auctions/auction-query/" },
    { role: "Announcements and result documents", name: "Treasury auction press releases", url: "https://www.treasurydirect.gov/auctions/announcements-data-results/announcement-results-press-releases/treasury-marketable/" },
    { role: "Definitions and methodology", name: "Uniform Offering Circular", url: "https://www.treasurydirect.gov/files/laws-and-regulations/auction-regulations-uoc/31-cfr-part-356.pdf" },
  ];
  const sources = state.dashboard.sources?.length ? state.dashboard.sources : defaults;
  refs.sources.innerHTML = sources.map((row) => `<article class="source-card"><span>${escapeHtml(row.role || "Official source")}</span><strong>${sourceLink(row.url, row.name || row.url)}</strong><small>${escapeHtml(row.url || "")}</small></article>`).join("");
}

function recordRows() {
  const type = refs.resultType.value.toLowerCase(); const search = refs.resultSearch.value.trim().toLowerCase();
  let rows = [...(state.dashboard.latest || [])];
  if (type !== "all") rows = rows.filter((row) => String(row.type || row.securityType).toLowerCase() === type);
  if (search) rows = rows.filter((row) => [row.term, row.originalSecurityTerm, row.securityTerm, row.cusip].some((value) => String(value || "").toLowerCase().includes(search)));
  const { key, direction } = state.sort;
  rows.sort((a, b) => String(a[key] ?? "").localeCompare(String(b[key] ?? ""), undefined, { numeric: true }) * direction);
  return rows;
}

const RESULT_COLUMNS = [
  ["auctionDate", "Auction date"], ["term", "Security"], ["offeringAmount", "Offering"], ["stopOutValue", "Stop-out"],
  ["bidToCoverRatio", "Bid-to-cover"], ["directBidderShare", "Direct %"], ["indirectBidderShare", "Indirect %"],
  ["primaryDealerShare", "Dealer %"], ["somaAccepted", "SOMA accepted"],
];

function renderLatestResults() {
  const all = recordRows(); const pageStart = state.page * 25; const count = state.page ? 25 : state.latestLimit; const rows = all.slice(pageStart, pageStart + count);
  refs.latestResults.innerHTML = `<table class="auction-results-table"><thead><tr>${RESULT_COLUMNS.map(([key, label]) => `<th><button data-sort="${key}">${escapeHtml(label)}${state.sort.key === key ? (state.sort.direction === 1 ? " ↑" : " ↓") : ""}</button></th>`).join("")}<th>Source</th></tr></thead><tbody>${rows.map((row) => { const stop = resultMetric(row); return `<tr data-auction-key="${escapeHtml(row.auctionKey || row.key || "")}"><td>${escapeHtml(String(row.auctionDate || "").slice(0, 10))}</td><td><strong>${escapeHtml(auctionLabel(row))}</strong><small>${escapeHtml(row.reopening ? "Reopening" : "New issue")} · ${escapeHtml(row.cusip || "")}</small></td><td>${compactMoney(row.offeringAmount)}</td><td>${numberText(stop.value, 3)}<small>${escapeHtml(stop.label)}</small></td><td>${numberText(row.bidToCoverRatio, 2)}</td><td>${numberText(row.directBidderShare, 1)}%</td><td>${numberText(row.indirectBidderShare, 1)}%</td><td>${numberText(row.primaryDealerShare, 1)}%</td><td>${compactMoney(row.somaAccepted)}</td><td><button class="row-inspect" data-auction-key="${escapeHtml(row.auctionKey || row.key || "")}">View</button></td></tr>`; }).join("")}</tbody></table>`;
  refs.resultCount.textContent = all.length ? `Showing ${pageStart + 1}-${Math.min(pageStart + count, all.length)} of ${all.length}` : "No matching auctions";
  $("#showMoreResults").classList.toggle("hidden", state.page > 0 || state.latestLimit >= Math.min(25, all.length));
  $("#previousResults").disabled = state.page === 0; $("#nextResults").disabled = pageStart + count >= all.length;
}

function renderUpcomingTable() {
  const rows = state.dashboard.upcoming || [];
  refs.upcomingTable.innerHTML = `<table><thead><tr><th>Auction date</th><th>Security</th><th>Offering</th><th>Competitive close</th><th>Issue date</th><th>Announcement</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${displayDate(row.auctionDate, true)}</strong></td><td>${escapeHtml(auctionLabel(row))}<small>${escapeHtml(row.reopening ? "Reopening" : "New issue")} · ${escapeHtml(row.cusip || "")}</small></td><td>${compactMoney(row.offeringAmount)}</td><td>${escapeHtml(row.closingTimeCompetitive || "n/a")}</td><td>${displayDate(row.issueDate, true)}</td><td>${sourceLink(row.announcementPdfUrl || row.pdfAnnouncementUrl, "PDF")}</td></tr>`).join("")}</tbody></table>`;
}

function renderDatabaseStatus() {
  const db = state.dashboard.database || state.dashboard.status || {};
  refs.updated.textContent = db.lastSuccessfulSync ? `Updated ${displayDate(db.lastSuccessfulSync.slice(0, 10), true)}` : "Loaded from verified local database";
  refs.coverage.textContent = `${Number(db.rowCount || db.count || state.dashboard.totalCount || 0).toLocaleString("en-US")} auctions · ${db.firstAuctionDate || db.firstDate || "1997"} to ${db.lastAuctionDate || db.lastDate || "present"}${db.stale ? " · cached" : ""}`;
}

function queryRows(payload) { return payload.rows || payload.auctions || payload.data || []; }
function queryMetrics(payload) {
  const spec = payload.spec || payload.querySpec || {};
  const requested = spec.metrics || payload.chart?.metrics || (spec.metric || payload.chart?.metric ? [spec.metric || payload.chart?.metric] : ["bidToCoverRatio"]);
  return [...new Set(requested)].filter((metric) => METRICS[metric]);
}
function queryMetric(payload) { return queryMetrics(payload)[0] || "bidToCoverRatio"; }

function renderResolved(payload) {
  const spec = payload.spec || payload.querySpec || {}; const chips = [];
  const view = spec.view || spec.action;
  if (view) chips.push(view === "records" ? "Official result records" : view);
  if (view !== "records") (spec.metrics || [spec.metric]).filter(Boolean).forEach((value) => chips.push(METRICS[value]?.label || value));
  const terms = spec.terms || spec.securityTerms || (spec.term ? [spec.term] : []); terms.forEach((value) => chips.push(value));
  chips.push(spec.securityType || spec.type || "All security types");
  if (spec.startDate || spec.start) chips.push(`From ${spec.startDate || spec.start}`);
  if (spec.endDate || spec.end) chips.push(`To ${spec.endDate || spec.end}`);
  refs.resolved.classList.remove("hidden"); refs.resolved.innerHTML = `<strong>Resolved query</strong>${chips.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}<small>${escapeHtml(payload.interpretation || payload.resolvedQuery || "Executed against normalized Treasury records; no values were generated by a model.")}</small>`;
}

function queryScopeLabel(payload) {
  const spec = payload.spec || payload.querySpec || {};
  const term = spec.term || spec.terms?.join(", ") || spec.securityTerms?.join(", ");
  const type = spec.securityType || spec.type;
  if (term && type) return `${term} ${type}`;
  if (term) return `${term} - all security types`;
  return type || "All marketable Treasury auctions";
}

function renderQuerySummary(payload) {
  const rows = queryRows(payload); const summary = payload.summary || {}; const metric = queryMetric(payload);
  if (payload.spec?.view === "records") {
    refs.summary.innerHTML = [
      ["Matching auctions", summary.observationCount ?? rows.length, summary.truncated ? `${summary.returnedCount} records returned; refine the query to inspect every match` : "Official completed auction records"],
      ["Coverage", summary.firstDate && summary.lastDate ? `${summary.firstDate} to ${summary.lastDate}` : "No matches", "Auction dates, not issue dates"],
      ["Result PDFs", summary.resultPdfCount ?? rows.filter((row) => row.resultPdfUrl).length, "Direct official Treasury result files"],
      ["Missing PDFs", summary.missingResultPdfCount ?? rows.filter((row) => !row.resultPdfUrl).length, "Structured records remain available"],
    ].map(([label, value, detail]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join("");
    return;
  }
  const values = rows.map((row) => Number(row[metric])).filter(Number.isFinite); const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  refs.summary.innerHTML = [
    ["Auctions", summary.observationCount ?? rows.length, summary.sampled ? `${summary.returnedCount} date-spanning points plotted for speed` : summary.truncated ? `${summary.returnedCount} records returned; refine filters for the remainder` : "Records matching the visible specification"],
    ["Coverage", summary.firstDate && summary.lastDate ? `${summary.firstDate} to ${summary.lastDate}` : rows.length ? `${String(rows[0].auctionDate).slice(0, 10)} to ${String(rows.at(-1).auctionDate).slice(0, 10)}` : "No observations", "Auction dates, not issue dates"],
    ["Average", mean === null ? "n/a" : metricValue(mean, metric), METRICS[metric]?.label || metric],
    ["Missing", summary.missingCount ?? rows.filter((row) => !Number.isFinite(Number(row[metric]))).length, "Retained as blank, never zero-filled"],
  ].map(([label, value, detail]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join("");
}

function prepareCanvas() {
  const rect = refs.chart.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; const width = Math.max(720, rect.width || 1200); const height = Math.max(420, rect.height || 540);
  refs.chart.width = width * ratio; refs.chart.height = height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#fffdf7"; ctx.fillRect(0, 0, width, height); state.chartHits = [];
  return { width, height, plot: { x: 72, y: 52, w: width - 112, h: height - 126 } };
}

function drawChart(payload) {
  const metrics = queryMetrics(payload); const metric = metrics[0]; const meta = METRICS[metric] || { label: metric, digits: 2, format: "number" };
  const rows = queryRows(payload).filter((row) => row.auctionDate && metrics.some((key) => Number.isFinite(Number(row[key])))).sort((a, b) => String(a.auctionDate).localeCompare(String(b.auctionDate)));
  const { plot } = prepareCanvas(); refs.chartTitle.textContent = metrics.map((key) => METRICS[key].label).join(" vs. "); refs.chartKicker.textContent = `${queryScopeLabel(payload)} - historical series`;
  if (!rows.length) { ctx.fillStyle = "#4f5f6c"; ctx.font = "600 18px Georgia, serif"; ctx.textAlign = "center"; ctx.fillText("No numeric observations matched this query.", plot.x + plot.w / 2, plot.y + plot.h / 2); return; }
  const values = rows.flatMap((row) => metrics.map((key) => Number(row[key])).filter(Number.isFinite)); let min = Math.min(...values); let max = Math.max(...values); if (min === max) { min -= 1; max += 1; } const pad = (max - min) * 0.12; min -= pad; max += pad;
  const dateMin = Date.parse(`${rows[0].auctionDate.slice(0, 10)}T00:00:00Z`); const dateMax = Date.parse(`${rows.at(-1).auctionDate.slice(0, 10)}T00:00:00Z`); const span = Math.max(86400000, dateMax - dateMin);
  const xFor = (row) => plot.x + (Date.parse(`${row.auctionDate.slice(0, 10)}T00:00:00Z`) - dateMin) / span * plot.w; const yFor = (value) => plot.y + plot.h - (value - min) / (max - min) * plot.h;
  ctx.font = "12px Bahnschrift, sans-serif"; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) { const value = min + (max - min) * i / 5; const y = yFor(value); ctx.strokeStyle = "#d9d9d2"; ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke(); ctx.fillStyle = "#52606a"; ctx.textAlign = "right"; ctx.fillText(metricValue(value, metric), plot.x - 10, y + 4); }
  const colors = ["#1261a0", "#c4473a", "#008d91", "#e5aa2d"];
  metrics.forEach((key, seriesIndex) => {
    let drawing = false; ctx.strokeStyle = colors[seriesIndex % colors.length]; ctx.lineWidth = 2.5; ctx.beginPath();
    rows.forEach((row) => { const value = Number(row[key]); if (!Number.isFinite(value)) { drawing = false; return; } const x = xFor(row); const y = yFor(value); drawing ? ctx.lineTo(x, y) : ctx.moveTo(x, y); drawing = true; }); ctx.stroke();
    rows.forEach((row) => { const value = Number(row[key]); if (!Number.isFinite(value)) return; const x = xFor(row); const y = yFor(value); ctx.fillStyle = "#fffdf7"; ctx.strokeStyle = colors[seriesIndex % colors.length]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); state.chartHits.push({ x, y, row, metric: key }); });
    ctx.fillStyle = colors[seriesIndex % colors.length]; ctx.fillRect(plot.x + seriesIndex * 190, 17, 18, 4); ctx.fillStyle = "#314754"; ctx.textAlign = "left"; ctx.fillText(METRICS[key].label, plot.x + 25 + seriesIndex * 190, 22);
  });
  for (let i = 0; i <= 5; i += 1) { const date = new Date(dateMin + span * i / 5); const x = plot.x + plot.w * i / 5; ctx.fillStyle = "#52606a"; ctx.textAlign = i === 0 ? "left" : i === 5 ? "right" : "center"; ctx.fillText(date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }), x, plot.y + plot.h + 27); }
  const summary = payload.summary || {}; refs.chartAudit.textContent = `${Number(summary.observationCount || rows.length).toLocaleString("en-US")} matching auctions from ${summary.firstDate || rows[0].auctionDate.slice(0, 10)} through ${summary.lastDate || rows.at(-1).auctionDate.slice(0, 10)}.${summary.sampled ? ` ${rows.length.toLocaleString("en-US")} date-spanning points are plotted for responsive rendering.` : ""} ${summary.missingCount || 0} missing requested values were excluded from their lines. Click a point to inspect its official auction result.`;
}

function renderQueryTable(payload) {
  const rows = queryRows(payload); const metrics = queryMetrics(payload);
  const visibleRows = rows.slice(0, 100);
  const extraMetrics = metrics.filter((metric) => !["bidToCoverRatio", "stopOutValue", "highYield", "highDiscountRate", "highDiscountMargin", "offeringAmount"].includes(metric));
  const heading = payload.spec?.view === "records" ? "Matching official auction results" : "Matching auction records";
  const total = Number(payload.summary?.observationCount || rows.length);
  const description = rows.length ? `Showing ${visibleRows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} matching auctions. Refine broad filters to inspect more rows; chart sampling preserves the full date span.` : "No completed auction records matched the resolved filters.";
  refs.queryTable.innerHTML = `<div class="query-result-heading"><div><p class="auction-kicker">Database results</p><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(description)}</p></div></div>${rows.length ? `<table><thead><tr><th>Auction date</th><th>Security</th><th>CUSIP</th><th>Issue date</th><th>Offering</th><th>Stop-out</th><th>Bid-to-cover</th>${extraMetrics.map((metric) => `<th>${escapeHtml(METRICS[metric].label)}</th>`).join("")}<th>Official files</th></tr></thead><tbody>${visibleRows.map((row) => { const stop = resultMetric(row); return `<tr><td>${escapeHtml(String(row.auctionDate || "").slice(0, 10))}</td><td><strong>${escapeHtml(auctionLabel(row))}</strong><small>${escapeHtml(tenorLineage(row))}${escapeHtml(row.reopening ? "Reopening" : "New issue")}</small></td><td>${escapeHtml(row.cusip || "n/a")}</td><td>${escapeHtml(String(row.issueDate || "n/a").slice(0, 10))}</td><td>${compactMoney(row.offeringAmount)}</td><td>${numberText(stop.value, 3)}${Number.isFinite(Number(stop.value)) ? "%" : ""}<small>${escapeHtml(stop.label)}</small></td><td>${numberText(row.bidToCoverRatio, 2)}</td>${extraMetrics.map((metric) => `<td>${metricValue(row[metric], metric)}</td>`).join("")}<td><div class="official-file-links">${sourceLink(row.resultPdfUrl, "Result PDF")}${sourceLink(row.announcementPdfUrl, "Announcement PDF")}<button class="row-inspect" data-auction-key="${escapeHtml(row.auctionKey || row.key || "")}">Inspect</button></div></td></tr>`; }).join("")}</tbody></table>` : ""}`;
}

function applyQueryView(payload) {
  const view = payload.spec?.view || "chart";
  const showChart = view === "chart";
  refs.chartPanel.classList.toggle("hidden", !showChart);
  refs.queryTable.classList.toggle("hidden", showChart);
  if (showChart) drawChart(payload);
}

async function runQuery() {
  const prompt = refs.prompt.value.trim();
  if (!prompt) {
    refs.queryStatus.textContent = "Enter an auction request or choose an example to search the database.";
    refs.queryStatus.classList.remove("error");
    return;
  }
  const requestId = ++state.queryRequestId;
  if (state.queryController) state.queryController.abort();
  state.queryController = new AbortController();
  refs.queryStatus.textContent = "Parsing the request and querying verified auction records..."; refs.queryStatus.classList.remove("error");
  try {
    const params = new URLSearchParams({ q: prompt }); if (refs.useModel.checked) params.set("useModel", "1");
    const payload = await getJson(`/api/treasury/query?${params}`, { signal: state.queryController.signal });
    if (requestId !== state.queryRequestId) return;
    state.query = payload;
    refs.queryMode.textContent = payload.parser === "ollama" || payload.usedModel ? `Validated open model · ${payload.model || "Qwen3.5 9B"}` : "Deterministic parser";
    refs.modelStatus.textContent = payload.parser === "ollama" || payload.usedModel ? "Model output passed the same allowlisted query schema; all values still came from Treasury records." : "The standard parser handled this request; no model was called.";
    renderResolved(payload); renderQuerySummary(payload);
    if (payload.spec?.view === "chart") refs.queryTable.innerHTML = ""; else renderQueryTable(payload);
    applyQueryView(payload);
    const rows = queryRows(payload); const pdfCount = payload.summary?.resultPdfCount ?? rows.filter((row) => row.resultPdfUrl).length;
    const total = Number(payload.summary?.observationCount || rows.length);
    refs.queryStatus.textContent = payload.message || (payload.spec?.view === "records" ? `Found ${total.toLocaleString("en-US")} official auction results; ${pdfCount.toLocaleString("en-US")} result PDFs are available in the returned records.` : `Matched ${total.toLocaleString("en-US")} auction records${payload.summary?.sampled ? `; plotted ${rows.length.toLocaleString("en-US")} date-spanning points` : ""}.`);
    if (payload.detail || (payload.spec?.view === "latest" && queryRows(payload)[0])) openDetail(queryRows(payload)[0]);
  } catch (error) {
    if (error.name !== "AbortError" && requestId === state.queryRequestId) { refs.queryStatus.textContent = error.message; refs.queryStatus.classList.add("error"); }
  }
}

async function openDetail(rowOrKey) {
  try {
    let row = typeof rowOrKey === "object" ? rowOrKey : null; let usedRowFallback = false; const key = row?.auctionKey || row?.key || rowOrKey;
    if (key) { try { row = await getJson(`/api/treasury/auction?key=${encodeURIComponent(key)}`); row = row.auction || row; } catch { if (!row) throw new Error("Auction detail is unavailable."); usedRowFallback = true; } }
    if (!row) return; const stop = resultMetric(row); const pdf = safeUrl(row.resultPdfUrl || row.pdfResultUrl); const announcement = row.announcementPdfUrl || row.pdfAnnouncementUrl;
    const metrics = [["Bid-to-cover", numberText(row.bidToCoverRatio, 2)], [stop.label, `${numberText(stop.value, 3)}%`], ["Offering amount", compactMoney(row.offeringAmount)], ["SOMA accepted", compactMoney(row.somaAccepted)], ["Indirect share", `${numberText(row.indirectBidderShare, 1)}%`], ["Direct share", `${numberText(row.directBidderShare, 1)}%`]];
    refs.detailContent.innerHTML = `<header class="detail-header"><p class="auction-kicker">Official auction result</p><h2>${escapeHtml(auctionLabel(row))}</h2><p>${displayDate(row.auctionDate)} · ${escapeHtml(row.reopening ? "Reopening" : "New issue")} · CUSIP ${escapeHtml(row.cusip || "")}</p></header><div class="detail-grid"><section><div class="detail-metrics">${metrics.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("")}</div><h3>Demand composition</h3><div class="demand-bars">${[["Primary dealer", row.primaryDealerShare], ["Direct", row.directBidderShare], ["Indirect", row.indirectBidderShare]].map(([label, value]) => `<div><span>${label}</span><i style="--share:${Math.max(0, Math.min(100, Number(value) || 0))}%"></i><strong>${numberText(value, 1)}%</strong></div>`).join("")}</div><dl class="auction-definition-list"><dt>Stop-out convention</dt><dd>${escapeHtml(row.stopOutLabel || stop.label)} is kept distinct by instrument type.</dd><dt>Bid-to-cover</dt><dd>Official published public tendered divided by public accepted; SOMA is excluded.</dd><dt>Source record</dt><dd>${sourceLink(row.apiRecordUrl || "https://www.treasurydirect.gov/auctions/auction-query/", "Open Treasury query")}</dd></dl><div class="detail-links">${sourceLink(pdf, "Open official result PDF")}${sourceLink(announcement, "Open announcement PDF")}</div></section><section class="pdf-panel">${pdf ? `<iframe src="${escapeHtml(pdf)}#view=FitH" title="Official Treasury auction result PDF"></iframe>` : `<div class="pdf-empty"><strong>No competitive result PDF is listed for this record.</strong><span>The structured Treasury record remains available.</span></div>`}</section></div>`;
    refs.detail.showModal();
    if (usedRowFallback) refs.queryStatus.textContent = "Detail refresh was unavailable; the already loaded verified database row is shown.";
  } catch (error) { refs.queryStatus.textContent = error.message; refs.queryStatus.classList.add("error"); }
}

function csvCell(value) { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function downloadCsv() {
  if (!state.query) return; const rows = queryRows(state.query); if (!rows.length) return;
  const keys = ["auctionDate", "cusip", "type", "term", "reopening", "offeringAmount", "bidToCoverRatio", "stopOutLabel", "stopOutValue", "somaAccepted", "directBidderShare", "indirectBidderShare", "primaryDealerShare", "resultPdfUrl"];
  const csv = [keys.join(","), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(","))].join("\n"); const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `treasury-auctions-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}

async function loadDashboard(force = false) {
  refs.refresh.disabled = true;
  try {
    state.dashboard = await getJson(`/api/treasury/dashboard${force ? "?refresh=1" : ""}`); renderDatabaseStatus(); renderBanners(); renderLatestResults(); renderUpcomingTable(); renderSources(); refs.queryStatus.textContent = state.dashboard.sync?.syncError ? "Live refresh failed; displaying the last verified local auction database." : "Dashboard ready. Enter a request below when you want to search or chart the database.";
  } catch (error) { refs.queryStatus.textContent = error.message; refs.queryStatus.classList.add("error"); refs.updated.textContent = "Treasury data unavailable"; }
  finally { refs.refresh.disabled = false; }
}

refs.queryForm.addEventListener("submit", (event) => { event.preventDefault(); runQuery(); });
document.querySelectorAll("[data-auction-example]").forEach((button) => button.addEventListener("click", () => { refs.prompt.value = button.dataset.auctionExample; runQuery(); }));
refs.refresh.addEventListener("click", () => loadDashboard(true));
refs.resultType.addEventListener("change", () => { state.page = 0; state.latestLimit = 15; renderLatestResults(); });
refs.resultSearch.addEventListener("input", () => { state.page = 0; renderLatestResults(); });
$("#showMoreResults").addEventListener("click", () => { state.latestLimit = Math.min(25, state.latestLimit + 10); renderLatestResults(); });
$("#previousResults").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); renderLatestResults(); });
$("#nextResults").addEventListener("click", () => { state.page += 1; renderLatestResults(); });
$("#showQueryTable").addEventListener("click", () => refs.queryTable.classList.toggle("hidden"));
$("#downloadQueryCsv").addEventListener("click", downloadCsv);
$("#closeAuctionDetail").addEventListener("click", () => refs.detail.close());
document.addEventListener("click", (event) => {
  const sort = event.target.closest("[data-sort]"); if (sort) { const key = sort.dataset.sort; state.sort.direction = state.sort.key === key ? -state.sort.direction : -1; state.sort.key = key; renderLatestResults(); return; }
  const detail = event.target.closest("[data-auction-key]"); if (detail?.dataset.auctionKey) openDetail(detail.dataset.auctionKey);
});
refs.chart.addEventListener("mousemove", (event) => { const rect = refs.chart.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; const hit = state.chartHits.find((item) => Math.hypot(item.x - x, item.y - y) < 10); if (!hit) { refs.tooltip.classList.add("hidden"); return; } refs.tooltip.innerHTML = `<strong>${displayDate(hit.row.auctionDate, true)} · ${escapeHtml(auctionLabel(hit.row))}</strong><span>${escapeHtml(METRICS[hit.metric]?.label || hit.metric)}: ${metricValue(hit.row[hit.metric], hit.metric)}</span><span>Bid-to-cover: ${numberText(hit.row.bidToCoverRatio, 2)} · CUSIP ${escapeHtml(hit.row.cusip || "")}</span>`; refs.tooltip.style.left = `${Math.min(rect.width - 250, Math.max(8, x + 12))}px`; refs.tooltip.style.top = `${Math.max(8, y - 78)}px`; refs.tooltip.classList.remove("hidden"); });
refs.chart.addEventListener("click", (event) => { const rect = refs.chart.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; const hit = state.chartHits.find((item) => Math.hypot(item.x - x, item.y - y) < 12); if (hit) openDetail(hit.row); });
let chartResizeFrame = 0;
window.addEventListener("resize", () => { window.cancelAnimationFrame(chartResizeFrame); chartResizeFrame = window.requestAnimationFrame(() => { if (state.query?.spec?.view === "chart") drawChart(state.query); }); });
loadModelStatus();

loadDashboard();
