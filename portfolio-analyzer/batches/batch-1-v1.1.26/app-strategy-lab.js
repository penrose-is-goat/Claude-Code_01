/* ============================================================
   Portfolio Analyzer Pro - Strategy Lab
   ============================================================ */

PA.StrategyLab = {
  examples: [
    {
      label: 'SPY / VIX weekly stress',
      prompt: 'Test how often the S&P is down one week after the VIX and S&P move the same for more than two days in a week.'
    },
    {
      label: '10Y yield YTD high check',
      prompt: 'Test how often the S&P is down one week after the 10-Yr treasury yield hits a new year to date high.'
    },
    {
      label: 'VIX YTD high check',
      prompt: 'Test how often the S&P is down one week after the VIX hits a year to date high.'
    },
    {
      label: 'QQQ opposite-direction check',
      prompt: 'Check whether QQQ is up five days later after QQQ and VIX move in opposite directions at least three days in a week.'
    },
    {
      label: 'Gold and dollar event study',
      prompt: 'How often is GLD up two weeks later after gold and the dollar fall together three days in a week?'
    }
  ],

  aliasMap: [
    { symbol: '^VIX', aliases: [/\bvix\b/, /\bvolatility index\b/] },
    { symbol: 'SPY', aliases: [/\bspy\b/] },
    { symbol: 'SP500', aliases: [/\bs&p 500\b/, /\bs&p\b/, /\bspx\b/, /\bs and p 500\b/, /\bsp500\b/] },
    { symbol: 'QQQ', aliases: [/\bqqq\b/, /\bnasdaq 100\b/, /\bnasdaq\b/] },
    { symbol: 'DIA', aliases: [/\bdia\b/, /\bdow jones\b/, /\bdow\b/] },
    { symbol: 'IWM', aliases: [/\biwm\b/, /\brussell 2000\b/, /\brussell\b/] },
    { symbol: 'DGS10', aliases: [/\bdgs10\b/, /\bdg10\b/, /\b10(?:\s*|-)?yr(?:\s+treasury)?(?:\s+yield)?\b/, /\b10(?:\s*|-)?year(?:\s+treasury)?(?:\s+yield)?\b/, /\b10y(?:\s+treasury)?(?:\s+yield)?\b/, /\b10(?:\s*|-)?yr note yield\b/, /\b10(?:\s*|-)?year note yield\b/] },
    { symbol: 'IEF', aliases: [/\bief\b/, /\b7(?:\s*|-)?10 year treasury\b/, /\b7(?:\s*|-)?10 yr treasury\b/] },
    { symbol: 'TLT', aliases: [/\btlt\b/, /\blong bond\b/, /\blong treasury bond\b/, /\b20(?:\s*|-)?year treasury\b/] },
    { symbol: 'GLD', aliases: [/\bgld\b/, /\bgold\b/] },
    { symbol: 'UUP', aliases: [/\buup\b/, /\bus dollar\b/, /\bdollar\b/, /\bdxy\b/] },
    { symbol: 'AGG', aliases: [/\bagg\b/, /\baggregate bond\b/] },
    { symbol: 'HYG', aliases: [/\bhyg\b/, /\bhigh yield\b/] },
    { symbol: 'XLF', aliases: [/\bxlf\b/, /\bfinancials\b/] },
    { symbol: 'XLE', aliases: [/\bxle\b/, /\benergy\b/] },
    { symbol: 'XLK', aliases: [/\bxlk\b/, /\btechnology\b/] }
  ],

  wordNumbers: {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    twentyone: 21,
    'twenty-one': 21,
    thirty: 30
  },

  seriesCatalog: {
    SP500: {
      label: 'S&P 500',
      canonicalSymbol: 'SP500',
      targetCandidates: [
        { symbol: 'SPY', label: 'SPY ETF proxy', mode: 'direct', minCorrelation: 0.985 }
      ],
      signalCandidates: [
        { symbol: 'SPY', label: 'SPY ETF proxy', mode: 'direct', minCorrelation: 0.985, minOverlapRatio: 0.9 }
      ]
    },
    DGS10: {
      label: '10-year Treasury yield',
      canonicalSymbol: 'DGS10',
      preferCanonicalSignal: true,
      signalCandidates: [
        { symbol: 'IEF', label: 'IEF inverse proxy', mode: 'inverse', minOverlapRatio: 0.8 },
        { symbol: 'TLT', label: 'TLT inverse proxy', mode: 'inverse', minOverlapRatio: 0.75 }
      ]
    }
  },

  state: {
    autoParseTimer: null,
    lastParsedPrompt: '',
    lastSpec: null,
    promptDirty: false
  },

  init() {
    if (!document.getElementById('sl-prompt')) return;
    this.renderExampleButtons();
    this.bindEvents();
    this.loadExample(0, false);
    this.parsePrompt({ silent: true });
    this.renderEmptyState();
  },

  bindEvents() {
    const parseBtn = document.getElementById('sl-parse-btn');
    const runBtn = document.getElementById('sl-run-btn');
    const prompt = document.getElementById('sl-prompt');

    parseBtn?.addEventListener('click', () => this.parsePrompt());
    runBtn?.addEventListener('click', () => this.run());

    prompt?.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        this.run();
      }
    });
    prompt?.addEventListener('input', () => this.handlePromptInput());
    prompt?.addEventListener('blur', () => {
      const currentPrompt = (prompt?.value || '').trim();
      if (currentPrompt && this.state.promptDirty) {
        this.parsePrompt({ silent: true });
      }
    });

    document.querySelectorAll('#tab-strategy input, #tab-strategy select, #tab-strategy textarea').forEach(el => {
      if (el.id === 'sl-prompt') return;
      el.addEventListener('input', () => {
        const spec = this.getFormConfig();
        this.updateFormMode(spec);
        this.renderSummary(spec);
      });
      el.addEventListener('change', () => {
        const spec = this.getFormConfig();
        this.updateFormMode(spec);
        this.renderSummary(spec);
      });
    });
  },

  handlePromptInput() {
    const prompt = (document.getElementById('sl-prompt')?.value || '').trim();
    this.state.promptDirty = this.normalizePromptText(prompt) !== this.normalizePromptText(this.state.lastParsedPrompt);
    if (this.state.autoParseTimer) {
      clearTimeout(this.state.autoParseTimer);
      this.state.autoParseTimer = null;
    }
    if (!prompt) return;
    this.state.autoParseTimer = setTimeout(() => {
      this.parsePrompt({ silent: true });
    }, 350);
  },

  normalizePromptText(prompt='') {
    return String(prompt || '').trim().replace(/\s+/g, ' ').toLowerCase();
  },

  isFredSymbol(symbol='') {
    return ['SP500', 'DGS10'].includes(String(symbol || '').trim().toUpperCase());
  },

  isDescriptiveOnlySymbol(symbol='') {
    const normalized = String(symbol || '').trim().toUpperCase();
    return normalized.startsWith('^') || this.isFredSymbol(normalized);
  },

  labelSymbol(symbol='', options={}) {
    const raw = String(symbol || '').trim();
    if (!raw) return '';
    const normalized = raw.toUpperCase();
    const withSource = Boolean(options.withSource);
    const labels = {
      '^VIX': 'VIX',
      'SPY': 'SPY',
      'SP500': withSource ? 'S&P 500 (FRED price index)' : 'S&P 500',
      'QQQ': 'QQQ',
      'DIA': 'DIA',
      'IWM': 'IWM',
      'DGS10': withSource ? '10-year Treasury yield (FRED)' : '10-year Treasury yield',
      'IEF': 'IEF',
      'TLT': 'TLT',
      'GLD': 'GLD',
      'UUP': 'UUP',
      'AGG': 'AGG',
      'HYG': 'HYG',
      'XLF': 'XLF',
      'XLE': 'XLE',
      'XLK': 'XLK'
    };
    return labels[normalized] || raw;
  },

  providerSourceLabel(source='') {
    const normalized = String(source || '').trim().toLowerCase();
    const labels = {
      fred: 'FRED',
      yfinance: 'Yahoo via yfinance',
      'yfinance-fallback': 'Yahoo via yfinance fallback',
      'yahoo-chart': 'Yahoo chart API',
      'yahoo-chart-fallback': 'Yahoo chart fallback'
    };
    return labels[normalized] || (source || 'Unknown provider');
  },

  describeProviderTransform(transform='') {
    const normalized = String(transform || '').trim().toLowerCase();
    if (!normalized || normalized === 'identity') return '';
    const labels = {
      divide_by_10: 'yield-scale adjustment',
      negated_price: 'inverse-price transform'
    };
    return labels[normalized] || normalized.replace(/_/g, ' ');
  },

  describeHistorySource(history={}) {
    if (!history) return 'Unavailable';
    const provider = this.providerSourceLabel(history.providerSource);
    const providerSymbol = String(history.providerSeriesId || history.providerSymbol || history.ticker || '').trim();
    const fallbackLabel = String(history.providerFallbackLabel || '').trim();
    const transform = this.describeProviderTransform(history.providerTransform);
    let label = fallbackLabel || [provider, providerSymbol].filter(Boolean).join(' ');
    if (!label) label = provider || providerSymbol || 'Unavailable';
    if (transform) label += ` (${transform})`;
    return label;
  },

  describeHistoryAttempts(history={}) {
    const attempts = Array.isArray(history?.providerAttemptChain) ? history.providerAttemptChain.filter(Boolean) : [];
    if (!attempts.length) return this.describeHistorySource(history);
    return attempts.join(' -> ');
  },

  formatLevelValue(value, symbol='') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 'N/A';
    return String(symbol || '').trim().toUpperCase() === 'DGS10'
      ? `${PA.Fmt.number(numeric, 2)}%`
      : PA.Fmt.number(numeric, 2);
  },

  catalogEntry(symbol='') {
    const normalized = String(symbol || '').trim().toUpperCase();
    return this.seriesCatalog[normalized] || null;
  },

  historyPriceSeries(history={}) {
    const adjusted = history?.adjustedPrices;
    if (Array.isArray(adjusted) && adjusted.some(Number.isFinite)) return adjusted;
    return history?.prices || [];
  },

  historyByDate(history={}) {
    const map = new Map();
    (history?.dates || []).forEach((date, index) => {
      const key = this.normalizeDateKey(date);
      if (!key) return;
      const value = this.historyPriceSeries(history)?.[index];
      if (Number.isFinite(value)) map.set(key, value);
    });
    return map;
  },

  alignedHistoryValues(historyA={}, historyB={}) {
    const mapA = this.historyByDate(historyA);
    const mapB = this.historyByDate(historyB);
    const dates = [...mapA.keys()].filter(date => mapB.has(date)).sort();
    return {
      dates,
      a: dates.map(date => mapA.get(date)),
      b: dates.map(date => mapB.get(date))
    };
  },

  pearsonCorrelation(valuesA=[], valuesB=[]) {
    const pairs = [];
    for (let index = 0; index < Math.min(valuesA.length, valuesB.length); index++) {
      const a = Number(valuesA[index]);
      const b = Number(valuesB[index]);
      if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
    }
    if (pairs.length < 5) return null;
    const aValues = pairs.map(pair => pair[0]);
    const bValues = pairs.map(pair => pair[1]);
    const meanA = PA.Compute.mean(aValues);
    const meanB = PA.Compute.mean(bValues);
    let numerator = 0;
    let denomA = 0;
    let denomB = 0;
    pairs.forEach(([a, b]) => {
      const da = a - meanA;
      const db = b - meanB;
      numerator += da * db;
      denomA += da * da;
      denomB += db * db;
    });
    if (denomA <= 0 || denomB <= 0) return null;
    return numerator / Math.sqrt(denomA * denomB);
  },

  transformLevelsForProxy(values=[], mode='direct') {
    return (values || []).map(value => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      if (mode === 'inverse') return -numeric;
      return numeric;
    });
  },

  transformReturnsForProxy(values=[], mode='direct') {
    return (values || []).map(value => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      return mode === 'inverse' ? -numeric : numeric;
    });
  },

  buildExtremeFlagsFromLevels(dates=[], levels=[], config={}) {
    return (dates || []).map((_, index) => {
      if (index === 0) return false;
      return Boolean(this.evaluateExtremeTrigger(dates, levels, index, config)?.hit);
    });
  },

  eventFlagOverlap(referenceFlags=[], candidateFlags=[], tolerance=1) {
    const referenceIndexes = [];
    const candidateIndexes = [];
    referenceFlags.forEach((flag, index) => { if (flag) referenceIndexes.push(index); });
    candidateFlags.forEach((flag, index) => { if (flag) candidateIndexes.push(index); });
    if (!referenceIndexes.length || !candidateIndexes.length) return 0;
    let matched = 0;
    referenceIndexes.forEach(index => {
      const found = candidateIndexes.some(candidateIndex => Math.abs(candidateIndex - index) <= tolerance);
      if (found) matched += 1;
    });
    return matched / Math.max(referenceIndexes.length, candidateIndexes.length);
  },

  evaluateTargetProxyCandidate(canonicalHistory={}, candidateHistory={}, candidate={}) {
    const aligned = this.alignedHistoryValues(canonicalHistory, candidateHistory);
    if ((aligned.dates || []).length < 60) {
      return {
        accepted: false,
        correlation: null,
        reason: 'Rejected: not enough overlapping history to validate the proxy.'
      };
    }
    const canonicalReturns = PA.Compute.dailyReturns(aligned.a);
    const candidateReturns = PA.Compute.dailyReturns(aligned.b);
    const correlation = this.pearsonCorrelation(canonicalReturns, candidateReturns);
    const accepted = Number.isFinite(correlation) && correlation >= Number(candidate.minCorrelation || 0.98);
    return {
      accepted,
      correlation,
      reason: accepted
        ? `Accepted: daily return correlation ${PA.Fmt.ratio(correlation, 3)} cleared the proxy threshold.`
        : `Rejected: daily return correlation ${Number.isFinite(correlation) ? PA.Fmt.ratio(correlation, 3) : 'N/A'} was too weak for a safe proxy.`
    };
  },

  evaluateSignalProxyCandidate(canonicalHistory={}, candidateHistory={}, config={}, candidate={}) {
    const aligned = this.alignedHistoryValues(canonicalHistory, candidateHistory);
    if ((aligned.dates || []).length < 80) {
      return {
        accepted: false,
        overlapRatio: null,
        canonicalEventCount: 0,
        candidateEventCount: 0,
        reason: 'Rejected: not enough overlapping history to validate signal timing.'
      };
    }
    if (config.eventMode !== 'price-extreme') {
      return {
        accepted: false,
        overlapRatio: null,
        canonicalEventCount: 0,
        candidateEventCount: 0,
        reason: 'Rejected: proxy signal validation is only enabled for price-extreme prompts right now.'
      };
    }
    const canonicalFlags = this.buildExtremeFlagsFromLevels(aligned.dates, aligned.a, config);
    const candidateFlags = this.buildExtremeFlagsFromLevels(aligned.dates, this.transformLevelsForProxy(aligned.b, candidate.mode), config);
    const canonicalEventCount = canonicalFlags.filter(Boolean).length;
    const candidateEventCount = candidateFlags.filter(Boolean).length;
    const overlapRatio = this.eventFlagOverlap(canonicalFlags, candidateFlags, 1);
    const accepted = canonicalEventCount > 0
      && candidateEventCount > 0
      && overlapRatio >= Number(candidate.minOverlapRatio || 0.8);
    return {
      accepted,
      overlapRatio,
      canonicalEventCount,
      candidateEventCount,
      reason: accepted
        ? `Accepted: event overlap ${PA.Fmt.pct(overlapRatio)} was high enough to trust the proxy timing.`
        : `Rejected: proxy timing overlap was only ${Number.isFinite(overlapRatio) ? PA.Fmt.pct(overlapRatio) : 'N/A'} (${candidateEventCount} proxy signals versus ${canonicalEventCount} canonical signals).`
    };
  },

  collectStudySymbols(config={}) {
    const symbols = new Set([config.targetSymbol, config.contextSymbol]);
    [config.targetSymbol, config.contextSymbol].forEach((symbol, index) => {
      const role = index === 0 ? 'target' : 'context';
      const meta = this.catalogEntry(symbol);
      if (!meta) return;
      symbols.add(meta.canonicalSymbol || symbol);
      const candidates = role === 'target' ? (meta.targetCandidates || []) : (meta.signalCandidates || []);
      candidates.forEach(candidate => {
        if (candidate?.symbol) symbols.add(String(candidate.symbol).toUpperCase());
      });
    });
    return [...symbols].filter(Boolean);
  },

  buildStudyPlan(config={}, parsedHistories={}) {
    const targetPlan = this.resolveTargetPlan(config, parsedHistories);
    const contextPlan = this.resolveContextPlan(config, parsedHistories);
    return {
      target: targetPlan,
      context: contextPlan
    };
  },

  resolveTargetPlan(config={}, parsedHistories={}) {
    const requestedSymbol = String(config.targetSymbol || 'SPY').toUpperCase();
    const meta = this.catalogEntry(requestedSymbol);
    const requestedLabel = this.labelSymbol(requestedSymbol, { withSource: true });
    const canonicalSymbol = meta?.canonicalSymbol || requestedSymbol;
    const canonicalHistory = parsedHistories[canonicalSymbol] || parsedHistories[requestedSymbol];
    const basePlan = {
      requestedSymbol,
      requestedLabel,
      canonicalSymbol,
      canonicalLabel: this.labelSymbol(canonicalSymbol, { withSource: true }),
      selectedSymbol: canonicalSymbol,
      selectedLabel: this.labelSymbol(canonicalSymbol, { withSource: true }),
      selectedHistory: canonicalHistory,
      usingProxy: false,
      resolutionNote: 'Using the requested target series directly.',
      audits: []
    };
    if (!meta?.targetCandidates?.length || !canonicalHistory) return basePlan;

    const audits = meta.targetCandidates.map(candidate => {
      const history = parsedHistories[candidate.symbol];
      if (!history) {
        return {
          symbol: candidate.symbol,
          label: candidate.label || candidate.symbol,
          accepted: false,
          correlation: null,
          reason: 'Rejected: proxy history was unavailable.'
        };
      }
      return {
        symbol: candidate.symbol,
        label: candidate.label || candidate.symbol,
        ...this.evaluateTargetProxyCandidate(canonicalHistory, history, candidate)
      };
    });
    const accepted = audits
      .filter(audit => audit.accepted)
      .sort((a, b) => (b.correlation || -Infinity) - (a.correlation || -Infinity))[0];
    if (!accepted) {
      return {
        ...basePlan,
        resolutionNote: `${requestedLabel} stayed on the canonical series because no ETF proxy cleared the consistency check.`,
        audits
      };
    }
    return {
      ...basePlan,
      selectedSymbol: accepted.symbol,
      selectedLabel: `${accepted.symbol} proxy for ${this.labelSymbol(requestedSymbol)}`,
      selectedHistory: parsedHistories[accepted.symbol],
      usingProxy: true,
      resolutionNote: `${this.labelSymbol(requestedSymbol)} was measured with ${accepted.symbol} after the proxy passed the consistency check (${PA.Fmt.ratio(accepted.correlation, 3)} daily return correlation versus the canonical series).`,
      audits
    };
  },

  resolveContextPlan(config={}, parsedHistories={}) {
    const requestedSymbol = String(config.contextSymbol || '^VIX').toUpperCase();
    const meta = this.catalogEntry(requestedSymbol);
    const requestedLabel = this.labelSymbol(requestedSymbol, { withSource: true });
    const canonicalSymbol = meta?.canonicalSymbol || requestedSymbol;
    const canonicalHistory = parsedHistories[canonicalSymbol] || parsedHistories[requestedSymbol];
    const audits = (meta?.signalCandidates || []).map(candidate => {
      const history = parsedHistories[candidate.symbol];
      if (!history) {
        return {
          symbol: candidate.symbol,
          label: candidate.label || candidate.symbol,
          accepted: false,
          overlapRatio: null,
          canonicalEventCount: 0,
          candidateEventCount: 0,
          reason: 'Rejected: proxy history was unavailable.'
        };
      }
      return {
        symbol: candidate.symbol,
        label: candidate.label || candidate.symbol,
        ...this.evaluateSignalProxyCandidate(canonicalHistory, history, config, candidate)
      };
    });

    if (meta?.preferCanonicalSignal) {
      return {
        requestedSymbol,
        requestedLabel,
        canonicalSymbol,
        canonicalLabel: this.labelSymbol(canonicalSymbol, { withSource: true }),
        selectedSymbol: canonicalSymbol,
        selectedLabel: this.labelSymbol(canonicalSymbol, { withSource: true }),
        selectedHistory: canonicalHistory,
        usingProxy: false,
        resolutionNote: `${this.labelSymbol(requestedSymbol)} stayed on the canonical signal series because inverse ETF proxies can distort event timing. Proxy candidates were audited but not allowed to define the signal.`,
        audits
      };
    }

    const accepted = audits.find(audit => audit.accepted);
    if (accepted) {
      return {
        requestedSymbol,
        requestedLabel,
        canonicalSymbol,
        canonicalLabel: this.labelSymbol(canonicalSymbol, { withSource: true }),
        selectedSymbol: accepted.symbol,
        selectedLabel: `${accepted.symbol} proxy for ${this.labelSymbol(requestedSymbol)}`,
        selectedHistory: parsedHistories[accepted.symbol],
        usingProxy: true,
        resolutionNote: `${this.labelSymbol(requestedSymbol)} used ${accepted.symbol} after the signal-timing audit passed.`,
        audits
      };
    }

    return {
      requestedSymbol,
      requestedLabel,
      canonicalSymbol,
      canonicalLabel: this.labelSymbol(canonicalSymbol, { withSource: true }),
      selectedSymbol: canonicalSymbol,
      selectedLabel: this.labelSymbol(canonicalSymbol, { withSource: true }),
      selectedHistory: canonicalHistory,
      usingProxy: false,
      resolutionNote: `${this.labelSymbol(requestedSymbol)} stayed on the canonical signal series because no proxy passed the event-timing audit.`,
      audits
    };
  },

  renderExampleButtons() {
    const container = document.getElementById('sl-example-chips');
    if (!container) return;
    container.innerHTML = this.examples.map((example, index) => `
      <button type="button" class="chip-btn" data-example-index="${index}">
        ${PA.UI.escapeHtml(example.label)}
      </button>
    `).join('');
    container.querySelectorAll('[data-example-index]').forEach(btn => {
      btn.addEventListener('click', () => this.loadExample(Number(btn.dataset.exampleIndex || 0)));
    });
  },

  loadExample(index=0, parseAfter=true) {
    const example = this.examples[index] || this.examples[0];
    const prompt = document.getElementById('sl-prompt');
    if (prompt) prompt.value = example.prompt;
    if (parseAfter) this.parsePrompt();
  },

  parsePrompt(options={}) {
    const prompt = (document.getElementById('sl-prompt')?.value || '').trim();
    if (!prompt) {
      PA.UI.toast('Enter a strategy idea first', 'error');
      return null;
    }
    const spec = this.inferSpec(prompt);
    this.applySpecToForm(spec);
    this.updateFormMode(spec);
    this.renderSummary(spec);
    this.state.lastParsedPrompt = prompt;
    this.state.lastSpec = spec;
    this.state.promptDirty = false;
    if (!options.silent) {
      PA.UI.toast('Prompt parsed into a draft event-study specification', 'success');
    }
    return spec;
  },

  resolveExecutionConfig() {
    const prompt = (document.getElementById('sl-prompt')?.value || '').trim();
    const promptChanged = this.normalizePromptText(prompt) !== this.normalizePromptText(this.state.lastParsedPrompt);
    if (prompt && (this.state.promptDirty || promptChanged)) {
      return this.parsePrompt({ silent: true }) || this.getFormConfig();
    }
    const spec = this.getFormConfig();
    this.updateFormMode(spec);
    return spec;
  },

  inferSpec(prompt) {
    const lower = prompt.toLowerCase();
    const studyType = this.inferStudyType(lower);
    const eventMode = this.inferEventMode(lower);
    const symbols = this.detectSymbols(prompt);
    const targetSymbol = this.inferTargetSymbol(prompt, symbols) || 'SPY';
    const inferredContext = this.inferContextSymbol(prompt, symbols, targetSymbol, eventMode);
    const forwardSessions = this.inferForwardSessions(lower);
    const outcomeDirection = this.inferOutcomeDirection(lower);
    const entryMode = /\btradable\b|\benter\b|\bexecution\b|\bnext open\b/.test(lower) ? 'next-open' : 'signal-close';
    const range = this.inferRange(lower, forwardSessions, eventMode);
    let contextSymbol = inferredContext || (eventMode === 'price-extreme' ? targetSymbol : '^VIX');
    let triggerSymbol = contextSymbol;
    let relation = this.inferRelation(lower);
    let windowSessions = this.inferWindowSessions(lower);
    let threshold = Math.max(1, Math.min(windowSessions, this.inferThreshold(lower, windowSessions)));
    let extremeDirection = null;
    let extremeReference = null;
    let extremeReferenceLabel = '';
    let extremeStrict = false;

    if (eventMode === 'price-extreme') {
      const extremeSpec = this.inferExtremeSpec(prompt, windowSessions);
      triggerSymbol = this.inferTriggerSymbol(prompt, symbols, targetSymbol, contextSymbol);
      contextSymbol = triggerSymbol;
      relation = extremeSpec.direction === 'low' ? 'opposite-direction' : 'same-direction';
      windowSessions = extremeSpec.windowSessions;
      threshold = 1;
      extremeDirection = extremeSpec.direction;
      extremeReference = extremeSpec.reference;
      extremeReferenceLabel = extremeSpec.referenceLabel;
      extremeStrict = extremeSpec.strict;
    }

    const notes = [];
    if (studyType !== 'event-study') {
      notes.push(`This prompt reads like ${this.labelStudyType(studyType)}. The current runner executes the event-study version of the idea first.`);
    }
    if (this.isDescriptiveOnlySymbol(targetSymbol)) {
      notes.push('Cash index targets are descriptive rather than directly tradable. Switch to an ETF proxy if you want execution-aware results.');
    }
    if (eventMode !== 'price-extreme' && contextSymbol === targetSymbol) {
      notes.push('Target and context are the same symbol right now. Consider using a second asset or volatility index for a cleaner trigger.');
    }
    if ([targetSymbol, contextSymbol, triggerSymbol].some(symbol => this.isFredSymbol(symbol))) {
      notes.push('This prompt maps to FRED economic/index history when available so the study uses the named series instead of silently substituting an ETF proxy.');
    }
    if (/same direction|same way|move the same/.test(lower) && !/\bvix\b/.test(lower)) {
      notes.push('Cross-asset sign matching is easiest to trust when both symbols and the event window are explicit.');
    }
    if (eventMode === 'price-extreme') {
      notes.push('Extreme-event mode runs directly from the latest prompt. Relation switches to High or Low, and matching-days is disabled because the signal is a single event date.');
      if (extremeReference === 'ytd') {
        notes.push('Year-to-date highs and lows reset at the first trading session of each calendar year.');
      }
    }

    return {
      prompt,
      studyType,
      executedStudyType: 'event-study',
      eventMode,
      targetSymbol,
      contextSymbol,
      triggerSymbol,
      relation,
      windowSessions,
      threshold,
      forwardSessions,
      outcomeDirection,
      entryMode,
      range,
      extremeDirection,
      extremeReference,
      extremeReferenceLabel,
      extremeStrict,
      suppressOverlap: true,
      notes
    };
  },

  detectSymbols(prompt) {
    const mentioned = [];
    const lower = prompt.toLowerCase();
    this.aliasMap.forEach(entry => {
      if (entry.aliases.some(regex => regex.test(lower)) && !mentioned.includes(entry.symbol)) {
        mentioned.push(entry.symbol);
      }
    });

    const explicit = [...new Set((prompt.match(/\^?[A-Z]{1,5}\b/g) || []))]
      .map(token => token.trim().toUpperCase())
      .filter(token => !['A', 'AN', 'AND', 'OR', 'THE', 'IN', 'UP', 'ON'].includes(token));

    explicit.forEach(symbol => {
      if (!mentioned.includes(symbol)) mentioned.push(symbol);
    });
    return mentioned;
  },

  inferTargetSymbol(prompt, symbols=[]) {
    const lower = prompt.toLowerCase();
    const beforeAfter = lower.split(/\bafter\b/)[0] || lower;
    const beforeSymbols = this.matchAliases(beforeAfter);
    const preferred = [...beforeSymbols, ...symbols].find(symbol => symbol !== '^VIX');
    return preferred || symbols.find(symbol => symbol !== '^VIX') || symbols[0] || 'SPY';
  },

  inferContextSymbol(prompt, symbols=[], targetSymbol='SPY', eventMode='directional-streak') {
    const lower = prompt.toLowerCase();
    const afterPart = lower.includes('after') ? lower.split(/\bafter\b/).slice(1).join(' after ') : lower;
    const afterSymbols = this.matchAliases(afterPart);
    if (eventMode === 'price-extreme') {
      return afterSymbols[0] || symbols[0] || targetSymbol;
    }
    const candidate = afterSymbols.find(symbol => symbol !== targetSymbol) || symbols.find(symbol => symbol !== targetSymbol);
    return candidate || '^VIX';
  },

  inferTriggerSymbol(prompt, symbols=[], targetSymbol='SPY', contextSymbol='^VIX') {
    const lower = prompt.toLowerCase();
    const afterPart = lower.includes('after') ? lower.split(/\bafter\b/).slice(1).join(' after ') : lower;
    const afterSymbols = this.matchAliases(afterPart);
    if (afterSymbols.length) return afterSymbols[0];
    if (symbols.length === 1) return symbols[0];
    return contextSymbol || targetSymbol || '^VIX';
  },

  matchAliases(text='') {
    const lower = text.toLowerCase();
    const matches = [];
    this.aliasMap.forEach(entry => {
      if (entry.aliases.some(regex => regex.test(lower)) && !matches.includes(entry.symbol)) {
        matches.push(entry.symbol);
      }
    });
    return matches;
  },

  inferStudyType(lower='') {
    if (/\bhow often\b|\bafter\b|\blater\b|\bfollowing\b|\bsubsequent\b/.test(lower)) return 'event-study';
    if (/\bportfolio\b|\brebalance\b|\ballocation\b|\bweight\b/.test(lower)) return 'portfolio-construction';
    if (/\bpredict\b|\bforecast\b|\bprobab(?:ility|ilities)\b|\bmodel\b|\bclassifier\b|\bregression\b/.test(lower)) return 'forecast-model';
    if (/\brank\b|\btop\b|\bbottom\b|\bcross-sectional\b/.test(lower)) return 'cross-sectional-model';
    if (/\bbuy\b|\bsell\b|\bshort\b|\blong\b|\bcrosses\b|\babove\b|\bbelow\b/.test(lower)) return 'rule-based-backtest';
    return 'event-study';
  },

  labelStudyType(studyType='event-study') {
    const labels = {
      'event-study': 'an event study',
      'rule-based-backtest': 'a rule-based backtest',
      'portfolio-construction': 'portfolio construction',
      'forecast-model': 'a forecast model',
      'cross-sectional-model': 'a cross-sectional model'
    };
    return labels[studyType] || studyType;
  },

  inferEventMode(lower='') {
    if (/\b(?:year(?:\s+|-)?to(?:\s+|-)?date|ytd|52(?:\s+|-)?week|highest|lowest|new high|new low|record high|record low)\b/.test(lower)) {
      return 'price-extreme';
    }
    if (/\b(?:hit|hits|hitting|reach|reaches|reached|touch|touches|touched|tag|tags|tagged|make|makes|made|break|breaks|breaking|print|prints|printed)\b[\s\S]{0,40}\b(high|low)\b/.test(lower)) {
      return 'price-extreme';
    }
    return 'directional-streak';
  },

  inferRelation(lower='') {
    if (/\bopposite direction\b|\bdifferent direction\b|\breverse direction\b|\bdiverge\b/.test(lower)) {
      return 'opposite-direction';
    }
    return 'same-direction';
  },

  inferOutcomeDirection(lower='') {
    if (/\bdown\b|\bnegative\b|\blower\b/.test(lower)) return 'down';
    if (/\bup\b|\bpositive\b|\bhigher\b/.test(lower)) return 'up';
    return 'either';
  },

  inferWindowSessions(lower='') {
    const explicitDays = this.extractNumber(lower, [
      /\bwithin\s+([a-z0-9-]+)\s+(?:trading\s+)?days?\b/,
      /\bin\s+([a-z0-9-]+)\s+(?:trading\s+)?days?\b/
    ]);
    if (explicitDays) return explicitDays;
    if (/\bin a month\b|\bwithin a month\b/.test(lower)) return 21;
    if (/\bin two weeks\b|\bwithin two weeks\b/.test(lower)) return 10;
    if (/\bin a week\b|\bwithin a week\b|\bduring the week\b/.test(lower)) return 5;
    return 5;
  },

  inferForwardSessions(lower='') {
    const explicitDays = this.extractNumber(lower, [
      /\b([a-z0-9-]+)\s+(?:trading\s+)?days?\s+later\b/,
      /\b([a-z0-9-]+)\s+(?:trading\s+)?days?\s+after\b/,
      /\b([a-z0-9-]+)-day forward\b/,
      /\b([a-z0-9-]+)\s+sessions?\s+later\b/
    ]);
    if (explicitDays) return explicitDays;
    if (/\btwo weeks later\b|\btwo weeks after\b/.test(lower)) return 10;
    if (/\bone month later\b|\bone month after\b|\ba month later\b|\ba month after\b/.test(lower)) return 21;
    if (/\bone week later\b|\bone week after\b|\ba week later\b|\ba week after\b/.test(lower)) return 5;
    return 5;
  },

  inferThreshold(lower='', windowSessions=5) {
    const moreThan = this.extractNumber(lower, [/\bmore than\s+([a-z0-9-]+)\s+days?\b/]);
    if (moreThan) return moreThan + 1;

    const atLeast = this.extractNumber(lower, [
      /\bat least\s+([a-z0-9-]+)\s+days?\b/,
      /\b([a-z0-9-]+)\s+or more\s+days?\b/
    ]);
    if (atLeast) return atLeast;

    if (/\bmost days\b/.test(lower)) return Math.max(2, Math.ceil(windowSessions * 0.6));
    return Math.min(3, windowSessions);
  },

  inferRange(lower='', forwardSessions=5, eventMode='directional-streak') {
    if (/\bmax\b|\bfull history\b|\bsince inception\b/.test(lower)) return 'MAX';
    if (/\bten years?\b|\bdecade\b/.test(lower)) return '10Y';
    if (/\bfive years?\b/.test(lower)) return '5Y';
    if (/\bthree years?\b/.test(lower)) return '3Y';
    if (eventMode === 'price-extreme') return 'MAX';
    return forwardSessions > 10 ? 'MAX' : '10Y';
  },

  primaryTriggerText(prompt='') {
    const lower = String(prompt || '').toLowerCase();
    const afterPart = lower.includes('after')
      ? lower.split(/\bafter\b/).slice(1).join(' after ')
      : lower;
    const withoutParentheticals = afterPart.replace(/\([^)]*\)/g, ' ');
    const primary = withoutParentheticals
      .split(/\b(?:if\s+using|note\s+that|use|using|as\s+a\s+proxy|as\s+proxy|proxy)\b/)[0]
      .trim();
    return primary || withoutParentheticals.trim() || lower;
  },

  inferExtremeDirection(triggerText='', fallbackText='') {
    const findSide = text => {
      const source = String(text || '').toLowerCase();
      const highIndex = source.search(/\b(?:high|highs|higher|highest)\b/);
      const lowIndex = source.search(/\b(?:low|lows|lower|lowest)\b/);
      if (highIndex >= 0 && (lowIndex < 0 || highIndex < lowIndex)) return 'high';
      if (lowIndex >= 0) return 'low';
      return null;
    };
    return findSide(triggerText) || findSide(fallbackText) || 'high';
  },

  inferExtremeSpec(prompt='', fallbackWindow=252) {
    const lower = String(prompt || '').toLowerCase();
    const triggerText = this.primaryTriggerText(prompt);
    const referenceText = triggerText || lower;
    const explicitWindow = this.extractNumber(referenceText, [
      /\b([a-z0-9-]+)\s+day\s+(?:high|low)\b/,
      /\bhighest\s+in\s+([a-z0-9-]+)\s+days?\b/,
      /\blowest\s+in\s+([a-z0-9-]+)\s+days?\b/,
      /\bhigh(?:est)?\s+of\s+the\s+last\s+([a-z0-9-]+)\s+days?\b/,
      /\blow(?:est)?\s+of\s+the\s+last\s+([a-z0-9-]+)\s+days?\b/
    ]);
    const direction = this.inferExtremeDirection(referenceText, lower);
    const strict = /\bnew\b|\bbreak(?:s|ing)?\b|\bexceed(?:s|ed|ing)?\b|\bfalls?\s+below\b/.test(referenceText);

    if (/\byear(?:\s+|-)?to(?:\s+|-)?date\b|\bytd\b/.test(referenceText)) {
      return {
        direction,
        reference: 'ytd',
        referenceLabel: 'year-to-date',
        windowSessions: 252,
        strict
      };
    }
    if (/\b52(?:\s+|-)?week\b|\bone year\b/.test(referenceText)) {
      return {
        direction,
        reference: '52-week',
        referenceLabel: '52-week',
        windowSessions: 252,
        strict
      };
    }
    if (/\bquarter\b|\bthree months?\b/.test(referenceText)) {
      return {
        direction,
        reference: 'rolling',
        referenceLabel: '63-session',
        windowSessions: 63,
        strict
      };
    }
    if (/\bmonth\b|\bmonthly\b/.test(referenceText)) {
      return {
        direction,
        reference: 'rolling',
        referenceLabel: '21-session',
        windowSessions: 21,
        strict
      };
    }
    if (Number.isFinite(explicitWindow) && explicitWindow >= 2) {
      return {
        direction,
        reference: 'rolling',
        referenceLabel: `${explicitWindow}-session`,
        windowSessions: explicitWindow,
        strict
      };
    }
    return {
      direction,
      reference: '52-week',
      referenceLabel: '52-week',
      windowSessions: Math.max(21, fallbackWindow || 252),
      strict
    };
  },

  extractNumber(lower='', patterns=[]) {
    for (const pattern of patterns) {
      const match = lower.match(pattern);
      if (!match?.[1]) continue;
      const parsed = this.parseNumericToken(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  },

  parseNumericToken(token='') {
    const clean = String(token || '').trim().toLowerCase().replace(/[^\w-]/g, '');
    if (!clean) return null;
    if (/^\d+$/.test(clean)) return Number(clean);
    if (this.wordNumbers[clean] != null) return this.wordNumbers[clean];
    const compact = clean.replace(/-/g, '');
    if (this.wordNumbers[compact] != null) return this.wordNumbers[compact];
    return null;
  },

  applySpecToForm(spec={}) {
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el && value != null) el.value = value;
    };
    setValue('sl-study-type', spec.studyType || 'event-study');
    setValue('sl-target', spec.targetSymbol || 'SPY');
    setValue('sl-context', spec.triggerSymbol || spec.contextSymbol || '^VIX');
    setValue('sl-relation', spec.relation || 'same-direction');
    setValue('sl-window', spec.windowSessions || 5);
    setValue('sl-threshold', spec.eventMode === 'price-extreme' ? 1 : (spec.threshold || 3));
    setValue('sl-forward', spec.forwardSessions || 5);
    setValue('sl-outcome', spec.outcomeDirection || 'down');
    setValue('sl-range', spec.range || '10Y');
    setValue('sl-entry', spec.entryMode || 'signal-close');
    const overlap = document.getElementById('sl-overlap');
    if (overlap) overlap.checked = spec.suppressOverlap !== false;
  },

  getFormConfig() {
    const lastSpec = this.state.lastSpec || {};
    const eventMode = lastSpec.eventMode || 'directional-streak';
    const prompt = (document.getElementById('sl-prompt')?.value || '').trim();
    const studyType = document.getElementById('sl-study-type')?.value || 'event-study';
    const targetSymbol = this.normalizeSymbol(document.getElementById('sl-target')?.value || 'SPY', 'SPY');
    const defaultContext = eventMode === 'price-extreme'
      ? (lastSpec.triggerSymbol || targetSymbol)
      : (lastSpec.contextSymbol || '^VIX');
    const contextSymbol = this.normalizeSymbol(document.getElementById('sl-context')?.value || defaultContext, defaultContext);
    const relation = document.getElementById('sl-relation')?.value || 'same-direction';
    const windowSessions = Math.max(2, parseInt(document.getElementById('sl-window')?.value, 10) || 5);
    const threshold = eventMode === 'price-extreme'
      ? 1
      : Math.max(1, Math.min(windowSessions, parseInt(document.getElementById('sl-threshold')?.value, 10) || 3));
    const forwardSessions = Math.max(1, parseInt(document.getElementById('sl-forward')?.value, 10) || 5);
    const outcomeDirection = document.getElementById('sl-outcome')?.value || 'down';
    const range = document.getElementById('sl-range')?.value || '10Y';
    const entryMode = document.getElementById('sl-entry')?.value || 'signal-close';
    const suppressOverlap = Boolean(document.getElementById('sl-overlap')?.checked);

    const notes = [];
    if (studyType !== 'event-study') {
      notes.push('The current execution engine is still event-study-first, so the run button below will evaluate the event-study version of this prompt.');
    }
    if (eventMode !== 'price-extreme' && targetSymbol === contextSymbol) {
      notes.push('Target and context are identical. The trigger will usually be more informative with a second symbol or regime input.');
    }
    if (entryMode === 'next-open' && this.isDescriptiveOnlySymbol(targetSymbol)) {
      notes.push('Next-open execution on an index is descriptive only. Consider using SPY, QQQ, or another tradable proxy.');
    }
    if (eventMode === 'price-extreme') {
      notes.push('Extreme-event mode uses the current prompt family. Relation acts as High or Low, while matching-days stays disabled.');
    }
    if ([targetSymbol, contextSymbol].some(symbol => this.isFredSymbol(symbol))) {
      notes.push('FRED series are supported directly in Strategy Lab for macro and index prompts such as 10-year Treasury yield and S&P 500 event studies.');
    }

    const config = {
      prompt,
      studyType,
      executedStudyType: 'event-study',
      eventMode,
      targetSymbol,
      contextSymbol,
      triggerSymbol: contextSymbol,
      relation,
      windowSessions,
      threshold,
      forwardSessions,
      outcomeDirection,
      range,
      entryMode,
      suppressOverlap,
      extremeDirection: eventMode === 'price-extreme'
        ? (relation === 'opposite-direction' ? 'low' : 'high')
        : (lastSpec.extremeDirection || null),
      extremeReference: lastSpec.extremeReference || null,
      extremeReferenceLabel: lastSpec.extremeReference === 'rolling'
        ? `${windowSessions}-session`
        : (lastSpec.extremeReferenceLabel || ''),
      extremeStrict: Boolean(lastSpec.extremeStrict),
      notes
    };
    this.state.lastSpec = config;
    return config;
  },

  normalizeSymbol(value='', fallback='SPY') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const lower = raw.toLowerCase();
    const alias = this.matchAliases(lower)[0];
    return alias || raw.toUpperCase();
  },

  updateFormMode(spec={}) {
    const isExtreme = spec.eventMode === 'price-extreme';
    const contextLabel = document.getElementById('sl-context-label');
    const relationLabel = document.getElementById('sl-relation-label');
    const windowLabel = document.getElementById('sl-window-label');
    const thresholdLabel = document.getElementById('sl-threshold-label');
    const hint = document.getElementById('sl-mode-hint');
    const relationSelect = document.getElementById('sl-relation');
    const windowInput = document.getElementById('sl-window');
    const thresholdInput = document.getElementById('sl-threshold');

    if (contextLabel) contextLabel.textContent = isExtreme ? 'Trigger Symbol' : 'Context Symbol';
    if (relationLabel) relationLabel.textContent = isExtreme ? 'Extreme Side' : 'Relation';
    if (windowLabel) {
      windowLabel.textContent = isExtreme
        ? (spec.extremeReference === 'ytd' ? 'Reference Window (calendar)' : 'Reference Window')
        : 'Lookback Window';
    }
    if (thresholdLabel) thresholdLabel.textContent = isExtreme ? 'Trigger Threshold' : 'Min Matching Days';

    if (relationSelect?.options?.length >= 2) {
      relationSelect.options[0].text = isExtreme ? 'High' : 'Same Direction';
      relationSelect.options[1].text = isExtreme ? 'Low' : 'Opposite Direction';
    }
    if (windowInput) {
      const fixedWindow = isExtreme && spec.extremeReference && spec.extremeReference !== 'rolling';
      windowInput.disabled = Boolean(fixedWindow);
      windowInput.title = fixedWindow ? 'This reference window is fixed by the parsed prompt.' : '';
    }
    if (thresholdInput) {
      thresholdInput.disabled = isExtreme;
      thresholdInput.title = isExtreme ? 'Extreme-event mode uses a single event date, so matching-days is not used.' : '';
    }
    if (hint) {
      hint.textContent = isExtreme
        ? `Extreme-event mode: ${this.describeTrigger(spec)}. Run uses the latest prompt automatically, and matching-days is disabled because the signal fires on a single extreme date.`
        : 'Directional event mode: the trigger counts how many recent sessions the target and context moved in the specified direction relationship.';
    }
  },

  withArticle(phrase='') {
    const text = String(phrase || '').trim();
    if (!text) return '';
    return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`;
  },

  describeTrigger(spec={}) {
    if (spec.eventMode === 'price-extreme') {
      const symbol = this.labelSymbol(spec.triggerSymbol || spec.contextSymbol || '^VIX');
      const referenceLabel = spec.extremeReferenceLabel || `${Number(spec.windowSessions || 252)}-session`;
      const side = spec.extremeDirection === 'low' ? 'low' : 'high';
      if (spec.extremeStrict) {
        return `${symbol} makes a new ${referenceLabel} ${side}`;
      }
      return `${symbol} hits ${this.withArticle(`${referenceLabel} ${side}`)}`;
    }
    const relationText = spec.relation === 'opposite-direction' ? 'move in opposite directions' : 'move in the same direction';
    return `${this.labelSymbol(spec.targetSymbol || 'SPY')} and ${this.labelSymbol(spec.contextSymbol || '^VIX')} ${relationText} on at least ${Number(spec.threshold || 3)} of the last ${Number(spec.windowSessions || 5)} sessions`;
  },

  describeOutcome(spec={}) {
    if (spec.outcomeDirection === 'down') return 'negative';
    if (spec.outcomeDirection === 'up') return 'positive';
    return 'non-zero';
  },

  describeHypothesis(spec={}) {
    return `Measure whether ${this.labelSymbol(spec.targetSymbol || 'SPY')} is more likely to finish ${this.describeOutcome(spec)} ${Number(spec.forwardSessions || 5)} trading sessions later after ${this.describeTrigger(spec)}.`;
  },

  describeRunMethod(spec={}) {
    if (spec.studyType !== 'event-study') {
      return `Prompt reads like ${this.labelStudyType(spec.studyType)}. The UI can still normalize the idea, but the current run button executes an event-study pass first.`;
    }
    return spec.eventMode === 'price-extreme'
      ? 'Extreme-event study first: treat each new qualifying high or low as an event date, then compare the forward-return distribution against the unconditional baseline.'
      : 'Event study first: compare the conditional forward-return distribution against the unconditional baseline.';
  },

  describeResultTrigger(spec={}) {
    return spec.eventMode === 'price-extreme'
      ? `${this.describeTrigger(spec)} and then measure ${Number(spec.forwardSessions || 5)} trading sessions of follow-through.`
      : `Trigger uses a ${Number(spec.windowSessions || 5)}-session lookback, threshold ${Number(spec.threshold || 3)}, ${spec.relation === 'opposite-direction' ? 'opposite-direction' : 'same-direction'} sign matching, and ${Number(spec.forwardSessions || 5)} trading sessions of follow-through.`;
  },

  requestedOutcomeStats(result, config) {
    const targetLabel = this.labelSymbol(config.targetSymbol || 'Target');
    if (config.outcomeDirection === 'up') {
      return {
        label: `${targetLabel} up ${config.forwardSessions}D win rate`,
        value: result.positiveRate,
        baseline: result.baselinePositiveRate,
        edge: result.positiveRate - result.baselinePositiveRate
      };
    }
    if (config.outcomeDirection === 'down') {
      return {
        label: `${targetLabel} down ${config.forwardSessions}D win rate`,
        value: result.negativeRate,
        baseline: result.baselineNegativeRate,
        edge: result.negativeRate - result.baselineNegativeRate
      };
    }
    return {
      label: `Average ${config.forwardSessions}D return`,
      value: result.meanReturn,
      baseline: result.baselineMean,
      edge: result.meanReturn - result.baselineMean
    };
  },

  historySourceMeta(history={}) {
    return {
      ticker: history?.ticker || '',
      providerSource: history?.providerSource || '',
      providerSeriesId: history?.providerSeriesId || '',
      providerSymbol: history?.providerSymbol || '',
      providerTransform: history?.providerTransform || '',
      providerFallbackLabel: history?.providerFallbackLabel || '',
      providerAttemptChain: Array.isArray(history?.providerAttemptChain) ? history.providerAttemptChain : [],
      observationCount: Array.isArray(history?.dates) ? history.dates.length : 0
    };
  },

  returnDistribution(values=[]) {
    const sorted = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) {
      return { mean: 0, median: 0, min: 0, max: 0, p25: 0, p75: 0 };
    }
    return {
      mean: PA.Compute.mean(sorted),
      median: this.percentileFromSorted(sorted, 0.5),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p25: this.percentileFromSorted(sorted, 0.25),
      p75: this.percentileFromSorted(sorted, 0.75)
    };
  },

  hypothesisTradeSide(config={}) {
    if (config.outcomeDirection === 'down') {
      return {
        side: 'short',
        label: 'Short target',
        formula: 'short return = -forward return',
        detail: 'The prompt is bearish, so the hypothesis-side trade is short the target for the forward window.'
      };
    }
    if (config.outcomeDirection === 'up') {
      return {
        side: 'long',
        label: 'Long target',
        formula: 'long return = forward return',
        detail: 'The prompt is bullish, so the hypothesis-side trade is long the target for the forward window.'
      };
    }
    return {
      side: 'long',
      label: 'Long target shown',
      formula: 'long return = forward return',
      detail: 'The prompt does not specify up or down, so the app shows long target as the default trade lens and still reports both up/down rates.'
    };
  },

  hypothesisTradeStats(result={}, config={}) {
    const spec = this.hypothesisTradeSide(config);
    const returns = (result.eventReturns || [])
      .map(value => Number(value))
      .filter(Number.isFinite)
      .map(value => spec.side === 'short' ? -value : value);
    const curveTotal = spec.side === 'short'
      ? result.tradeCurve?.shortTotalReturn
      : result.tradeCurve?.longTotalReturn;
    return {
      ...spec,
      totalReturn: Number.isFinite(curveTotal) ? curveTotal : this.compoundSignalReturn(result.eventReturns || [], spec.side),
      meanReturn: returns.length ? PA.Compute.mean(returns) : 0,
      medianReturn: returns.length ? this.median(returns) : 0
    };
  },

  signalCountStats(result={}) {
    const rawCount = result.overlapComparison?.raw?.eventCount ?? result.eventCount ?? 0;
    const suppressedCount = result.overlapComparison?.suppressed?.eventCount ?? result.eventCount ?? 0;
    return {
      selectedCount: result.eventCount ?? 0,
      rawCount,
      suppressedCount
    };
  },

  buildPromptAnswer(config, result) {
    const stats = this.requestedOutcomeStats(result, config);
    const sampleLabel = `${result.startDate} to ${result.endDate}`;
    const targetLabel = this.labelSymbol(config.targetSymbol || 'The target');
    const trade = this.hypothesisTradeStats(result, config);
    const overlapNote = result.overlapComparison?.raw && result.overlapComparison?.suppressed
      && result.overlapComparison.raw.eventCount !== result.overlapComparison.suppressed.eventCount
      ? ` Overlap suppression kept ${result.overlapComparison.suppressed.eventCount} of ${result.overlapComparison.raw.eventCount} raw signals.`
      : '';
    const proxyNote = result.studyPlan?.target?.usingProxy
      ? ` Returns were measured with ${result.studyPlan.target.selectedSymbol} as the tradable proxy for ${targetLabel}.`
      : '';
    if (config.outcomeDirection === 'either') {
      return `${targetLabel} moved up ${PA.Fmt.pct(result.positiveRate)} of the time and down ${PA.Fmt.pct(result.negativeRate)} of the time ${config.forwardSessions} trading sessions after ${this.describeTrigger(config)}. That happened ${result.eventCount} times in the sample (${sampleLabel}). The average ${config.forwardSessions}D move was ${PA.Fmt.pct(result.meanReturn)}. ${trade.label} compounded to ${PA.Fmt.pct(trade.totalReturn)} across the selected signals, with an average per-signal trade return of ${PA.Fmt.pct(trade.meanReturn)}.${overlapNote}${proxyNote}`;
    }
    const directionWord = config.outcomeDirection === 'down' ? 'down' : 'up';
    return `${targetLabel} was ${directionWord} ${PA.Fmt.pct(stats.value)} of the time ${config.forwardSessions} trading sessions after ${this.describeTrigger(config)}. That happened ${result.eventCount} times in the sample (${sampleLabel}). The average ${config.forwardSessions}D move was ${PA.Fmt.pct(result.meanReturn)}, versus ${PA.Fmt.pct(result.baselineMean)} for the unconditional baseline. ${trade.label} compounded to ${PA.Fmt.pct(trade.totalReturn)} across the selected signals, with an average per-signal trade return of ${PA.Fmt.pct(trade.meanReturn)}.${overlapNote}${proxyNote}`;
  },

  buildOverlapComparison(rawResult, suppressedResult, config) {
    if (!rawResult || !suppressedResult) return null;
    const summarize = (label, result) => {
      const stats = this.requestedOutcomeStats(result, config);
      return {
        label,
        eventCount: result.eventCount,
        requestedLabel: stats.label,
        requestedValue: stats.value,
        meanReturn: result.meanReturn
      };
    };
    return {
      raw: summarize('Every signal', rawResult),
      suppressed: summarize('Overlap suppressed', suppressedResult)
    };
  },

  resultDefinitions(config, result) {
    const trade = this.hypothesisTradeStats(result, config);
    return [
      {
        label: 'Signal count',
        detail: `How many times the exact trigger fired. The scoreboard shows raw and overlap-suppressed counts separately.`
      },
      {
        label: 'Win rate',
        detail: `The percentage of signals where the prompt outcome happened ${config.forwardSessions} trading sessions later.`
      },
      {
        label: 'Forward return distribution',
        detail: `Mean, median, high, low, and percentile band of the target return after the trigger.`
      },
      {
        label: 'Hypothesis-side trade',
        detail: `${trade.formula}. ${trade.detail}`
      }
    ];
  },

  compoundSignalReturn(returns=[], side='long') {
    let equity = 1;
    (returns || []).forEach(rawValue => {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return;
      const gross = side === 'short' ? (1 - value) : (1 + value);
      equity *= gross > 0 ? gross : 0;
    });
    return equity - 1;
  },

  buildTradeCurve(events=[]) {
    const dates = [];
    const longCurve = [];
    const shortCurve = [];
    let longEquity = 1;
    let shortEquity = 1;

    (events || []).forEach(event => {
      const forwardReturn = Number(event?.forwardReturn);
      if (!Number.isFinite(forwardReturn)) return;
      longEquity *= 1 + forwardReturn;
      const shortGross = 1 - forwardReturn;
      shortEquity *= shortGross > 0 ? shortGross : 0;
      dates.push(event.date);
      longCurve.push(longEquity - 1);
      shortCurve.push(shortEquity - 1);
    });

    return {
      dates,
      longCurve,
      shortCurve,
      longTotalReturn: longCurve.length ? longCurve[longCurve.length - 1] : 0,
      shortTotalReturn: shortCurve.length ? shortCurve[shortCurve.length - 1] : 0
    };
  },

  buildAuditWindow(auditSeries={}, events=[], maxPoints=252) {
    const dates = auditSeries.dates || [];
    if (!dates.length) return { startIndex: 0, endIndex: 0, dates: [] };

    const latestSignalIndex = (events?.length ? events[events.length - 1]?.signalIndex : null);
    const anchorIndex = Number.isFinite(latestSignalIndex) ? latestSignalIndex : (dates.length - 1);
    const preferredStart = Math.max(0, anchorIndex - Math.floor(maxPoints * 0.65));
    const maxStart = Math.max(0, dates.length - maxPoints);
    const startIndex = Math.min(preferredStart, maxStart);
    const endIndex = Math.min(dates.length, startIndex + maxPoints);
    const slice = array => (array || []).slice(startIndex, endIndex);
    const visibleEvents = (events || [])
      .filter(event => Number.isFinite(event?.signalIndex) && event.signalIndex >= startIndex && event.signalIndex < endIndex)
      .map(event => ({
        ...event,
        localIndex: event.signalIndex - startIndex
      }));

    return {
      startIndex,
      endIndex,
      dates: slice(auditSeries.dates),
      targetReturns: slice(auditSeries.targetReturns),
      contextReturns: slice(auditSeries.contextReturns),
      rollingMatchCount: slice(auditSeries.rollingMatchCount),
      thresholdLine: slice(auditSeries.thresholdLine),
      contextLevels: slice(auditSeries.contextLevels),
      referenceLevels: slice(auditSeries.referenceLevels),
      targetNormalized: slice(auditSeries.targetNormalized),
      visibleEvents
    };
  },

  renderSummary(spec={}) {
    const panel = document.getElementById('sl-summary-panel');
    if (!panel) return;

    const methodText = this.describeRunMethod(spec);

    const badges = [
      { label: `Method: ${spec.executedStudyType || 'event-study'}`, kind: 'info' },
      { label: spec.eventMode === 'price-extreme' ? 'Signal: price extreme' : 'Signal: directional streak', kind: 'info' },
      { label: `Entry: ${spec.entryMode === 'next-open' ? 'next open' : 'signal close'}`, kind: spec.entryMode === 'next-open' ? 'warn' : 'good' },
      { label: spec.suppressOverlap ? 'Overlap suppressed' : 'Overlap allowed', kind: spec.suppressOverlap ? 'good' : 'warn' }
    ];

    const notes = (spec.notes || []).map(note => `
      <div class="strategy-pill strategy-pill-warn">${PA.UI.escapeHtml(note)}</div>
    `).join('');

    panel.innerHTML = `
      <div class="strategy-summary-grid">
        <div>
          <div class="strategy-summary-title">Normalized Hypothesis</div>
          <div class="strategy-summary-body">
            ${PA.UI.escapeHtml(this.describeHypothesis(spec))}
          </div>
          <div class="strategy-badge-row">
            ${badges.map(badge => `<div class="strategy-pill strategy-pill-${badge.kind}">${PA.UI.escapeHtml(badge.label)}</div>`).join('')}
            ${notes}
          </div>
        </div>
        <div>
          <div class="strategy-summary-title">Recommended Workflow</div>
          <div class="strategy-flow-list">
            <div class="strategy-flow-item">
              <div class="strategy-flow-index">1</div>
              <div class="strategy-flow-copy">${PA.UI.escapeHtml(methodText)}</div>
            </div>
            <div class="strategy-flow-item">
              <div class="strategy-flow-index">2</div>
              <div class="strategy-flow-copy">Keep symbol mapping, window length, threshold, and execution timing visible before trusting any performance number.</div>
            </div>
            <div class="strategy-flow-item">
              <div class="strategy-flow-index">3</div>
              <div class="strategy-flow-copy">If the effect survives sample-size and baseline checks, graduate it into a rule-based backtest with explicit fees, slippage, and walk-forward validation.</div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  renderEmptyState() {
    const container = document.getElementById('strategy-results');
    if (!container) return;
    container.style.display = 'block';
    container.innerHTML = `
      <div class="strategy-empty">
        <h3>Strategy Lab is ready</h3>
        <p>Parse a prompt, confirm the assumptions, and run the event study to see a real conditional return analysis against live history from the local backend.</p>
      </div>
    `;
  },

  async run() {
    const config = this.resolveExecutionConfig();
    this.state.lastSpec = config;
    this.updateFormMode(config);
    this.renderSummary(config);

    const resultsDiv = document.getElementById('strategy-results');
    if (!resultsDiv) return;
    resultsDiv.style.display = 'block';
    PA.UI.loading(resultsDiv);

    try {
      const health = await PA.API.checkBackendHealth();
      if (health?.version && health.version !== PA.Config.APP_VERSION) {
        throw new Error(`Backend version mismatch: frontend is ${PA.Config.APP_VERSION} but backend is ${health.version}. Restart the ${PA.Config.APP_VERSION} backend before running Strategy Lab.`);
      }
      const historySymbols = this.collectStudySymbols(config);
      const histories = await PA.API.getHistories(historySymbols, config.range);
      const parsedHistories = {};
      historySymbols.forEach(symbol => {
        parsedHistories[symbol] = PA.API.parseHistory(histories[symbol]);
      });
      const studyPlan = this.buildStudyPlan(config, parsedHistories);
      const targetHistory = studyPlan.target.selectedHistory;
      const contextHistory = studyPlan.context.selectedHistory;
      const aligned = this.alignSeries(targetHistory, contextHistory);

      if (aligned.dates.length < Math.max(40, config.windowSessions + config.forwardSessions + 10)) {
        throw new Error(`Not enough overlapping history between ${studyPlan.target.selectedLabel} and ${studyPlan.context.selectedLabel} for this setup.`);
      }

      const result = this.computeEventStudy(aligned, config);
      result.studyPlan = {
        target: {
          requestedSymbol: studyPlan.target.requestedSymbol,
          requestedLabel: studyPlan.target.requestedLabel,
          canonicalSymbol: studyPlan.target.canonicalSymbol,
          canonicalLabel: studyPlan.target.canonicalLabel,
          selectedSymbol: studyPlan.target.selectedSymbol,
          selectedLabel: studyPlan.target.selectedLabel,
          selectedHistory: this.historySourceMeta(studyPlan.target.selectedHistory),
          usingProxy: studyPlan.target.usingProxy,
          resolutionNote: studyPlan.target.resolutionNote,
          audits: studyPlan.target.audits || []
        },
        context: {
          requestedSymbol: studyPlan.context.requestedSymbol,
          requestedLabel: studyPlan.context.requestedLabel,
          canonicalSymbol: studyPlan.context.canonicalSymbol,
          canonicalLabel: studyPlan.context.canonicalLabel,
          selectedSymbol: studyPlan.context.selectedSymbol,
          selectedLabel: studyPlan.context.selectedLabel,
          selectedHistory: this.historySourceMeta(studyPlan.context.selectedHistory),
          usingProxy: studyPlan.context.usingProxy,
          resolutionNote: studyPlan.context.resolutionNote,
          audits: studyPlan.context.audits || []
        }
      };
      try {
        const rawResult = config.suppressOverlap
          ? this.computeEventStudy(aligned, { ...config, suppressOverlap: false })
          : result;
        const suppressedResult = config.suppressOverlap
          ? result
          : this.computeEventStudy(aligned, { ...config, suppressOverlap: true });
        result.overlapComparison = this.buildOverlapComparison(rawResult, suppressedResult, config);
      } catch (overlapError) {
        result.overlapComparison = null;
      }
      this.renderResults(config, result);
      PA.UI.toast(`Strategy study complete: ${result.eventCount} events found`, 'success');
    } catch (error) {
      PA.UI.renderError(resultsDiv, 'Strategy Lab Error', error, 'Start the local backend in Settings, then try a longer range or a simpler event definition.');
    }
  },

  normalizeDateKey(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct?.[1]) return direct[1];
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return text;
  },

  alignSeries(targetHistory, contextHistory) {
    const targetMap = new Map();
    (targetHistory.dates || []).forEach((date, index) => {
      const key = this.normalizeDateKey(date);
      if (!key) return;
      targetMap.set(key, {
        close: targetHistory.prices?.[index],
        adjusted: targetHistory.adjustedPrices?.[index],
        open: targetHistory.opens?.[index]
      });
    });
    const contextMap = new Map();
    (contextHistory.dates || []).forEach((date, index) => {
      const key = this.normalizeDateKey(date);
      if (!key) return;
      contextMap.set(key, {
        close: contextHistory.prices?.[index]
      });
    });

    const dates = [...targetMap.keys()].filter(date => contextMap.has(date)).sort();
    const closes = [];
    const adjustedCloses = [];
    const opens = [];
    const contextCloses = [];
    const cleanDates = [];

    dates.forEach(date => {
      const target = targetMap.get(date);
      const context = contextMap.get(date);
      const close = Number(target?.close);
      const adjusted = Number(target?.adjusted);
      const open = Number(target?.open);
      const contextClose = Number(context?.close);
      if (![close, contextClose].every(Number.isFinite)) return;
      cleanDates.push(date);
      closes.push(close);
      adjustedCloses.push(Number.isFinite(adjusted) ? adjusted : close);
      opens.push(Number.isFinite(open) ? open : close);
      contextCloses.push(contextClose);
    });

    return {
      dates: cleanDates,
      closes,
      adjustedCloses,
      opens,
      contextCloses
    };
  },

  computeEventStudy(series, config) {
    return config.eventMode === 'price-extreme'
      ? this.computePriceExtremeEventStudy(series, config)
      : this.computeDirectionalEventStudy(series, config);
  },

  computeSeriesReturns(targetSeries, contextCloses) {
    const targetReturns = new Array(targetSeries.length).fill(null);
    const contextReturns = new Array(contextCloses.length).fill(null);
    for (let i = 1; i < targetSeries.length; i++) {
      targetReturns[i] = targetSeries[i - 1] ? (targetSeries[i] / targetSeries[i - 1]) - 1 : null;
      contextReturns[i] = contextCloses[i - 1] ? (contextCloses[i] / contextCloses[i - 1]) - 1 : null;
    }
    return { targetReturns, contextReturns };
  },

  computeDirectionalEventStudy(series, config) {
    const { dates, closes, adjustedCloses, opens, contextCloses } = series;
    const targetSeries = adjustedCloses.every(Number.isFinite) ? adjustedCloses : closes;
    const { targetReturns, contextReturns } = this.computeSeriesReturns(targetSeries, contextCloses);

    const matchFlags = targetReturns.map((value, index) => this.matchRelation(value, contextReturns[index], config.relation));
    const rollingMatchCount = new Array(dates.length).fill(null);
    const events = [];
    let lastBlockedIndex = -Infinity;

    const baseline = [];
    const baselinePaths = [];
    const entryOffset = config.entryMode === 'next-open' ? 1 : 0;

    for (let signalIndex = Math.max(1, config.windowSessions); signalIndex < dates.length; signalIndex++) {
      const matchCount = this.countMatches(matchFlags, signalIndex, config.windowSessions);
      rollingMatchCount[signalIndex] = matchCount;
      const entryIndex = signalIndex + entryOffset;
      const exitIndex = entryIndex + config.forwardSessions;
      if (entryIndex >= dates.length || exitIndex >= dates.length) continue;

      const entryPrice = config.entryMode === 'next-open'
        ? (Number.isFinite(opens[entryIndex]) ? opens[entryIndex] : closes[entryIndex])
        : targetSeries[entryIndex];
      const exitPrice = closes[exitIndex];
      if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0) continue;

      const forwardReturn = (exitPrice / entryPrice) - 1;
      const path = this.buildForwardPath(closes, entryPrice, entryIndex, config.forwardSessions);
      baseline.push(forwardReturn);
      baselinePaths.push(path);

      if (matchCount < config.threshold) continue;
      if (config.suppressOverlap && entryIndex <= lastBlockedIndex) continue;

      const event = {
        signalIndex,
        date: dates[signalIndex],
        entryDate: dates[entryIndex],
        exitDate: dates[exitIndex],
        matchCount,
        eventLabel: `${matchCount} / ${config.windowSessions}`,
        forwardReturn,
        targetReturn: targetReturns[signalIndex],
        contextReturn: contextReturns[signalIndex],
        contextLevel: contextCloses[signalIndex],
        path
      };
      events.push(event);
      if (config.suppressOverlap) lastBlockedIndex = exitIndex;
    }

    if (!events.length) {
      throw new Error('No qualifying events were found for this setup. Lower the threshold, lengthen the range, or loosen the overlap rule.');
    }

    const eventReturns = events.map(event => event.forwardReturn);
    const avgPath = this.averagePath(events.map(event => event.path), config.forwardSessions);
    const baselinePath = this.averagePath(baselinePaths, config.forwardSessions);
    const negativeRate = eventReturns.filter(value => value < 0).length / eventReturns.length;
    const positiveRate = eventReturns.filter(value => value > 0).length / eventReturns.length;
    const baselineNegativeRate = baseline.filter(value => value < 0).length / baseline.length;
    const baselinePositiveRate = baseline.filter(value => value > 0).length / baseline.length;
    const meanReturn = PA.Compute.mean(eventReturns);
    const medianReturn = this.median(eventReturns);
    const baselineMean = PA.Compute.mean(baseline);
    const volatility = eventReturns.length > 1 ? PA.Compute.stdDev(eventReturns) : 0;
    const tStatistic = volatility > 0 && eventReturns.length > 1
      ? meanReturn / (volatility / Math.sqrt(eventReturns.length))
      : 0;
    const ci = this.bootstrapMeanCI(eventReturns, 400);
    const edge = config.outcomeDirection === 'down'
      ? negativeRate - baselineNegativeRate
      : config.outcomeDirection === 'up'
        ? positiveRate - baselinePositiveRate
        : meanReturn - baselineMean;

    const regimeSplit = this.buildRegimeSplit(events, config.contextSymbol);
    const warnings = [];
    if (events.length < 15) warnings.push('Thin event sample. Treat the result as exploratory.');
    if (events.length < 30) warnings.push('Sample size is usable but still fragile for broad claims.');
    if (Math.abs(tStatistic) < 1) warnings.push('The mean forward return is weak relative to its own dispersion.');
    if (Math.abs(edge) < 0.02 && config.outcomeDirection !== 'either') warnings.push('Conditional hit rate is only modestly different from the unconditional baseline.');
    if (config.range === '1Y' || config.range === '3Y') warnings.push('Consider a longer range before trusting the effect.');

    const tradeCurve = this.buildTradeCurve(events);
    return {
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      validWindows: baseline.length,
      coverage: events.length / baseline.length,
      eventCount: events.length,
      eventReturns,
      forwardDistribution: this.returnDistribution(eventReturns),
      avgPath,
      baselinePath,
      meanReturn,
      medianReturn,
      baselineMean,
      negativeRate,
      positiveRate,
      baselineNegativeRate,
      baselinePositiveRate,
      tStatistic,
      ci,
      edge,
      volatility,
      tradeCurve,
      auditSeries: {
        dates,
        targetReturns,
        contextReturns,
        rollingMatchCount,
        thresholdLine: new Array(dates.length).fill(config.threshold),
        contextLevels: contextCloses
      },
      regimeSplit,
      warnings,
      recentEvents: events.slice(-12).reverse(),
      chartEvents: events.slice(-16),
      events
    };
  },

  computePriceExtremeEventStudy(series, config) {
    const { dates, closes, adjustedCloses, opens, contextCloses } = series;
    const targetSeries = adjustedCloses.every(Number.isFinite) ? adjustedCloses : closes;
    const { targetReturns, contextReturns } = this.computeSeriesReturns(targetSeries, contextCloses);
    const referenceLevels = new Array(dates.length).fill(null);
    const triggerStates = dates.map((_, signalIndex) => {
      const trigger = this.evaluateExtremeTrigger(dates, contextCloses, signalIndex, config);
      referenceLevels[signalIndex] = trigger.referenceLevel ?? null;
      return trigger;
    });
    const events = [];
    const baseline = [];
    const baselinePaths = [];
    const entryOffset = config.entryMode === 'next-open' ? 1 : 0;
    let lastBlockedIndex = -Infinity;

    for (let signalIndex = 1; signalIndex < dates.length; signalIndex++) {
      const entryIndex = signalIndex + entryOffset;
      const exitIndex = entryIndex + config.forwardSessions;
      if (entryIndex >= dates.length || exitIndex >= dates.length) continue;

      const entryPrice = config.entryMode === 'next-open'
        ? (Number.isFinite(opens[entryIndex]) ? opens[entryIndex] : closes[entryIndex])
        : targetSeries[entryIndex];
      const exitPrice = closes[exitIndex];
      if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0) continue;

      const forwardReturn = (exitPrice / entryPrice) - 1;
      const path = this.buildForwardPath(closes, entryPrice, entryIndex, config.forwardSessions);
      baseline.push(forwardReturn);
      baselinePaths.push(path);

      const trigger = triggerStates[signalIndex];
      if (!trigger.hit) continue;
      if (config.suppressOverlap && entryIndex <= lastBlockedIndex) continue;

      events.push({
        signalIndex,
        date: dates[signalIndex],
        entryDate: dates[entryIndex],
        exitDate: dates[exitIndex],
        matchCount: 1,
        eventLabel: trigger.shortLabel,
        referenceLevel: trigger.referenceLevel,
        forwardReturn,
        targetReturn: targetReturns[signalIndex],
        contextReturn: contextReturns[signalIndex],
        contextLevel: contextCloses[signalIndex],
        path
      });
      if (config.suppressOverlap) lastBlockedIndex = exitIndex;
    }

    if (!events.length) {
      throw new Error(`No qualifying ${config.extremeDirection === 'low' ? 'low' : 'high'} events were found for this setup. Try a longer range or a less restrictive event definition.`);
    }

    const eventReturns = events.map(event => event.forwardReturn);
    const avgPath = this.averagePath(events.map(event => event.path), config.forwardSessions);
    const baselinePath = this.averagePath(baselinePaths, config.forwardSessions);
    const negativeRate = eventReturns.filter(value => value < 0).length / eventReturns.length;
    const positiveRate = eventReturns.filter(value => value > 0).length / eventReturns.length;
    const baselineNegativeRate = baseline.filter(value => value < 0).length / baseline.length;
    const baselinePositiveRate = baseline.filter(value => value > 0).length / baseline.length;
    const meanReturn = PA.Compute.mean(eventReturns);
    const medianReturn = this.median(eventReturns);
    const baselineMean = PA.Compute.mean(baseline);
    const volatility = eventReturns.length > 1 ? PA.Compute.stdDev(eventReturns) : 0;
    const tStatistic = volatility > 0 && eventReturns.length > 1
      ? meanReturn / (volatility / Math.sqrt(eventReturns.length))
      : 0;
    const ci = this.bootstrapMeanCI(eventReturns, 400);
    const edge = config.outcomeDirection === 'down'
      ? negativeRate - baselineNegativeRate
      : config.outcomeDirection === 'up'
        ? positiveRate - baselinePositiveRate
        : meanReturn - baselineMean;

    const regimeSplit = this.buildRegimeSplit(events, config.contextSymbol);
    const warnings = [];
    if (events.length < 15) warnings.push('Thin event sample. Treat the result as exploratory.');
    if (events.length < 30) warnings.push('Sample size is usable but still fragile for broad claims.');
    if (Math.abs(tStatistic) < 1) warnings.push('The mean forward return is weak relative to its own dispersion.');
    if (Math.abs(edge) < 0.02 && config.outcomeDirection !== 'either') warnings.push('Conditional hit rate is only modestly different from the unconditional baseline.');
    if (config.range === '1Y' || config.range === '3Y') warnings.push('Consider a longer range before trusting the effect.');

    const tradeCurve = this.buildTradeCurve(events);
    return {
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      validWindows: baseline.length,
      coverage: events.length / baseline.length,
      eventCount: events.length,
      eventReturns,
      forwardDistribution: this.returnDistribution(eventReturns),
      avgPath,
      baselinePath,
      meanReturn,
      medianReturn,
      baselineMean,
      negativeRate,
      positiveRate,
      baselineNegativeRate,
      baselinePositiveRate,
      tStatistic,
      ci,
      edge,
      volatility,
      tradeCurve,
      auditSeries: {
        dates,
        targetReturns,
        contextReturns,
        contextLevels: contextCloses,
        referenceLevels,
        targetNormalized: PA.Compute.normalizePerformance(targetSeries)
      },
      regimeSplit,
      warnings,
      recentEvents: events.slice(-12).reverse(),
      chartEvents: events.slice(-16),
      events
    };
  },

  evaluateExtremeTrigger(dates, levels, signalIndex, config) {
    const level = levels?.[signalIndex];
    if (!Number.isFinite(level)) {
      return { hit: false, referenceLevel: null, shortLabel: '' };
    }
    const startIndex = this.extremeReferenceStartIndex(dates, signalIndex, config);
    if (startIndex == null || startIndex >= signalIndex) {
      return { hit: false, referenceLevel: null, shortLabel: '' };
    }

    const previousLevels = [];
    for (let index = startIndex; index < signalIndex; index++) {
      const value = levels[index];
      if (Number.isFinite(value)) previousLevels.push(value);
    }
    if (!previousLevels.length) {
      return { hit: false, referenceLevel: null, shortLabel: '' };
    }

    const referenceLevel = config.extremeDirection === 'low'
      ? Math.min(...previousLevels)
      : Math.max(...previousLevels);
    const strict = Boolean(config.extremeStrict);
    const hit = config.extremeDirection === 'low'
      ? (strict ? level < referenceLevel : level <= referenceLevel)
      : (strict ? level > referenceLevel : level >= referenceLevel);

    return {
      hit,
      label: this.describeTrigger(config),
      shortLabel: `${config.extremeReference === 'ytd' ? 'YTD' : (config.extremeReference === '52-week' ? '52W' : (config.extremeReferenceLabel || `${config.windowSessions}-session`))} ${config.extremeDirection === 'low' ? 'Low' : 'High'}`,
      referenceLevel
    };
  },

  extremeReferenceStartIndex(dates, signalIndex, config) {
    if (config.extremeReference === 'ytd') {
      const year = String(dates?.[signalIndex] || '').slice(0, 4);
      for (let index = signalIndex; index >= 0; index--) {
        if (String(dates?.[index] || '').slice(0, 4) !== year) {
          return index + 1;
        }
      }
      return 0;
    }
    const window = Math.max(2, Number(config.windowSessions || 252));
    return Math.max(0, signalIndex - window);
  },

  matchRelation(targetReturn, contextReturn, relation='same-direction') {
    if (!Number.isFinite(targetReturn) || !Number.isFinite(contextReturn)) return false;
    const targetSign = Math.sign(targetReturn);
    const contextSign = Math.sign(contextReturn);
    if (targetSign === 0 || contextSign === 0) return false;
    return relation === 'opposite-direction'
      ? targetSign === -contextSign
      : targetSign === contextSign;
  },

  countMatches(flags, endIndex, windowSessions) {
    const start = Math.max(1, endIndex - windowSessions + 1);
    let count = 0;
    for (let index = start; index <= endIndex; index++) {
      if (flags[index]) count += 1;
    }
    return count;
  },

  buildForwardPath(closes, entryPrice, entryIndex, forwardSessions) {
    const path = [];
    for (let step = 1; step <= forwardSessions; step++) {
      const close = closes[entryIndex + step];
      path.push(Number.isFinite(close) && entryPrice > 0 ? (close / entryPrice) - 1 : null);
    }
    return path;
  },

  averagePath(paths, forwardSessions) {
    const result = [];
    for (let step = 0; step < forwardSessions; step++) {
      const values = paths.map(path => path?.[step]).filter(Number.isFinite);
      result.push(values.length ? PA.Compute.mean(values) : null);
    }
    return result;
  },

  buildRegimeSplit(events, contextSymbol='^VIX') {
    const levels = events.map(event => event.contextLevel).filter(Number.isFinite);
    if (!levels.length) return [];

    const useFixedVixSplit = contextSymbol === '^VIX';
    const threshold = useFixedVixSplit ? 20 : this.median(levels);
    const low = events.filter(event => Number.isFinite(event.contextLevel) && event.contextLevel <= threshold);
    const high = events.filter(event => Number.isFinite(event.contextLevel) && event.contextLevel > threshold);

    const describe = (label, subset) => ({
      label,
      count: subset.length,
      negativeRate: subset.length ? subset.filter(event => event.forwardReturn < 0).length / subset.length : null,
      meanReturn: subset.length ? PA.Compute.mean(subset.map(event => event.forwardReturn)) : null
    });

    return [
      describe(useFixedVixSplit ? `${this.labelSymbol(contextSymbol)} <= ${threshold}` : `Lower ${this.labelSymbol(contextSymbol)}`, low),
      describe(useFixedVixSplit ? `${this.labelSymbol(contextSymbol)} > ${threshold}` : `Higher ${this.labelSymbol(contextSymbol)}`, high)
    ];
  },

  median(values=[]) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  },

  bootstrapMeanCI(values=[], iterations=400) {
    const clean = values.filter(Number.isFinite);
    if (!clean.length) return { low: 0, high: 0 };
    const means = [];
    for (let i = 0; i < iterations; i++) {
      let sum = 0;
      for (let j = 0; j < clean.length; j++) {
        const sample = clean[Math.floor(Math.random() * clean.length)];
        sum += sample;
      }
      means.push(sum / clean.length);
    }
    means.sort((a, b) => a - b);
    return {
      low: this.percentileFromSorted(means, 0.025),
      high: this.percentileFromSorted(means, 0.975)
    };
  },

  percentileFromSorted(sortedValues=[], percentile=0.5) {
    if (!sortedValues.length) return 0;
    const index = Math.min(sortedValues.length - 1, Math.max(0, percentile * (sortedValues.length - 1)));
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  },

  qualityBadge(eventCount=0, tStatistic=0) {
    if (eventCount < 15) return { label: 'Thin sample', kind: 'bad' };
    if (eventCount < 30 || Math.abs(tStatistic) < 1) return { label: 'Exploratory signal', kind: 'warn' };
    return { label: 'Usable first pass', kind: 'good' };
  },

  buildHistogram(values=[], binCount=8) {
    const clean = values.filter(Number.isFinite);
    if (!clean.length) return { labels: [], counts: [] };
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    if (min === max) {
      return { labels: [PA.Fmt.pct(min)], counts: [clean.length] };
    }
    const width = (max - min) / binCount;
    const counts = new Array(binCount).fill(0);
    clean.forEach(value => {
      const index = Math.min(binCount - 1, Math.floor((value - min) / width));
      counts[index] += 1;
    });
    const labels = counts.map((_, index) => {
      const start = min + (index * width);
      const end = start + width;
      return `${PA.Fmt.pct(start, 1)} to ${PA.Fmt.pct(end, 1)}`;
    });
    return { labels, counts };
  },

  renderAuditChart(config, result) {
    const containerId = 'sl-chart-audit';
    const el = document.getElementById(containerId);
    if (!el) return;
    const targetLabel = result.studyPlan?.target?.selectedLabel || this.labelSymbol(config.targetSymbol);
    const contextLabel = result.studyPlan?.context?.selectedLabel || this.labelSymbol(config.contextSymbol);

    const audit = this.buildAuditWindow(result.auditSeries || {}, result.events || []);
    if (!audit.dates.length) {
      el.innerHTML = '<div class="strategy-note">Audit chart unavailable for this run.</div>';
      return;
    }

    PA.Charts.destroy(containerId);

    if (!window.Plotly) {
      el.innerHTML = '<canvas id="sl-chart-audit-fallback"></canvas>';
      if (config.eventMode === 'price-extreme') {
        PA.Charts.multiLine('sl-chart-audit-fallback', audit.dates, [
          { label: `${contextLabel} level`, data: audit.contextLevels, color: '#f97316' },
          { label: 'Reference', data: audit.referenceLevels, color: '#fbbf24' }
        ]);
      } else {
        PA.Charts.multiLine('sl-chart-audit-fallback', audit.dates, [
          { label: `${targetLabel} 1D`, data: audit.targetReturns, color: '#4f8ff7' },
          { label: `${contextLabel} 1D`, data: audit.contextReturns, color: '#f97316' },
          { label: 'Match count', data: audit.rollingMatchCount, color: '#34d399' }
        ], { pct: true });
      }
      return;
    }

    el.innerHTML = '';
    const signalX = audit.visibleEvents.map(event => audit.dates[event.localIndex]);
    const traces = [];
    let layout = {
      ...PA.Charts.plotlyLayoutBase(360),
      margin: { l: 56, r: 56, t: 28, b: 42 },
      xaxis: PA.Charts.plotlyDateAxis()
    };

    if (config.eventMode === 'price-extreme') {
      const signalY = audit.visibleEvents.map(event => audit.contextLevels[event.localIndex]);
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: audit.dates,
        y: audit.contextLevels,
        name: `${contextLabel} level`,
        line: { color: '#f97316', width: 2 }
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: audit.dates,
        y: audit.referenceLevels,
        name: `${config.extremeReferenceLabel || 'Reference'} ${config.extremeDirection === 'low' ? 'low' : 'high'}`,
        line: { color: '#fbbf24', width: 1.8, dash: 'dot' }
      });
      traces.push({
        type: 'scatter',
        mode: 'markers',
        x: signalX,
        y: signalY,
        name: 'Signal dates',
        marker: { color: '#f8fafc', size: 8, line: { color: '#f97316', width: 2 } },
        hovertemplate: '%{x}<br>Signal level: %{y:.2f}<extra></extra>'
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: audit.dates,
        y: audit.targetNormalized,
        name: `${targetLabel} normalized`,
        yaxis: 'y2',
        line: { color: '#4f8ff7', width: 1.6 }
      });
      layout = {
        ...layout,
        yaxis: {
          title: `${contextLabel} level`,
          gridcolor: 'rgba(45,50,72,0.35)',
          tickfont: { color: '#6b7280' }
        },
        yaxis2: {
          title: `${targetLabel} normalized`,
          overlaying: 'y',
          side: 'right',
          tickformat: '.0%',
          tickfont: { color: '#93c5fd' }
        }
      };
    } else {
      const signalY = audit.visibleEvents.map(event => audit.rollingMatchCount[event.localIndex]);
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: audit.dates,
        y: audit.targetReturns,
        name: `${targetLabel} 1D return`,
        line: { color: '#4f8ff7', width: 1.8 }
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: audit.dates,
        y: audit.contextReturns,
        name: `${contextLabel} 1D return`,
        line: { color: '#f97316', width: 1.8 }
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: audit.dates,
        y: audit.rollingMatchCount,
        name: 'Rolling match count',
        yaxis: 'y2',
        line: { color: '#34d399', width: 2 }
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: audit.dates,
        y: audit.thresholdLine,
        name: 'Threshold',
        yaxis: 'y2',
        line: { color: '#fbbf24', width: 1.6, dash: 'dot' }
      });
      traces.push({
        type: 'scatter',
        mode: 'markers',
        x: signalX,
        y: signalY,
        name: 'Signal dates',
        yaxis: 'y2',
        marker: { color: '#f8fafc', size: 8, line: { color: '#34d399', width: 2 } },
        hovertemplate: '%{x}<br>Match count: %{y}<extra></extra>'
      });
      layout = {
        ...layout,
        yaxis: {
          title: '1D return',
          tickformat: '.1%',
          zeroline: true,
          zerolinecolor: 'rgba(148,163,184,0.35)',
          gridcolor: 'rgba(45,50,72,0.35)',
          tickfont: { color: '#6b7280' }
        },
        yaxis2: {
          title: 'Match count',
          overlaying: 'y',
          side: 'right',
          rangemode: 'tozero',
          tickfont: { color: '#86efac' }
        }
      };
    }

    window.Plotly.newPlot(el, traces, layout, { responsive: true, displayModeBar: false });
    PA.Charts.registerPlotly(containerId, el);
  },

  renderResults(config, result) {
    const resultsDiv = document.getElementById('strategy-results');
    if (!resultsDiv) return;

    const quality = this.qualityBadge(result.eventCount, result.tStatistic);
    const requestedStats = this.requestedOutcomeStats(result, config);
    const targetPlan = result.studyPlan?.target || null;
    const contextPlan = result.studyPlan?.context || null;
    const targetLabel = targetPlan?.requestedLabel || this.labelSymbol(config.targetSymbol, { withSource: true });
    const targetExecutionLabel = targetPlan?.selectedLabel || targetLabel;
    const contextSymbolLabel = contextPlan?.requestedLabel || this.labelSymbol(config.contextSymbol, { withSource: true });
    const contextExecutionLabel = contextPlan?.selectedLabel || contextSymbolLabel;
    const targetSourceLabel = this.describeHistorySource(targetPlan?.selectedHistory);
    const contextSourceLabel = this.describeHistorySource(contextPlan?.selectedHistory);
    const targetAttemptChain = this.describeHistoryAttempts(targetPlan?.selectedHistory);
    const contextAttemptChain = this.describeHistoryAttempts(contextPlan?.selectedHistory);
    const distribution = result.forwardDistribution || this.returnDistribution(result.eventReturns || []);
    const trade = this.hypothesisTradeStats(result, config);
    const signalCounts = this.signalCountStats(result);
    const forwardLabels = result.tradeCurve?.dates || [];
    const contextLabel = config.eventMode === 'price-extreme' ? 'Trigger' : 'Context';
    const primaryEventColumn = config.eventMode === 'price-extreme' ? 'Trigger Event' : 'Match Count';
    const referenceColumn = config.eventMode === 'price-extreme'
      ? `<th class="right">Reference</th>`
      : '';
    const answer = this.buildPromptAnswer(config, result);
    const definitions = this.resultDefinitions(config, result);
    const comparisonRows = `
      <tr>
        <td>${PA.UI.escapeHtml(requestedStats.label)}</td>
        <td class="right">${PA.Fmt.pct(requestedStats.value)}</td>
        <td class="right">${PA.Fmt.pct(requestedStats.baseline)}</td>
        <td class="right ${PA.Fmt.colorClass(requestedStats.edge)}">${PA.Fmt.pct(requestedStats.edge)}</td>
      </tr>
      <tr>
        <td>Average ${config.forwardSessions}D return</td>
        <td class="right ${PA.Fmt.colorClass(result.meanReturn)}">${PA.Fmt.pct(result.meanReturn)}</td>
        <td class="right ${PA.Fmt.colorClass(result.baselineMean)}">${PA.Fmt.pct(result.baselineMean)}</td>
        <td class="right ${PA.Fmt.colorClass(result.meanReturn - result.baselineMean)}">${PA.Fmt.pct(result.meanReturn - result.baselineMean)}</td>
      </tr>
      <tr>
        <td>Median ${config.forwardSessions}D return</td>
        <td class="right ${PA.Fmt.colorClass(result.medianReturn)}">${PA.Fmt.pct(result.medianReturn)}</td>
        <td class="right">N/A</td>
        <td class="right">N/A</td>
      </tr>
    `;
    const regimeRows = result.regimeSplit.map(row => `
      <tr>
        <td>${PA.UI.escapeHtml(row.label)}</td>
        <td class="right">${row.count}</td>
        <td class="right">${row.negativeRate == null ? 'N/A' : PA.Fmt.pct(row.negativeRate)}</td>
        <td class="right ${PA.Fmt.colorClass(row.meanReturn)}">${row.meanReturn == null ? 'N/A' : PA.Fmt.pct(row.meanReturn)}</td>
      </tr>
    `).join('');
    const overlapRows = result.overlapComparison ? [result.overlapComparison.raw, result.overlapComparison.suppressed].map(row => `
      <tr>
        <td>${PA.UI.escapeHtml(row.label)}</td>
        <td class="right">${row.eventCount}</td>
        <td class="right">${PA.Fmt.pct(row.requestedValue)}</td>
        <td class="right ${PA.Fmt.colorClass(row.meanReturn)}">${PA.Fmt.pct(row.meanReturn)}</td>
      </tr>
    `).join('') : '';
    const overlapContent = result.overlapComparison
      ? `
          <div class="strategy-table-wrap">
            <table class="data-table strategy-event-table">
              <thead>
                <tr><th>Mode</th><th class="right">Event Count</th><th class="right">${PA.UI.escapeHtml(requestedStats.label)}</th><th class="right">Average ${config.forwardSessions}D Return</th></tr>
              </thead>
              <tbody>${overlapRows}</tbody>
            </table>
          </div>
        `
      : `<div class="strategy-note">Overlap comparison was unavailable for this run because one side of the comparison produced no qualifying events.</div>`;
    const targetAuditRows = (targetPlan?.audits || []).map(audit => `
      <tr>
        <td>${PA.UI.escapeHtml(audit.label || audit.symbol)}</td>
        <td class="right">${audit.correlation == null ? 'N/A' : PA.Fmt.ratio(audit.correlation, 3)}</td>
        <td class="right">${PA.UI.escapeHtml(audit.accepted ? 'Accepted' : 'Rejected')}</td>
      </tr>
    `).join('');
    const contextAuditRows = (contextPlan?.audits || []).map(audit => `
      <tr>
        <td>${PA.UI.escapeHtml(audit.label || audit.symbol)}</td>
        <td class="right">${audit.overlapRatio == null ? 'N/A' : PA.Fmt.pct(audit.overlapRatio)}</td>
        <td class="right">${audit.candidateEventCount || 0}</td>
        <td class="right">${audit.canonicalEventCount || 0}</td>
        <td class="right">${PA.UI.escapeHtml(audit.accepted ? 'Accepted' : 'Rejected')}</td>
      </tr>
    `).join('');

    resultsDiv.innerHTML = `
      <div class="card">
        <div class="card-title">Prompt Answer</div>
        <div class="strategy-answer-callout">${PA.UI.escapeHtml(answer)}</div>
        <div class="strategy-definition-grid">
          ${definitions.map(item => `
            <div class="strategy-definition-item">
              <div class="strategy-definition-label">${PA.UI.escapeHtml(item.label)}</div>
              <div class="strategy-definition-copy">${PA.UI.escapeHtml(item.detail)}</div>
            </div>
          `).join('')}
        </div>
        <div class="strategy-results-grid">
          <div class="strategy-kpi">
            <div class="strategy-kpi-label">1. Signal Count</div>
            <div class="strategy-kpi-value">${signalCounts.selectedCount}</div>
            <div class="strategy-kpi-detail">Raw ${signalCounts.rawCount} | overlap-suppressed ${signalCounts.suppressedCount}. ${PA.Fmt.pct(result.coverage)} of ${result.validWindows} valid ${config.forwardSessions}D windows triggered.</div>
          </div>
          <div class="strategy-kpi">
            <div class="strategy-kpi-label">2. ${PA.UI.escapeHtml(requestedStats.label)}</div>
            <div class="strategy-kpi-value">${PA.Fmt.pct(requestedStats.value)}</div>
            <div class="strategy-kpi-detail">Formula: ${config.outcomeDirection === 'down' ? 'P(forward return < 0)' : (config.outcomeDirection === 'up' ? 'P(forward return > 0)' : 'mean forward return')}. Baseline ${PA.Fmt.pct(requestedStats.baseline)} | edge ${PA.Fmt.pct(requestedStats.edge)}.</div>
          </div>
          <div class="strategy-kpi">
            <div class="strategy-kpi-label">3. Forward Return Distribution</div>
            <div class="strategy-kpi-value ${PA.Fmt.colorClass(distribution.mean)}">${PA.Fmt.pct(distribution.mean)}</div>
            <div class="strategy-kpi-detail">Median ${PA.Fmt.pct(distribution.median)} | high ${PA.Fmt.pct(distribution.max)} | low ${PA.Fmt.pct(distribution.min)} | p25-p75 ${PA.Fmt.pct(distribution.p25)} to ${PA.Fmt.pct(distribution.p75)}.</div>
          </div>
          <div class="strategy-kpi">
            <div class="strategy-kpi-label">4. Hypothesis-Side Trade</div>
            <div class="strategy-kpi-value ${PA.Fmt.colorClass(trade.totalReturn)}">${PA.Fmt.pct(trade.totalReturn)}</div>
            <div class="strategy-kpi-detail">${PA.UI.escapeHtml(trade.label)} | ${PA.UI.escapeHtml(trade.formula)} | avg/trade ${PA.Fmt.pct(trade.meanReturn)} | median/trade ${PA.Fmt.pct(trade.medianReturn)}.</div>
          </div>
          <div class="strategy-kpi">
            <div class="strategy-kpi-label">Long / Short Check</div>
            <div class="strategy-kpi-value ${PA.Fmt.colorClass(result.tradeCurve.longTotalReturn)}">${PA.Fmt.pct(result.tradeCurve.longTotalReturn)}</div>
            <div class="strategy-kpi-detail">Long all signals ${PA.Fmt.pct(result.tradeCurve.longTotalReturn)} | short all signals ${PA.Fmt.pct(result.tradeCurve.shortTotalReturn)}. Compounded, not annualized.</div>
          </div>
          <div class="strategy-kpi">
            <div class="strategy-kpi-label">Credibility Read</div>
            <div class="strategy-kpi-value">${PA.UI.escapeHtml(quality.label)}</div>
            <div class="strategy-kpi-detail">t-stat ${PA.Fmt.ratio(result.tStatistic)} | ${result.warnings[0] ? PA.UI.escapeHtml(result.warnings[0]) : 'First-pass event study result.'}</div>
          </div>
        </div>
        <div class="strategy-badge-row">
          <div class="strategy-pill strategy-pill-${quality.kind}">${PA.UI.escapeHtml(quality.label)}</div>
          <div class="strategy-pill strategy-pill-info">Range: ${PA.UI.escapeHtml(config.range)}</div>
          <div class="strategy-pill strategy-pill-info">Target: ${PA.UI.escapeHtml(targetLabel)}</div>
          <div class="strategy-pill strategy-pill-info">${PA.UI.escapeHtml(contextLabel)}: ${PA.UI.escapeHtml(contextSymbolLabel)}</div>
          ${targetPlan?.usingProxy ? `<div class="strategy-pill strategy-pill-good">Measured with ${PA.UI.escapeHtml(targetExecutionLabel)}</div>` : ''}
          ${contextPlan?.usingProxy ? `<div class="strategy-pill strategy-pill-good">Signal via ${PA.UI.escapeHtml(contextExecutionLabel)}</div>` : ''}
          ${result.warnings.map(warning => `<div class="strategy-pill strategy-pill-warn">${PA.UI.escapeHtml(warning)}</div>`).join('')}
        </div>
        <div class="strategy-note" style="margin-top:12px">
          Sample window: ${PA.UI.escapeHtml(result.startDate)} to ${PA.UI.escapeHtml(result.endDate)}.
          ${PA.UI.escapeHtml(this.describeResultTrigger(config))}
        </div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-title">Signal Audit Chart</div>
          <div class="strategy-note">
            ${PA.UI.escapeHtml(config.eventMode === 'price-extreme'
              ? 'This chart centers on the latest signal window and shows the trigger level, its reference line, and the target normalized price so you can verify that the high or low really happened.'
              : 'This chart centers on the latest signal window and shows target and context 1D returns plus the rolling match count, so you can verify that the trigger condition really fired.')}
          </div>
          <div class="chart-container chart-lg"><div id="sl-chart-audit" class="plotly-chart"></div></div>
        </div>
        <div class="card">
          <div class="card-title">Signal Strategy Equity</div>
          <div class="strategy-note">Each step is one signal, not one day. This shows what longing or shorting every signal would have compounded to across the sample.</div>
          <div class="chart-container chart-lg"><canvas id="sl-chart-trades"></canvas></div>
        </div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-title">Prompt vs Baseline</div>
          <div class="strategy-note">This is the cleanest way to check whether the signal beats normal market behavior instead of just sounding interesting.</div>
          <div class="strategy-table-wrap">
            <table class="data-table strategy-event-table">
              <thead>
                <tr><th>Metric</th><th class="right">Signal Dates</th><th class="right">All Windows</th><th class="right">Edge</th></tr>
              </thead>
              <tbody>${comparisonRows}</tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Overlap Check</div>
          <div class="strategy-note">This mirrors the plugin-style sanity check: compare every raw signal against the overlap-suppressed version so repeated clustered triggers do not masquerade as extra evidence.</div>
          ${overlapContent}
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">Series Resolution</div>
        <div class="strategy-note">${PA.UI.escapeHtml(targetPlan?.resolutionNote || 'Target series resolution unavailable.')}</div>
        <div class="strategy-note" style="margin-top:6px">${PA.UI.escapeHtml(contextPlan?.resolutionNote || 'Signal-series resolution unavailable.')}</div>
        <div class="strategy-note" style="margin-top:10px"><strong>Target source used:</strong> ${PA.UI.escapeHtml(targetSourceLabel)}</div>
        <div class="strategy-note" style="margin-top:6px"><strong>Signal source used:</strong> ${PA.UI.escapeHtml(contextSourceLabel)}</div>
        <div class="strategy-note" style="margin-top:6px"><strong>Target fallback path:</strong> ${PA.UI.escapeHtml(targetAttemptChain)}</div>
        <div class="strategy-note" style="margin-top:6px"><strong>Signal fallback path:</strong> ${PA.UI.escapeHtml(contextAttemptChain)}</div>
        <div class="grid-2" style="margin-top:12px">
          <div>
            <div class="strategy-summary-title">Target Proxy Audit</div>
            ${targetAuditRows ? `
              <div class="strategy-table-wrap">
                <table class="data-table strategy-event-table">
                  <thead><tr><th>Candidate</th><th class="right">Return Corr</th><th class="right">Decision</th></tr></thead>
                  <tbody>${targetAuditRows}</tbody>
                </table>
              </div>
            ` : '<div class="strategy-note">No target proxy audit was needed for this run.</div>'}
          </div>
          <div>
            <div class="strategy-summary-title">Signal Proxy Audit</div>
            ${contextAuditRows ? `
              <div class="strategy-table-wrap">
                <table class="data-table strategy-event-table">
                  <thead><tr><th>Candidate</th><th class="right">Trigger Overlap</th><th class="right">Proxy Events</th><th class="right">Canonical Events</th><th class="right">Decision</th></tr></thead>
                  <tbody>${contextAuditRows}</tbody>
                </table>
              </div>
            ` : '<div class="strategy-note">No signal proxy audit was needed for this run.</div>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">Regime Split</div>
        <div class="strategy-note">Quick split by context level to see whether the effect is concentrated in one regime.</div>
        <div class="strategy-table-wrap">
          <table class="data-table strategy-event-table">
            <thead>
              <tr><th>Regime</th><th class="right">Count</th><th class="right">Down %</th><th class="right">Mean</th></tr>
            </thead>
            <tbody>${regimeRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">Event Log</div>
        <div class="strategy-note">Inspect every qualifying window before trusting the summary. Large edges built on a handful of dates are usually not durable.</div>
        <div class="strategy-table-wrap">
          <table class="data-table strategy-event-table">
            <thead>
              <tr>
                <th>Signal Date</th>
                <th class="right">${PA.UI.escapeHtml(primaryEventColumn)}</th>
                <th class="right">Target 1D</th>
                <th class="right">${PA.UI.escapeHtml(contextLabel)} 1D</th>
                <th class="right">Forward Return</th>
                <th class="right">${PA.UI.escapeHtml(contextLabel)} Level</th>
                ${referenceColumn}
              </tr>
            </thead>
            <tbody>
              ${result.recentEvents.map(event => `
                <tr>
                  <td>${PA.UI.escapeHtml(event.date)}</td>
                  <td class="right">${PA.UI.escapeHtml(event.eventLabel || String(event.matchCount))}</td>
                  <td class="right ${PA.Fmt.colorClass(event.targetReturn)}">${PA.Fmt.pct(event.targetReturn || 0)}</td>
                  <td class="right ${PA.Fmt.colorClass(event.contextReturn)}">${PA.Fmt.pct(event.contextReturn || 0)}</td>
                  <td class="right ${PA.Fmt.colorClass(event.forwardReturn)}">${PA.Fmt.pct(event.forwardReturn)}</td>
                  <td class="right">${this.formatLevelValue(event.contextLevel, config.contextSymbol)}</td>
                  ${config.eventMode === 'price-extreme' ? `<td class="right">${this.formatLevelValue(event.referenceLevel, config.contextSymbol)}</td>` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    this.renderAuditChart(config, result);

    PA.Charts.multiLine('sl-chart-trades', forwardLabels, [
      { label: 'Long every signal', data: result.tradeCurve.longCurve, color: '#4f8ff7' },
      { label: 'Short every signal', data: result.tradeCurve.shortCurve, color: '#f97316' }
    ], { pct: true });
  }
};
