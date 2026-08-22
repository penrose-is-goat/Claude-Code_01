const $ = (selector) => document.querySelector(selector);
const promptInput = $("#prompt");
const runBtn = $("#runBtn");
const statusEl = $("#status");
const chartPanel = $("#chartPanel");
const qualityPanel = $("#qualityPanel");
const qualityBody = $("#qualityBody");
const auditPanel = $("#auditPanel");
const sourcePanel = $("#sourcePanel");
const sourceLinks = $("#sourceLinks");
const chartTitle = $("#chartTitle");
const rangeLabel = $("#rangeLabel");
const auditRows = $("#auditRows");
const instructionAudit = $("#instructionAudit");
const canvas = $("#chart");
const tooltip = $("#chartTooltip");
const graphEditor = $("#graphEditor");
const seriesEditor = $("#seriesEditor");
const fredApiKey = $("#fredApiKey");
const ollamaModel = $("#ollamaModel");
const modelHealth = $("#modelHealth");
const saveSettingsBtn = $("#saveSettingsBtn");
const doctorBtn = $("#doctorBtn");
const settingsStatus = $("#settingsStatus");
const macroDashboard = $("#macroDashboard");
const macroDashboardGrid = $("#macroDashboardGrid");
const macroDashboardMeta = $("#macroDashboardMeta");
const refreshMacroDashboard = $("#refreshMacroDashboard");
const clarificationPanel = $("#clarificationPanel");
const clarificationForm = $("#clarificationForm");
const clarificationQuestions = $("#clarificationQuestions");
const clarificationCount = $("#clarificationCount");
const clarificationIntro = $("#clarificationIntro");
const editClarificationPrompt = $("#editClarificationPrompt");
const submitClarification = $("#submitClarification");
const ctx = canvas.getContext("2d");

const COLORS = ["#0b65c2", "#d1495b", "#16865a", "#e07a10", "#6d5bd0", "#087f8c"];
const RECESSIONS = [
  ["2001-03-01", "2001-11-30"],
  ["2007-12-01", "2009-06-30"],
  ["2020-02-01", "2020-04-30"],
];
const state = {
  payload: null,
  rows: [],
  graph: null,
  axes: null,
  render: null,
  hover: null,
  formulas: [],
  promptText: "",
  clarifications: {},
  clarificationToken: "",
  pendingClarification: null,
  clarificationMode: null,
  pendingAddRequest: "",
};
let promptRequestId = 0;
let promptController = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value, digits = 3) {
  if (!Number.isFinite(Number(value))) return "n/a";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(Number(value));
}

function safeExternalLink(url, label, className = "") {
  try {
    const parsed = new URL(String(url));
    if (!["http:", "https:"].includes(parsed.protocol)) return escapeHtml(label);
    return `<a class="${className}" href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  } catch {
    return escapeHtml(label);
  }
}

function macroCardCategory(id) {
  if (["SP500", "VIXCLS"].includes(id)) return "Markets";
  if (["DGS10", "EFFR"].includes(id)) return "Rates";
  return "Economy";
}

function macroValue(card) {
  const value = Number(card.value);
  if (!Number.isFinite(value)) return "n/a";
  if (card.id === "SP500") return formatNumber(value, 2);
  if (card.id === "CPILFESL") return `${formatNumber(value, 2)}%`;
  if (["DGS10", "EFFR", "UNRATE"].includes(card.id)) return `${formatNumber(value, 2)}%`;
  return formatNumber(value, 2);
}

function macroChange(card) {
  const change = Number(card.change);
  if (!Number.isFinite(change)) return "Change unavailable";
  const sign = change > 0 ? "+" : "";
  if (card.changeUnit === "basis-points") return `${sign}${formatNumber(change, 0)} bps`;
  if (card.changeUnit === "percentage-points") return `${sign}${formatNumber(change, 2)} pp`;
  if (card.changeUnit === "year-over-year") return `${formatNumber(change, 2)}% YoY`;
  return `${sign}${formatNumber(change, 2)}%`;
}

function macroSparkline(observations = []) {
  const values = observations.map((row) => Number(row.value)).filter(Number.isFinite);
  if (values.length < 2) return '<div class="macro-sparkline empty">Insufficient history</div>';
  const width = 240; const height = 56; const pad = 3;
  const min = Math.min(...values); const max = Math.max(...values); const spread = max - min || 1;
  const points = values.map((value, index) => {
    const x = pad + (index / (values.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / spread) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="macro-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" /></svg>`;
}

function renderMacroDashboard(payload) {
  const cards = payload.cards || [];
  macroDashboardGrid.innerHTML = cards.map((card) => {
    if (card.unavailable) {
      const detail = String(card.error || "");
      const message = detail.includes("10013")
        ? "Network access is blocked for this server session. Run the network check, then restart from a normal PowerShell window."
        : "This provider could not be refreshed. Use Network check in Data settings, then try Refresh snapshot.";
      return `<article class="macro-snapshot-card unavailable-card">
        <div class="macro-card-label"><span>${escapeHtml(macroCardCategory(card.id))}</span><time>Provider unavailable</time></div>
        <h3>${escapeHtml(card.name)}</h3>
        <strong class="macro-card-value">Unavailable</strong>
        <p title="${escapeHtml(detail)}">${escapeHtml(message)}</p>
      </article>`;
    }
    const change = Number(card.change);
    const tone = card.id === "CPILFESL" || change === 0 ? "neutral" : change > 0 ? "positive" : "negative";
    const source = safeExternalLink(card.sourceUrl, `${card.provider} · ${card.providerSeries}`, "macro-source-link");
    return `<article class="macro-snapshot-card">
      <div class="macro-card-label"><span>${escapeHtml(macroCardCategory(card.id))}</span><time>${escapeHtml(card.asOf || "")}</time></div>
      <h3>${escapeHtml(card.name)}</h3>
      <strong class="macro-card-value">${escapeHtml(macroValue(card))}</strong>
      <div class="macro-change ${tone}"><b>${escapeHtml(macroChange(card))}</b><span>${escapeHtml(card.changeLabel || "")}</span></div>
      ${macroSparkline(card.sparkline)}
      <div class="macro-card-source">${source}</div>
    </article>`;
  }).join("");
  if (!cards.length) macroDashboardGrid.innerHTML = '<article class="macro-snapshot-card dashboard-error"><strong>Snapshot unavailable</strong><span>Use Refresh snapshot after checking the local server.</span></article>';
  const errorCount = (payload.errors || []).length;
  const loadedCount = Number(payload.loadedCount ?? cards.filter((card) => !card.unavailable).length);
  const generated = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString() : "now";
  macroDashboardMeta.textContent = errorCount
    ? `Updated ${generated}. ${loadedCount} series loaded; ${errorCount} provider request${errorCount === 1 ? "" : "s"} could not be refreshed.`
    : `Updated ${generated}. Each card links to the provider record used.`;
}

async function loadMacroDashboard(force = false) {
  refreshMacroDashboard.disabled = true;
  macroDashboardMeta.textContent = "Refreshing verified market and economic observations...";
  try {
    const payload = await getJson(`/api/macro/dashboard${force ? "?refresh=1" : ""}`);
    requireCurrentBackend(payload);
    renderMacroDashboard(payload);
  } catch (error) {
    macroDashboardMeta.textContent = error.message;
    macroDashboardGrid.innerHTML = '<article class="macro-snapshot-card dashboard-error"><strong>Dashboard unavailable</strong><span>The chart builder remains available below.</span></article>';
  } finally {
    refreshMacroDashboard.disabled = false;
  }
}

function parseOptionalNumber(value) {
  return value === "" || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function hideResultPanels() {
  chartPanel.classList.add("hidden");
  qualityPanel.classList.add("hidden");
  auditPanel.classList.add("hidden");
  sourcePanel.classList.add("hidden");
}

function renderClarification(payload) {
  const questions = payload.clarification?.questions || [];
  const preview = payload.clarification?.seriesPreview || [];
  const editRequired = Boolean(payload.clarification?.editPromptRequired);
  clarificationCount.textContent = editRequired
    ? `${questions.length} concept${questions.length === 1 ? "" : "s"} unresolved`
    : `${questions.length} choice${questions.length === 1 ? "" : "s"} needed`;
  clarificationIntro.textContent = editRequired
    ? "The app could not map every requested concept exactly. It stopped before loading any partial or unrelated chart."
    : "The app found more than one defensible interpretation. Choose explicitly so it does not guess or substitute unrelated data.";
  const previewHtml = preview.length
    ? `<div class="clarification-preview"><span>${editRequired ? "Resolved subset (not loaded)" : "Concepts recognized correctly"}</span>${preview.map((row) => `<strong>${escapeHtml(row.name)} <small>${escapeHtml(row.id)}</small></strong>`).join("")}</div>`
    : "";
  clarificationQuestions.innerHTML = previewHtml + questions.map((question, questionIndex) => {
    if (question.kind === "concept-edit") {
      return `<fieldset class="clarification-question clarification-concept-edit"><legend><b>${questionIndex + 1}</b>${escapeHtml(question.title)}</legend><p>${escapeHtml(question.question)}</p><code>${escapeHtml(question.concept || "")}</code></fieldset>`;
    }
    const options = (question.options || []).map((option) => {
      const sources = option.sourceUrls || (option.sourceUrl ? [{ label: "Official series", url: option.sourceUrl }] : []);
      const source = sources.map((item) => safeExternalLink(item.url, item.label, "clarification-source")).join("");
      return `<label class="clarification-option">
        <input type="radio" name="${escapeHtml(question.id)}" value="${escapeHtml(option.value)}" required />
        <span><strong>${escapeHtml(option.label)}${option.recommended ? " · Recommended" : ""}</strong><small>${escapeHtml(option.description)}</small>${source}</span>
      </label>`;
    }).join("");
    return `<fieldset class="clarification-question"><legend><b>${questionIndex + 1}</b>${escapeHtml(question.title)}</legend><p>${escapeHtml(question.question)}</p><div class="clarification-options">${options}</div></fieldset>`;
  }).join("");
  submitClarification.classList.toggle("hidden", editRequired);
  editClarificationPrompt.textContent = editRequired ? "Edit this request" : "Wrong concept? Edit request";
  clarificationPanel.classList.remove("hidden");
  clarificationPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function getJson(url, { signal = null, timeout = 120000 } = {}) {
  if (typeof window.fetch === "function") {
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", relayAbort, { once: true });
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await window.fetch(url, { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
      return payload;
    } finally {
      window.clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", relayAbort);
    }
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

function requireCurrentBackend(payload) {
  const backend = payload?.backend;
  if (!backend?.build) {
    throw new Error("An older Macro Data Lab backend is still running. Stop it with Ctrl+C, then run python .\\serve.py again. No chart was built.");
  }
  if (backend.restartRequired) {
    throw new Error("The Macro Data Lab code changed after this backend started. Stop it with Ctrl+C, then run python .\\serve.py again. No chart was built.");
  }
  return backend;
}

async function postJson(url, body) {
  if (typeof window.fetch === "function") {
    const response = await window.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
    return payload;
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open("POST", url, true); request.setRequestHeader("Content-Type", "application/json"); request.timeout = 30000;
    request.onload = () => {
      try { const payload = JSON.parse(request.responseText || "{}"); request.status >= 200 && request.status < 300 && !payload.error ? resolve(payload) : reject(new Error(payload.error || `Request failed with HTTP ${request.status}`)); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(new Error("Local settings request failed.")); request.ontimeout = () => reject(new Error("Local settings request timed out.")); request.send(JSON.stringify(body));
  });
}

function defaultConfig(series, index, supplied = {}) {
  return {
    id: series.id,
    axis: "left",
    type: "line",
    color: COLORS[index % COLORS.length],
    lineStyle: "solid",
    lineWidth: 2,
    marker: "none",
    units: "raw",
    frequency: "original",
    aggregation: "average",
    visible: true,
    ...supplied,
  };
}

function hydratePayload(payload, preserve = false) {
  const oldByKey = new Map(
    preserve ? state.rows.map((row) => [`${row.series.id}:${row.series.providerSeries}`, row.config]) : [],
  );
  const supplied = payload.chartConfig?.series || [];
  state.rows = payload.series.map((series, index) => {
    const key = `${series.id}:${series.providerSeries}`;
    return {
      series,
      config: defaultConfig(series, index, oldByKey.get(key) || supplied[index]),
    };
  });
  if (!preserve) state.formulas = [];
  if (!preserve) {
    (payload.chartConfig?.formulas || []).forEach((supplied, index) => {
      const expression = String(supplied.expression || "").toUpperCase();
      const rpn = formulaToRpn(expression);
      const referenced = [...new Set(rpn.filter((token) => /^[A-Z]$/.test(token)))];
      const maxIndex = Math.max(...referenced.map((token) => token.charCodeAt(0) - 65));
      if (!referenced.length || maxIndex >= Math.min(state.rows.length, 26)) return;
      const definition = {
        id: `FORMULA:PROMPT:${index}`,
        name: supplied.name || `Formula: ${expression}`,
        expression,
        rpn,
        sourceKeys: state.rows.slice(0, maxIndex + 1).map((row) => `${row.series.id}:${row.series.providerSeries}`),
      };
      const formulaRow = buildFormulaRow(definition);
      if (formulaRow) { state.formulas.push(definition); state.rows.push(formulaRow); }
    });
  }
  if (preserve) {
    state.formulas.forEach((definition) => {
      const formulaRow = buildFormulaRow(definition);
      if (formulaRow) {
        const key = `${formulaRow.series.id}:${formulaRow.series.providerSeries}`;
        formulaRow.config = defaultConfig(formulaRow.series, state.rows.length, oldByKey.get(key));
        state.rows.push(formulaRow);
      }
    });
  }
  state.payload = payload;
  state.graph = preserve && state.graph ? state.graph : { ...payload.chartConfig.graph };
  state.axes = preserve && state.axes
    ? state.axes
    : {
        left: { ...payload.chartConfig.axes.left },
        right: { ...payload.chartConfig.axes.right },
      };
  state.graph.title = preserve && state.graph.title ? state.graph.title : payload.prompt;
}

function bucketKey(d, frequency) {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  if (frequency === "weekly") return `W:${Math.floor(d.getTime() / 604800000)}`;
  if (frequency === "monthly") return `${year}-${month}`;
  if (frequency === "quarterly") return `${year}-Q${Math.floor(month / 3)}`;
  if (frequency === "annual") return String(year);
  return d.toISOString().slice(0, 10);
}

function aggregatePoints(observations, frequency, aggregation) {
  const points = observations
    .map((row) => ({ date: new Date(`${row.date}T00:00:00Z`), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.date.getTime()) && Number.isFinite(row.value))
    .sort((a, b) => a.date - b.date);
  if (frequency === "original") return points;
  const buckets = new Map();
  points.forEach((point) => {
    const key = bucketKey(point.date, frequency);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(point);
  });
  return [...buckets.values()].map((rows) => {
    const value = aggregation === "sum"
      ? rows.reduce((sum, row) => sum + row.value, 0)
      : aggregation === "end"
        ? rows.at(-1).value
        : rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
    return { date: rows.at(-1).date, value };
  });
}

function calendarLagIndex(points, index, monthLag) {
  const current = points[index].date;
  const targetMonth = current.getUTCFullYear() * 12 + current.getUTCMonth() - monthLag;
  return points.findIndex((point) => (
    point.date.getUTCFullYear() * 12 + point.date.getUTCMonth() === targetMonth
  ));
}

function transformPoints(series, config) {
  const points = aggregatePoints(series.observations, config.frequency, config.aggregation);
  if (!points.length || config.units === "raw") return points;
  const base = points.find((row) => row.value !== 0)?.value;
  return points.map((point, index) => {
    if (config.units === "index") return { ...point, value: base ? (point.value / base) * 100 : NaN };
    const previousIndex = ["change_yoy", "pct_yoy"].includes(config.units)
      ? calendarLagIndex(points, index, 12)
      : config.units === "pct_change"
        ? calendarLagIndex(points, index, 1)
        : index - 1;
    if (previousIndex < 0) return { ...point, value: NaN };
    const previous = points[previousIndex];
    const delta = point.value - previous.value;
    if (config.units === "change" || config.units === "change_yoy") return { ...point, value: delta };
    if (config.units === "pct_change" || config.units === "pct_yoy") {
      return { ...point, value: previous.value ? (delta / previous.value) * 100 : NaN };
    }
    const days = Math.max(1, (point.date - previous.date) / 86400000);
    if (config.units === "compounded_annual") {
      const valid = previous.value > 0 && point.value > 0;
      return { ...point, value: valid ? (Math.pow(point.value / previous.value, 365 / days) - 1) * 100 : NaN };
    }
    if (config.units === "continuous") {
      const valid = previous.value > 0 && point.value > 0;
      return { ...point, value: valid ? Math.log(point.value / previous.value) * 100 : NaN };
    }
    if (config.units === "continuous_annual") {
      const valid = previous.value > 0 && point.value > 0;
      return { ...point, value: valid ? Math.log(point.value / previous.value) * (365 / days) * 100 : NaN };
    }
    return point;
  }).filter((row) => Number.isFinite(row.value));
}

function unitsLabel(config, series) {
  const labels = {
    raw: series.unit || "Value",
    index: "Index (first observation = 100)",
    change: "Change",
    change_yoy: "Change from year ago",
    pct_change: "Percent change",
    pct_yoy: "Percent change from year ago",
    compounded_annual: "Compounded annual rate (%)",
    continuous: "Continuously compounded rate (%)",
    continuous_annual: "Continuously compounded annual rate (%)",
  };
  return labels[config.units] || series.unit || "Value";
}

function renderSeriesEditor() {
  const unitOptions = [
    ["raw", "Native units"], ["index", "Index (first = 100)"], ["change", "Change"],
    ["change_yoy", "Change from year ago"], ["pct_change", "Percent change"],
    ["pct_yoy", "Percent change from year ago"], ["compounded_annual", "Compounded annual rate"],
    ["continuous", "Continuously compounded rate"], ["continuous_annual", "Continuous annual rate"],
  ];
  const options = (rows, current) => rows.map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`).join("");
  seriesEditor.innerHTML = state.rows.map((row, index) => {
    const config = row.config;
    return `<article class="series-control" data-series-index="${index}">
      <div class="series-control-head">
        <label class="series-name"><input data-field="visible" type="checkbox" ${config.visible ? "checked" : ""} />
          <span style="--series-color:${config.color}">${escapeHtml(row.series.name)}</span>
        </label>
        <div class="series-order">
          <button data-action="up" title="Move up">Up</button><button data-action="down" title="Move down">Down</button><button data-action="remove" title="Remove">Remove</button>
        </div>
      </div>
      <div class="series-control-grid">
        <label>Units <select data-field="units">${options(unitOptions, config.units)}</select></label>
        <label>Frequency <select data-field="frequency">${options([["original", "Original"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["quarterly", "Quarterly"], ["annual", "Annual"]], config.frequency)}</select></label>
        <label>Aggregation <select data-field="aggregation">${options([["average", "Average"], ["sum", "Sum"], ["end", "End of period"]], config.aggregation)}</select></label>
        <label>Axis <select data-field="axis">${options([["left", "Left"], ["right", "Right"]], config.axis)}</select></label>
        <label>Type <select data-field="type">${options([["line", "Line"], ["area", "Area"], ["bar", "Bar"], ["scatter", "Scatter"]], config.type)}</select></label>
        <label>Style <select data-field="lineStyle">${options([["solid", "Solid"], ["dash", "Dash"], ["dot", "Dot"], ["dashdot", "Dash-dot"]], config.lineStyle)}</select></label>
        <label>Width <input data-field="lineWidth" type="range" min="1" max="5" step="1" value="${config.lineWidth}" /></label>
        <label>Marker <select data-field="marker">${options([["none", "None"], ["circle", "Circle"], ["square", "Square"], ["diamond", "Diamond"], ["triangle", "Triangle"]], config.marker)}</select></label>
        <label>Color <input data-field="color" type="color" value="${config.color}" /></label>
      </div>
      <p>${escapeHtml(row.series.providerSeries || row.series.id)} via ${escapeHtml(row.series.provider)}</p>
    </article>`;
  }).join("");
}

function renderFormulaVariables() {
  $("#formulaVariables").innerHTML = state.rows.slice(0, 26).map((row, index) => `<span><strong>${String.fromCharCode(65 + index)}</strong>${escapeHtml(row.series.name)}</span>`).join("");
}

function formulaToRpn(expression) {
  const compact = expression.toUpperCase().replace(/\s+/g, "");
  const tokens = compact.match(/[A-Z]|(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/]/g) || [];
  if (!compact || tokens.join("") !== compact) throw new Error("Formula contains an unsupported token.");
  const output = []; const operators = []; const precedence = { "+": 1, "-": 1, "*": 2, "/": 2 };
  let expectsValue = true;
  tokens.forEach((token) => {
    if (/^[A-Z]$/.test(token) || /^\d/.test(token) || token.startsWith(".")) {
      if (!expectsValue) throw new Error("Formula is missing an operator.");
      output.push(token); expectsValue = false;
    } else if (token === "(") {
      if (!expectsValue) throw new Error("Formula is missing an operator before '('.");
      operators.push(token);
    } else if (token === ")") {
      if (expectsValue) throw new Error("Formula has an empty or incomplete parenthesis.");
      while (operators.length && operators.at(-1) !== "(") output.push(operators.pop());
      if (operators.pop() !== "(") throw new Error("Formula parentheses do not match.");
      expectsValue = false;
    } else {
      if (expectsValue) throw new Error("Formula has two operators together.");
      while (operators.length && precedence[operators.at(-1)] >= precedence[token]) output.push(operators.pop());
      operators.push(token); expectsValue = true;
    }
  });
  if (expectsValue) throw new Error("Formula ends with an operator.");
  while (operators.length) { const token = operators.pop(); if (token === "(") throw new Error("Formula parentheses do not match."); output.push(token); }
  return output;
}

function evaluateRpn(rpn, values) {
  const stack = [];
  rpn.forEach((token) => {
    if (/^[A-Z]$/.test(token)) stack.push(values[token]);
    else if (!Object.hasOwn({ "+": 1, "-": 1, "*": 1, "/": 1 }, token)) stack.push(Number(token));
    else {
      const right = stack.pop(); const left = stack.pop();
      if (!Number.isFinite(left) || !Number.isFinite(right)) { stack.push(NaN); return; }
      if (token === "+") stack.push(left + right);
      if (token === "-") stack.push(left - right);
      if (token === "*") stack.push(left * right);
      if (token === "/") stack.push(right === 0 ? NaN : left / right);
    }
  });
  return stack.length === 1 ? stack[0] : NaN;
}

function buildFormulaRow(definition) {
  const sourceRows = definition.sourceKeys.map((key) => state.rows.find((row) => `${row.series.id}:${row.series.providerSeries}` === key));
  if (sourceRows.some((row) => !row)) return null;
  const seriesPoints = sourceRows.map((row) => row.series.observations.map((point) => ({ date: point.date, value: Number(point.value) })).filter((point) => Number.isFinite(point.value)).sort((a, b) => a.date.localeCompare(b.date)));
  const dates = [...new Set(seriesPoints.flatMap((points) => points.map((point) => point.date)))].sort();
  const cursors = seriesPoints.map(() => 0); const latest = seriesPoints.map(() => null); const observations = [];
  dates.forEach((pointDate) => {
    seriesPoints.forEach((points, index) => {
      while (cursors[index] < points.length && points[cursors[index]].date <= pointDate) { latest[index] = points[cursors[index]].value; cursors[index] += 1; }
    });
    if (latest.some((value) => value == null)) return;
    const values = Object.fromEntries(latest.map((value, index) => [String.fromCharCode(65 + index), value]));
    const value = evaluateRpn(definition.rpn, values);
    if (Number.isFinite(value)) observations.push({ date: pointDate, value });
  });
  if (!observations.length) throw new Error("The formula produced no overlapping finite observations.");
  const series = {
    id: definition.id,
    name: definition.name,
    unit: "Formula result",
    provider: "Browser formula",
    providerSeries: definition.expression,
    origin: "Calculated from the raw chart series without look-ahead",
    resolution: `Formula ${definition.expression}; variables fixed when the line was created`,
    observations,
    firstDate: observations[0].date,
    lastDate: observations.at(-1).date,
    latest: observations.at(-1).value,
    quality: { status: "pass" },
  };
  return { series, config: defaultConfig(series, state.rows.length) };
}

function addFormula() {
  try {
    const expression = $("#formulaInput").value.trim(); const name = $("#formulaName").value.trim() || `Formula: ${expression}`;
    const rpn = formulaToRpn(expression); const referenced = [...new Set(rpn.filter((token) => /^[A-Z]$/.test(token)))];
    const maxIndex = Math.max(...referenced.map((token) => token.charCodeAt(0) - 65));
    if (!referenced.length || maxIndex >= Math.min(state.rows.length, 26)) throw new Error("Formula references a variable that is not listed above.");
    const sourceKeys = state.rows.slice(0, maxIndex + 1).map((row) => `${row.series.id}:${row.series.providerSeries}`);
    const definition = { id: `FORMULA:${Date.now()}`, name, expression: expression.toUpperCase(), rpn, sourceKeys };
    const row = buildFormulaRow(definition); state.formulas.push(definition); state.rows.push(row);
    $("#formulaInput").value = ""; $("#formulaName").value = ""; renderAll(); setStatus(`Added formula line “${name}”.`);
  } catch (error) { setStatus(error.message, true); }
}

function syncFormatControls() {
  $("#graphTitleInput").value = state.graph.title || "";
  $("#legendPosition").value = state.graph.legendPosition;
  $("#plotColor").value = state.graph.plotColor;
  $("#frameColor").value = state.graph.frameColor;
  $("#textColor").value = state.graph.textColor;
  $("#referenceValue").value = state.graph.referenceValue ?? "";
  ["showTitle", "showAxisTitles", "showTooltip", "recessionShading"].forEach((id) => { $(`#${id}`).checked = Boolean(state.graph[id]); });
  ["left", "right"].forEach((side) => {
    $(`#${side}AxisTitle`).value = state.axes[side].title || "";
    $(`#${side}AxisMin`).value = state.axes[side].min ?? "";
    $(`#${side}AxisMax`).value = state.axes[side].max ?? "";
    $(`#${side}AxisLog`).checked = Boolean(state.axes[side].log);
  });
}

function renderAudit() {
  auditRows.innerHTML = state.rows.map(({ series }) => {
    const fallback = series.fallbackReason || series.fallbackError || "";
    const validation = series.calculationValidation?.status ? `Calculation check: ${series.calculationValidation.status}` : "";
    const providerNotes = (series.providerNotes || []).join(" ");
    const derivation = [series.resolution, series.formula ? `Formula: ${series.formula}` : "", providerNotes, validation, series.actualThrough ? `Actual through ${series.actualThrough}` : "", fallback].filter(Boolean).join("; ");
    return `<tr><td><strong>${escapeHtml(series.name)}</strong><br><small>${escapeHtml(series.unit)}</small></td>
      <td>${safeExternalLink(series.sourceUrl, series.provider, "table-source-link")}</td><td>${escapeHtml(series.providerSeries || series.id)}</td>
      <td>${escapeHtml(series.firstDate)} to ${escapeHtml(series.lastDate)}</td>
      <td>${formatNumber(series.latest)}</td><td>${series.observations.length.toLocaleString("en-US")}</td>
      <td>${escapeHtml(derivation)}</td></tr>`;
  }).join("");
}

function renderSources() {
  const sources = [...(state.payload.sources || [])];
  state.rows.forEach(({ series }) => {
    if (!series.sourceUrl || sources.some((row) => row.url === series.sourceUrl)) return;
    sources.push({ name: series.provider, url: series.sourceUrl, role: `${series.name} (${series.providerSeries || series.id})` });
  });
  sourceLinks.innerHTML = sources.length
    ? sources.map((source) => `<article class="source-card"><span>${escapeHtml(source.role || "Data provider")}</span><strong>${safeExternalLink(source.url, source.name || source.url)}</strong><small>${escapeHtml(source.url)}</small></article>`).join("")
    : `<p class="data-note">No external source link is available for the current calculated-only lines.</p>`;
}

function renderQuality() {
  const payload = state.payload;
  const warnings = [...(payload.resolutionNotices || []), ...(payload.network?.warnings || [])];
  const cards = state.rows.map(({ series }) => {
    const seriesWarnings = series.quality?.warnings || [];
    return `<article class="quality-card ${series.quality?.status === "review" ? "warning" : ""}">
      <strong>${escapeHtml(series.name)}</strong><span>${escapeHtml(series.providerSeries || series.id)} via ${escapeHtml(series.provider)}</span>
      <p>${escapeHtml(series.firstDate)} to ${escapeHtml(series.lastDate)} | ${series.observations.length.toLocaleString("en-US")} observations${series.actualThrough ? ` | actual through ${escapeHtml(series.actualThrough)}` : ""}</p>
      <p>${escapeHtml(series.formula ? `Formula: ${series.formula}` : (series.resolution || "Curated mapping"))}</p>
      ${(series.providerNotes || []).length ? `<p>${series.providerNotes.map(escapeHtml).join("<br>")}</p>` : ""}
      ${series.calculationValidation ? `<p>Contribution check: ${escapeHtml(series.calculationValidation.status)} | ${escapeHtml(series.calculationValidation.snapshotsChecked)} published snapshot(s) | ${Number(series.calculationValidation.reconstructedQuarters || 0).toLocaleString("en-US")} reconstructed quarter(s) | published-overlap max difference ${formatNumber(Number(series.calculationValidation.publishedOverlapMaxAbsoluteError || 0) * 100, 3)} percentage points</p>` : ""}
      <p>Validation: ${escapeHtml(series.quality?.status || "not run")}${seriesWarnings.length ? `<br>${seriesWarnings.map(escapeHtml).join("<br>")}` : ""}</p>
    </article>`;
  });
  const intent = payload.intentResolution || {};
  const contract = intent.requestContract || {};
  const parsedOperands = (contract.operands || []).map((operand) => {
    const selectors = (operand.selectors || []).map((selector) => selector.kind === "population_share"
      ? `${selector.direction} ${formatNumber(Math.abs(Number(selector.upper) - Number(selector.lower)), 1)}% population group (${formatNumber(Number(selector.lower), 1)}-${formatNumber(Number(selector.upper), 1)} percentile)`
      : `${selector.kind}: ${selector.value ?? ""} ${selector.unit || ""}`.trim());
    return `${operand.sourceSpan}${selectors.length ? ` [${selectors.join(", ")}]` : ""}`;
  });
  cards.unshift(`<article class="quality-card"><strong>Request routing</strong><span>${intent.usedModel ? `Constrained local model: ${escapeHtml(intent.model || "configured model")}` : "Deterministic parser"}</span><p>Every observation, provider, formula, and source came from allowlisted code and data services. Model-generated data values: no.</p>${parsedOperands.length ? `<p>Parsed ${escapeHtml(contract.operation || "chart")}: ${escapeHtml(parsedOperands.join(" | "))}</p>` : ""}<p>Verification: ${escapeHtml(payload.verification?.status || "pass")}</p></article>`);
  if (warnings.length) cards.push(`<article class="quality-card warning"><strong>Review these details</strong><p>${warnings.map(escapeHtml).join("<br>")}</p></article>`);
  qualityBody.innerHTML = cards.join("");
}

function niceDomain(values, axis) {
  const usable = values.filter(Number.isFinite).filter((value) => !axis.log || value > 0);
  let min = axis.min ?? Math.min(...usable);
  let max = axis.max ?? Math.max(...usable);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { min -= Math.abs(min || 1) * 0.05; max += Math.abs(max || 1) * 0.05; }
  if (axis.min == null && !axis.log) min -= (max - min) * 0.06;
  if (axis.max == null && !axis.log) max += (max - min) * 0.06;
  return [min, max];
}

function drawMarker(x, y, marker, color, size = 4) {
  if (marker === "none") return;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (marker === "circle") ctx.arc(x, y, size, 0, Math.PI * 2);
  if (marker === "square") ctx.rect(x - size, y - size, size * 2, size * 2);
  if (marker === "diamond") { ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y); }
  if (marker === "triangle") { ctx.moveTo(x, y - size); ctx.lineTo(x + size, y + size); ctx.lineTo(x - size, y + size); }
  ctx.closePath(); ctx.fill();
}

function dateLabel(ms, span) {
  const d = new Date(ms);
  return span > 4 * 365 * 86400000
    ? d.toLocaleDateString("en-US", { year: "numeric", month: "short" })
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
}

function buildLegendLayout(rows, maxWidth) {
  const gap = 26;
  let x = 0;
  let rowIndex = 0;
  const items = rows.map((row) => {
    const label = `${row.series.name} (${row.config.axis})`;
    const width = Math.min(maxWidth, ctx.measureText(label).width + 38);
    if (x > 0 && x + width > maxWidth) {
      x = 0;
      rowIndex += 1;
    }
    const item = { row, label, x, rowIndex };
    x += width + gap;
    return item;
  });
  return { items, rowCount: items.length ? rowIndex + 1 : 0 };
}

function drawChart() {
  if (!state.rows.length) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(720, rect.width || 1200);
  const height = Math.max(430, rect.height || 620);
  canvas.width = width * ratio; canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.font = "12px Bahnschrift, sans-serif";
  const visibleRows = state.rows.filter((row) => row.config.visible);
  const provisionalLegend = buildLegendLayout(visibleRows, Math.max(1, width - 176));
  const legendSpace = provisionalLegend.rowCount * 20 + 16;
  const topSpace = (state.graph.showTitle ? 42 : 16) + (state.graph.legendPosition === "top" ? legendSpace : 0);
  const bottomSpace = 62 + (state.graph.legendPosition === "bottom" ? legendSpace : 0);
  const margin = { left: 88, right: 88, top: topSpace, bottom: bottomSpace };
  const plot = { x: margin.left, y: margin.top, w: width - margin.left - margin.right, h: height - margin.top - margin.bottom };
  ctx.fillStyle = state.graph.frameColor; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = state.graph.plotColor; ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
  const rows = state.rows.filter((row) => row.config.visible).map((row) => ({ ...row, points: transformPoints(row.series, row.config) })).filter((row) => row.points.length);
  if (!rows.length) return;
  const activeSides = new Set(rows.map((row) => row.config.axis));
  const allTimes = rows.flatMap((row) => row.points.map((point) => point.date.getTime()));
  const minTime = Math.min(...allTimes); const maxTime = Math.max(...allTimes); const span = Math.max(1, maxTime - minTime);
  const xFor = (dateValue) => plot.x + ((dateValue.getTime() - minTime) / span) * plot.w;
  const domains = {};
  ["left", "right"].forEach((side) => {
    domains[side] = niceDomain(rows.filter((row) => row.config.axis === side).flatMap((row) => row.points.map((point) => point.value)), state.axes[side]);
  });
  const yFor = (value, side) => {
    const [rawMin, rawMax] = domains[side];
    const log = state.axes[side].log;
    const min = log ? Math.log10(Math.max(rawMin, Number.MIN_VALUE)) : rawMin;
    const max = log ? Math.log10(Math.max(rawMax, Number.MIN_VALUE)) : rawMax;
    const normalized = ((log ? Math.log10(value) : value) - min) / Math.max(Number.EPSILON, max - min);
    return plot.y + plot.h - normalized * plot.h;
  };

  if (state.graph.recessionShading) {
    ctx.fillStyle = "rgba(93, 109, 126, 0.13)";
    RECESSIONS.forEach(([start, end]) => {
      const a = Math.max(minTime, new Date(`${start}T00:00:00Z`).getTime());
      const b = Math.min(maxTime, new Date(`${end}T00:00:00Z`).getTime());
      if (a < b) ctx.fillRect(xFor(new Date(a)), plot.y, xFor(new Date(b)) - xFor(new Date(a)), plot.h);
    });
  }

  ctx.font = "12px Bahnschrift, sans-serif";
  ctx.lineWidth = 1;
  for (let tick = 0; tick <= 5; tick += 1) {
    const y = plot.y + (plot.h * tick) / 5;
    ctx.strokeStyle = "rgba(80, 100, 120, 0.16)"; ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ["left", "right"].filter((side) => activeSides.has(side)).forEach((side) => {
      const axis = state.axes[side]; const [min, max] = domains[side];
      const value = axis.log ? Math.pow(10, Math.log10(max) - (Math.log10(max) - Math.log10(min)) * tick / 5) : max - (max - min) * tick / 5;
      ctx.fillStyle = state.graph.textColor; ctx.textAlign = side === "left" ? "right" : "left";
      ctx.fillText(formatNumber(value, 2), side === "left" ? plot.x - 10 : plot.x + plot.w + 10, y + 4);
    });
  }
  for (let tick = 0; tick <= 6; tick += 1) {
    const ms = minTime + (span * tick) / 6; const x = plot.x + (plot.w * tick) / 6;
    ctx.fillStyle = state.graph.textColor; ctx.textAlign = tick === 0 ? "left" : tick === 6 ? "right" : "center";
    ctx.fillText(dateLabel(ms, span), x, plot.y + plot.h + 26);
  }

  if (state.graph.referenceValue != null && Number.isFinite(Number(state.graph.referenceValue))) {
    const y = yFor(Number(state.graph.referenceValue), "left");
    ctx.setLineDash([6, 5]); ctx.strokeStyle = "#596979"; ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke(); ctx.setLineDash([]);
  }

  rows.forEach((row) => {
    const config = row.config; const dash = { solid: [], dash: [9, 6], dot: [2, 5], dashdot: [9, 5, 2, 5] }[config.lineStyle] || [];
    ctx.strokeStyle = config.color; ctx.fillStyle = config.color; ctx.lineWidth = Number(config.lineWidth); ctx.setLineDash(dash);
    if (config.type === "area") {
      ctx.beginPath(); row.points.forEach((point, index) => { const x = xFor(point.date); const y = yFor(point.value, config.axis); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.lineTo(xFor(row.points.at(-1).date), plot.y + plot.h); ctx.lineTo(xFor(row.points[0].date), plot.y + plot.h); ctx.closePath(); ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
    }
    if (config.type === "bar") {
      const barWidth = Math.max(1, Math.min(16, plot.w / Math.max(row.points.length, 1) * 0.72)); const zeroY = yFor(Math.max(domains[config.axis][0], Math.min(0, domains[config.axis][1])), config.axis);
      ctx.globalAlpha = 0.75; row.points.forEach((point) => { const x = xFor(point.date); const y = yFor(point.value, config.axis); ctx.fillRect(x - barWidth / 2, Math.min(y, zeroY), barWidth, Math.abs(zeroY - y)); }); ctx.globalAlpha = 1;
    } else if (config.type === "scatter") {
      row.points.forEach((point) => drawMarker(xFor(point.date), yFor(point.value, config.axis), config.marker === "none" ? "circle" : config.marker, config.color, 3.5));
    } else {
      ctx.beginPath(); row.points.forEach((point, index) => { const x = xFor(point.date); const y = yFor(point.value, config.axis); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
      if (config.marker !== "none") row.points.forEach((point) => drawMarker(xFor(point.date), yFor(point.value, config.axis), config.marker, config.color, 3));
    }
    ctx.setLineDash([]);
  });

  if (state.hover?.values?.length) {
    const anchorX = xFor(new Date(state.hover.anchor));
    if (anchorX >= plot.x && anchorX <= plot.x + plot.w) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(34, 49, 63, 0.42)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(anchorX, plot.y);
      ctx.lineTo(anchorX, plot.y + plot.h);
      ctx.stroke();
      ctx.setLineDash([]);
      state.hover.values.forEach((item) => {
        const pointX = xFor(new Date(item.date));
        const pointY = yFor(item.value, item.axis);
        if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return;
        ctx.fillStyle = item.color;
        ctx.strokeStyle = state.graph.plotColor;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(pointX, pointY, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
      ctx.restore();
    }
  }

  if (state.graph.showTitle) {
    ctx.fillStyle = state.graph.textColor; ctx.textAlign = "left"; ctx.font = "600 18px Bahnschrift, sans-serif"; ctx.fillText(state.graph.title, plot.x, 27);
  }
  if (state.graph.showAxisTitles) {
    ctx.font = "12px Bahnschrift, sans-serif";
    if (activeSides.has("left")) { ctx.save(); ctx.translate(18, plot.y + plot.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText(state.axes.left.title || "Left axis", 0, 0); ctx.restore(); }
    if (activeSides.has("right")) { ctx.save(); ctx.translate(width - 16, plot.y + plot.h / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = "center"; ctx.fillText(state.axes.right.title || "Right axis", 0, 0); ctx.restore(); }
  }
  if (state.graph.legendPosition !== "none") {
    ctx.font = "12px Bahnschrift, sans-serif"; ctx.textAlign = "left";
    const legend = buildLegendLayout(rows, plot.w);
    const legendY = state.graph.legendPosition === "top" ? (state.graph.showTitle ? 52 : 25) : plot.y + plot.h + 48;
    legend.items.forEach((item) => {
      const x = plot.x + item.x;
      const y = legendY + item.rowIndex * 20;
      ctx.fillStyle = item.row.config.color;
      ctx.fillRect(x, y - 8, 16, 3);
      ctx.fillStyle = state.graph.textColor;
      ctx.fillText(item.label, x + 22, y - 4);
    });
  }
  state.render = { rows, plot, minTime, maxTime, span, xFor };
}

function renderAll() {
  state.hover = null;
  chartTitle.textContent = state.graph.title;
  rangeLabel.textContent = state.payload.range.label;
  $("#rangeStart").value = state.payload.range.start || state.rows.map((row) => row.series.firstDate).sort()[0] || "";
  $("#rangeEnd").value = state.payload.range.end || state.rows.map((row) => row.series.lastDate).sort().at(-1) || "";
  const recognized = state.payload.chartConfig?.recognizedInstructions || [];
  instructionAudit.innerHTML = recognized.length
    ? `<strong>Prompt layout applied:</strong> ${recognized.map(escapeHtml).join(" ")}`
    : "<strong>Layout:</strong> No axis instruction was detected; use Edit graph to assign axes and styles.";
  renderSeriesEditor(); renderFormulaVariables(); syncFormatControls(); renderAudit(); renderQuality(); renderSources(); requestAnimationFrame(drawChart);
}

async function loadPrompt({ start = "", end = "", preserve = false, clarifications = null } = {}) {
  const prompt = promptInput.value.trim();
  if (!prompt) { setStatus("Enter a data request to build a chart."); return; }
  if (start && end && start > end) { setStatus("The start date must not be after the end date.", true); return; }
  if (state.promptText !== prompt) {
    state.promptText = prompt;
    state.clarifications = {};
    state.clarificationToken = "";
    state.pendingClarification = null;
  }
  if (clarifications) state.clarifications = { ...state.clarifications, ...clarifications };
  macroDashboard.classList.add("hidden");
  hideResultPanels();
  clarificationPanel.classList.add("hidden");
  const requestId = ++promptRequestId;
  if (promptController) promptController.abort();
  promptController = new AbortController();
  runBtn.disabled = true; setStatus("Resolving providers and fetching observations...");
  try {
    const params = new URLSearchParams({ q: prompt }); if (start) params.set("start", start); if (end) params.set("end", end);
    if (Object.keys(state.clarifications).length) {
      params.set("clarifications", JSON.stringify({ ...state.clarifications, _token: state.clarificationToken }));
    }
    const payload = await getJson(`/api/fred/query?${params}`, { signal: promptController.signal });
    if (requestId !== promptRequestId) return;
    requireCurrentBackend(payload);
    if (payload.requiresClarification) {
      state.pendingClarification = payload;
      state.clarificationMode = "chart";
      state.clarificationToken = payload.clarification?.token || "";
      state.clarifications = { ...state.clarifications, ...(payload.clarification?.answers || {}) };
      hideResultPanels();
      renderClarification(payload);
      const count = payload.clarification?.questions?.length || 0;
      setStatus(payload.clarification?.editPromptRequired
        ? "No unrelated substitute was loaded. Edit the unresolved concept, then build the chart again."
        : `Choose ${count} item${count === 1 ? "" : "s"} so the app can build the chart without guessing.`);
      return;
    }
    state.pendingClarification = null;
    state.clarificationMode = null;
    clarificationPanel.classList.add("hidden");
    hydratePayload(payload, preserve);
    chartPanel.classList.remove("hidden"); qualityPanel.classList.remove("hidden"); auditPanel.classList.remove("hidden"); sourcePanel.classList.remove("hidden");
    renderAll();
    const cacheNote = payload.network?.usedStaleCache ? " Last-known-good cached data is shown." : "";
    const latestObservation = payload.series.map((series) => series.lastDate).filter(Boolean).sort().at(-1) || "latest available";
    setStatus(`Loaded ${payload.series.length} source-audited series through ${latestObservation}.${cacheNote}`);
  } catch (error) {
    if (error.name !== "AbortError" && requestId === promptRequestId) {
      setStatus(error.message, true);
    }
  } finally {
    if (requestId === promptRequestId) runBtn.disabled = false;
  }
}

async function addSeries(clarifications = null) {
  const input = $("#addSeriesInput"); const request = input.value.trim(); if (!request) return;
  $("#addSeriesBtn").disabled = true; setStatus(`Resolving “${request}”...`);
  try {
    const params = new URLSearchParams({ q: request });
    if (clarifications && Object.keys(clarifications).length) {
      params.set("clarifications", JSON.stringify({ ...clarifications, _token: state.clarificationToken }));
    }
    if ($("#rangeStart").value) params.set("start", $("#rangeStart").value);
    if ($("#rangeEnd").value) params.set("end", $("#rangeEnd").value);
    const payload = await getJson(`/api/fred/query?${params}`);
    requireCurrentBackend(payload);
    if (payload.requiresClarification) {
      state.pendingClarification = payload;
      state.clarificationMode = "add";
      state.clarificationToken = payload.clarification?.token || "";
      state.pendingAddRequest = request;
      renderClarification(payload);
      setStatus("Choose the definition and display units before adding this series.");
      return;
    }
    const keys = new Set(state.rows.map((row) => `${row.series.id}:${row.series.providerSeries}`));
    payload.series.forEach((series, index) => {
      const key = `${series.id}:${series.providerSeries}`;
      if (!keys.has(key)) state.rows.push({ series, config: defaultConfig(series, state.rows.length, payload.chartConfig.series[index]) });
    });
    state.payload.series = state.rows.map((row) => row.series);
    state.payload.resolutionNotices = [...(state.payload.resolutionNotices || []), ...(payload.resolutionNotices || [])];
    input.value = ""; state.pendingClarification = null; state.clarificationMode = null; state.pendingAddRequest = ""; clarificationPanel.classList.add("hidden"); renderAll(); setStatus(`Added ${payload.series.map((row) => row.name).join(", ")}.`);
  } catch (error) { setStatus(error.message, true); } finally { $("#addSeriesBtn").disabled = false; }
}

seriesEditor.addEventListener("change", (event) => {
  const card = event.target.closest("[data-series-index]"); if (!card) return;
  const row = state.rows[Number(card.dataset.seriesIndex)]; const field = event.target.dataset.field; if (!field) return;
  row.config[field] = event.target.type === "checkbox" ? event.target.checked : event.target.type === "range" ? Number(event.target.value) : event.target.value;
  if (field === "axis" || field === "units") state.axes[row.config.axis].title = unitsLabel(row.config, row.series);
  renderSeriesEditor(); syncFormatControls(); drawChart();
});

seriesEditor.addEventListener("click", (event) => {
  const action = event.target.dataset.action; const card = event.target.closest("[data-series-index]"); if (!action || !card) return;
  const index = Number(card.dataset.seriesIndex);
  if (action === "remove") {
    const removed = state.rows[index];
    if (removed.series.id.startsWith("FORMULA:")) state.formulas = state.formulas.filter((row) => row.id !== removed.series.id);
    state.rows.splice(index, 1);
  }
  if (action === "up" && index > 0) [state.rows[index - 1], state.rows[index]] = [state.rows[index], state.rows[index - 1]];
  if (action === "down" && index < state.rows.length - 1) [state.rows[index + 1], state.rows[index]] = [state.rows[index], state.rows[index + 1]];
  renderAll();
});

function handleFormatChange(event) {
  const id = event.target.id;
  if (id === "graphTitleInput") state.graph.title = event.target.value;
  else if (["legendPosition", "plotColor", "frameColor", "textColor"].includes(id)) state.graph[id] = event.target.value;
  else if (id === "referenceValue") state.graph.referenceValue = parseOptionalNumber(event.target.value);
  else if (["showTitle", "showAxisTitles", "showTooltip", "recessionShading"].includes(id)) state.graph[id] = event.target.checked;
  else {
    const match = id.match(/^(left|right)Axis(Title|Min|Max|Log)$/); if (!match) return;
    const [, side, fieldName] = match; const field = fieldName.toLowerCase();
    state.axes[side][field] = field === "log" ? event.target.checked : ["min", "max"].includes(field) ? parseOptionalNumber(event.target.value) : event.target.value;
  }
  chartTitle.textContent = state.graph.title; drawChart();
}
$("#editor-format").addEventListener("input", handleFormatChange);
$("#editor-format").addEventListener("change", handleFormatChange);

canvas.addEventListener("mousemove", (event) => {
  if (!state.graph?.showTooltip || !state.render) {
    state.hover = null;
    tooltip.classList.add("hidden");
    requestAnimationFrame(drawChart);
    return;
  }
  const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const { plot, span, minTime, rows } = state.render;
  if (x < plot.x || x > plot.x + plot.w) {
    state.hover = null;
    tooltip.classList.add("hidden");
    requestAnimationFrame(drawChart);
    return;
  }
  const target = minTime + ((x - plot.x) / plot.w) * span;
  const values = rows.map((row) => {
    let closest = row.points[0];
    row.points.forEach((point) => { if (Math.abs(point.date - target) < Math.abs(closest.date - target)) closest = point; });
    return { row, point: closest };
  });
  const anchor = values[0].point.date;
  state.hover = {
    anchor: anchor.toISOString(),
    values: values.map(({ row, point }) => ({
      date: point.date.toISOString(),
      value: point.value,
      axis: row.config.axis,
      color: row.config.color,
    })),
  };
  requestAnimationFrame(drawChart);
  tooltip.innerHTML = `<strong>${anchor.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</strong>${values.map(({ row, point }) => `<span><i style="background:${row.config.color}"></i>${escapeHtml(row.series.name)}: ${formatNumber(point.value)} <small>${escapeHtml(unitsLabel(row.config, row.series))}</small></span>`).join("")}`;
  tooltip.style.left = `${Math.min(rect.width - 270, Math.max(10, x + 16))}px`; tooltip.style.top = `${Math.max(10, event.clientY - rect.top - 30)}px`; tooltip.classList.remove("hidden");
});
canvas.addEventListener("mouseleave", () => {
  state.hover = null;
  tooltip.classList.add("hidden");
  requestAnimationFrame(drawChart);
});

$("#editGraphBtn").addEventListener("click", () => graphEditor.classList.toggle("hidden"));
document.querySelectorAll("[data-editor-tab]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-editor-tab]").forEach((row) => row.classList.toggle("active", row === button));
  document.querySelectorAll(".editor-pane").forEach((pane) => pane.classList.toggle("active", pane.id === `editor-${button.dataset.editorTab}`));
}));
document.querySelectorAll("[data-range-years]").forEach((button) => button.addEventListener("click", () => {
  const end = $("#rangeEnd").value ? new Date(`${$("#rangeEnd").value}T00:00:00Z`) : new Date();
  const start = new Date(end); start.setUTCFullYear(start.getUTCFullYear() - Number(button.dataset.rangeYears));
  loadPrompt({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), preserve: true });
}));
$("[data-range-max]").addEventListener("click", () => loadPrompt({ start: "1900-01-01", end: $("#rangeEnd").value, preserve: true }));
$("#applyRangeBtn").addEventListener("click", () => loadPrompt({ start: $("#rangeStart").value, end: $("#rangeEnd").value, preserve: true }));
$("#addSeriesBtn").addEventListener("click", addSeries);
$("#addFormulaBtn").addEventListener("click", addFormula);
$("#addSeriesInput").addEventListener("keydown", (event) => { if (event.key === "Enter") addSeries(); });
runBtn.addEventListener("click", () => loadPrompt());
refreshMacroDashboard.addEventListener("click", () => loadMacroDashboard(true));
clarificationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.pendingClarification) return;
  const form = new FormData(clarificationForm);
  const answers = {};
  (state.pendingClarification.clarification?.questions || []).forEach((question) => {
    const value = form.get(question.id);
    if (value) answers[question.id] = String(value);
  });
  if (state.clarificationMode === "add") {
    $("#addSeriesInput").value = state.pendingAddRequest;
    addSeries(answers);
  } else {
    loadPrompt({ clarifications: answers });
  }
});
editClarificationPrompt.addEventListener("click", () => {
  clarificationPanel.classList.add("hidden");
  promptInput.focus();
  promptInput.select();
  promptInput.scrollIntoView({ behavior: "smooth", block: "center" });
  setStatus("Edit the data concept or add a provider-native series ID, then build the chart again.");
});
promptInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); loadPrompt(); } });
window.addEventListener("resize", () => requestAnimationFrame(drawChart));

saveSettingsBtn.addEventListener("click", async () => {
  saveSettingsBtn.disabled = true;
  try { const body = { ollamaModel: ollamaModel.value.trim() }; if (fredApiKey.value.trim()) body.fredApiKey = fredApiKey.value.trim(); const payload = await postJson("/api/settings", body); fredApiKey.value = ""; settingsStatus.textContent = payload.fredApiKeyConfigured ? "FRED API key saved locally." : "Provider mappings work without a FRED API key."; await refreshModelHealth(true); }
  catch (error) { settingsStatus.textContent = error.message; } finally { saveSettingsBtn.disabled = false; }
});
doctorBtn.addEventListener("click", async () => {
  doctorBtn.disabled = true; settingsStatus.textContent = "Checking DNS, HTTPS, and providers...";
  try { const payload = await getJson("/api/doctor"); settingsStatus.textContent = payload.https?.ok ? `Network passed through ${payload.https.transport}.` : `${payload.classification}: ${payload.https?.error || "Unavailable"}`; }
  catch (error) { settingsStatus.textContent = error.message; } finally { doctorBtn.disabled = false; }
});

async function refreshModelHealth(force = false) {
  try {
    const payload = await getJson(`/api/model/status${force ? "?refresh=1" : ""}`);
    modelHealth.textContent = payload.message;
    modelHealth.classList.toggle("error", !payload.ready);
    return payload;
  } catch (error) {
    modelHealth.textContent = error.message;
    modelHealth.classList.add("error");
    return null;
  }
}

getJson("/api/settings").then((payload) => {
  ollamaModel.value = payload.ollamaModel || "qwen3.5:9b";
  settingsStatus.textContent = payload.fredApiKeyConfigured ? "FRED API key configured locally." : "Built-in mappings work without a FRED API key.";
}).catch((error) => { settingsStatus.textContent = error.message; });
refreshModelHealth();

async function startMacroLab() {
  try {
    const health = await getJson("/api/health");
    const backend = requireCurrentBackend(health);
    const stamp = $("#backendStamp");
    if (stamp) stamp.textContent = `Data engine ${backend.build} started ${backend.startedAt}`;
    await loadMacroDashboard();
    if (!state.promptText && !state.payload && !state.pendingClarification) {
      setStatus("Dashboard ready. Enter a request below when you want to build a custom chart.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

startMacroLab();
