(function exposeChartScale(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SideToolsChartScale = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function chartScaleFactory() {
  "use strict";

  const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10];

  function finiteValues(values, log) {
    return (values || [])
      .map(Number)
      .filter(Number.isFinite)
      .filter((value) => !log || value > 0);
  }

  function niceStep(span, targetIntervals) {
    if (!Number.isFinite(span) || span <= 0) return 1;
    const rough = span / Math.max(1, targetIntervals);
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / magnitude;
    const multiplier = NICE_MULTIPLIERS.find((candidate) => candidate >= normalized) || 10;
    return multiplier * magnitude;
  }

  function decimalsForStep(step) {
    const absolute = Math.abs(Number(step));
    if (!Number.isFinite(absolute) || absolute === 0) return 0;
    for (let decimals = 0; decimals <= 8; decimals += 1) {
      if (Math.abs(absolute - Number(absolute.toFixed(decimals))) <= absolute * 1e-10) return decimals;
    }
    return 8;
  }

  function unitKind(context) {
    const unit = String(context?.unit || "").toLowerCase();
    const transform = String(context?.transform || "raw").toLowerCase();
    if (["pct_change", "pct_yoy", "percent", "percentage"].includes(transform)) return "percent";
    if (/percent|percentage/.test(unit)) return "percent";
    if (/u\.s\. dollars|us dollars|dollars per|\busd\b/.test(unit)) return "currency";
    return "number";
  }

  function formatTick(value, step, context) {
    const decimals = decimalsForStep(step);
    const normalized = Math.abs(value) < Math.abs(step) * 1e-10 ? 0 : value;
    const options = {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.min(6, decimals),
      useGrouping: true,
    };
    const formatted = new Intl.NumberFormat("en-US", options).format(normalized);
    const kind = unitKind(context);
    if (kind === "currency") return `$${formatted}`;
    if (kind === "percent") return `${formatted}%`;
    return formatted;
  }

  function linearScale(values, axis, context, plotHeight) {
    const usable = finiteValues(values, false);
    if (!usable.length) throw new Error("The axis has no finite values to display.");
    const explicitMin = axis?.min != null ? Number(axis.min) : null;
    const explicitMax = axis?.max != null ? Number(axis.max) : null;
    if (explicitMin != null && !Number.isFinite(explicitMin)) throw new Error("Axis minimum must be finite.");
    if (explicitMax != null && !Number.isFinite(explicitMax)) throw new Error("Axis maximum must be finite.");
    if (explicitMin != null && explicitMax != null && explicitMin >= explicitMax) {
      throw new Error("Axis minimum must be less than axis maximum.");
    }

    const dataMin = Math.min(...usable);
    const dataMax = Math.max(...usable);
    const includeZero = context?.includeZero !== false;
    let domainMin = explicitMin ?? (includeZero ? Math.min(0, dataMin) : dataMin);
    let domainMax = explicitMax ?? (includeZero ? Math.max(0, dataMax) : dataMax);
    if (domainMin === domainMax) {
      if (domainMin === 0) domainMax = 1;
      else if (domainMin > 0) domainMin = 0;
      else domainMax = 0;
    }

    const targetIntervals = Math.max(3, Math.min(7, Math.round((plotHeight || 500) / 100)));
    const step = niceStep(domainMax - domainMin, targetIntervals);
    if (explicitMin == null) domainMin = Math.floor(domainMin / step) * step;
    if (explicitMax == null) domainMax = Math.ceil(domainMax / step) * step;
    if (domainMin === domainMax) domainMax = domainMin + step;

    const ticks = [];
    const firstTick = explicitMin != null
      ? Math.ceil(domainMin / step - 1e-12) * step
      : domainMin;
    for (let value = firstTick, count = 0; value <= domainMax + step * 1e-9 && count < 100; value += step, count += 1) {
      if (value < domainMin - step * 1e-9) continue;
      const clean = Number(value.toPrecision(14));
      ticks.push({ value: clean, label: formatTick(clean, step, context) });
    }
    if (explicitMin != null && !ticks.some((tick) => Math.abs(tick.value - domainMin) < step * 1e-9)) {
      ticks.unshift({ value: domainMin, label: formatTick(domainMin, step, context) });
    }
    if (explicitMax != null && !ticks.some((tick) => Math.abs(tick.value - domainMax) < step * 1e-9)) {
      ticks.push({ value: domainMax, label: formatTick(domainMax, step, context) });
    }
    return { type: "linear", domainMin, domainMax, step, ticks, includeZero };
  }

  function logarithmicScale(values, axis, context) {
    const usable = finiteValues(values, true);
    if (!usable.length) throw new Error("A logarithmic axis requires at least one positive value.");
    const domainMin = axis?.min != null ? Number(axis.min) : Math.min(...usable);
    const domainMax = axis?.max != null ? Number(axis.max) : Math.max(...usable);
    if (!Number.isFinite(domainMin) || !Number.isFinite(domainMax) || domainMin <= 0 || domainMax <= 0) {
      throw new Error("Logarithmic axis bounds must be positive finite values.");
    }
    if (domainMin >= domainMax) throw new Error("Axis minimum must be less than axis maximum.");
    const ticks = [];
    const startPower = Math.floor(Math.log10(domainMin));
    const endPower = Math.ceil(Math.log10(domainMax));
    for (let power = startPower; power <= endPower; power += 1) {
      for (const multiplier of [1, 2, 5]) {
        const value = multiplier * (10 ** power);
        if (value >= domainMin && value <= domainMax) {
          ticks.push({ value, label: formatTick(value, value, context) });
        }
      }
    }
    return { type: "log", domainMin, domainMax, step: null, ticks, includeZero: false };
  }

  function buildAxisScale(values, axis = {}, context = {}, plotHeight = 500) {
    return axis.log
      ? logarithmicScale(values, axis, context)
      : linearScale(values, axis, context, plotHeight);
  }

  function normalizedPosition(value, scale) {
    if (scale.type === "log") {
      return (
        (Math.log10(value) - Math.log10(scale.domainMin))
        / (Math.log10(scale.domainMax) - Math.log10(scale.domainMin))
      );
    }
    return (value - scale.domainMin) / (scale.domainMax - scale.domainMin);
  }

  return { buildAxisScale, decimalsForStep, formatTick, niceStep, normalizedPosition, unitKind };
}));
