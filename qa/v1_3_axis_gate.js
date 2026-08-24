"use strict";

const crypto = require("crypto");
const scaleApi = require("../chart-scale.js");

const CASE_COUNT = 10000;
const failures = [];
const observations = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function hasZeroTick(scale) {
  return scale.ticks.some((tick) => Math.abs(tick.value) < 1e-12);
}

for (let index = 0; index < CASE_COUNT; index += 1) {
  const mode = index % 10;
  try {
    let scale;
    if (mode === 0) {
      const maximum = 2100 + (index % 17) * 230;
      scale = scaleApi.buildAxisScale([270, maximum], {}, { unit: "U.S. dollars per troy ounce", transform: "raw" }, 500);
      check(scale.domainMin === 0, "positive dollar levels must start at zero");
      check(scale.ticks.every((tick) => tick.label.startsWith("$")), "dollar ticks need currency labels");
      check(scale.ticks.every((tick) => !/\.\d/.test(tick.label)), "whole-dollar steps must not show decimals");
    } else if (mode === 1) {
      const maximum = 2.1 + (index % 31) / 10;
      scale = scaleApi.buildAxisScale([0.11, maximum], {}, { unit: "Percent", transform: "raw" }, 500);
      check(scale.domainMin === 0, "positive yields must start at zero");
      check(scale.ticks.every((tick) => tick.label.endsWith("%")), "yield ticks need percent labels");
    } else if (mode === 2) {
      scale = scaleApi.buildAxisScale([-12 - (index % 7), -2], {}, { unit: "Index", transform: "raw" }, 450);
      check(scale.domainMax === 0, "all-negative linear data must retain a zero reference");
      check(hasZeroTick(scale), "all-negative linear data needs a zero tick");
    } else if (mode === 3) {
      scale = scaleApi.buildAxisScale([-4, 7 + (index % 5)], {}, { unit: "Percent", transform: "pct_change" }, 550);
      check(scale.domainMin < 0 && scale.domainMax > 0, "cross-zero data must preserve both signs");
      check(hasZeroTick(scale), "cross-zero data needs a zero tick");
    } else if (mode === 4) {
      scale = scaleApi.buildAxisScale([0.0012, 0.0087 + (index % 4) / 10000], {}, { unit: "Percent", transform: "raw" }, 500);
      check(scale.step < 0.01, "small values need a fractional nice step");
      check(scale.ticks.every((tick) => !/\.0+%$/.test(tick.label)), "fractional labels must not contain redundant trailing zeros");
    } else if (mode === 5) {
      const minimum = 100 + (index % 10);
      const maximum = 900 + (index % 13);
      scale = scaleApi.buildAxisScale([200, 800], { min: minimum, max: maximum }, { unit: "Index", transform: "raw" }, 500);
      check(scale.domainMin === minimum && scale.domainMax === maximum, "explicit bounds must be preserved exactly");
    } else if (mode === 6) {
      let rejected = false;
      try {
        scaleApi.buildAxisScale([1, 2], { min: 5, max: 5 }, { unit: "Index", transform: "raw" }, 500);
      } catch {
        rejected = true;
      }
      check(rejected, "invalid equal bounds must be rejected");
    } else if (mode === 7) {
      scale = scaleApi.buildAxisScale([1, 10, 100, 1000], { log: true }, { unit: "Index", transform: "raw" }, 500);
      check(scale.type === "log" && scale.domainMin > 0, "log scale must keep a positive domain");
      check(!hasZeroTick(scale), "log scale must never emit a zero tick");
    } else if (mode === 8) {
      const value = 1 + (index % 100);
      scale = scaleApi.buildAxisScale([value, value], {}, { unit: "Index", transform: "raw" }, 500);
      check(scale.domainMin === 0 && scale.domainMax > value, "constant positive series needs a usable zero-based domain");
    } else {
      scale = scaleApi.buildAxisScale([-1.25, 3.75], {}, { unit: "Index", transform: "pct_yoy" }, 500);
      check(scale.ticks.every((tick) => tick.label.endsWith("%")), "percentage transforms need percent labels");
      check(hasZeroTick(scale), "percentage transforms need a zero reference");
    }
    observations.push([mode, scale?.domainMin ?? null, scale?.domainMax ?? null, scale?.step ?? null]);
  } catch (error) {
    failures.push({ index, mode, error: error.message });
  }
}

const digest = crypto.createHash("sha256").update(JSON.stringify(observations)).digest("hex");
process.stdout.write(JSON.stringify({
  caseCount: CASE_COUNT,
  passCount: CASE_COUNT - failures.length,
  failCount: failures.length,
  failures: failures.slice(0, 20),
  digest,
}));
