// BrightnessManager.js

const EventEmitter = require('events');
const { loadJSON, saveJSON, retry, learningConfigPath, brightnessLogsPath } = require('./core');
const { getWebCamBrightness } = require('./webcam');
const {
  getCurrentWindow, screenAvgBrightness, getPowerStatus, getNightLightState,
  detectDeviceProfile, getSystemBrightness, setSystemBrightness,
  hasAmbientLightSensor, readAmbientLightLux,
} = require('./signals');

const ONE_DAY_MS = 86400000;
const ONE_MIN_MS = 60000;

const CONFIG = Object.freeze({
  ALGORITHM: {
    TOP_LOGS_PERCENTAGE: 0.1,
    MIN_TOP_LOGS_FALLBACK: 3,
    MAX_TOP_LOGS_COUNT: 25,
    RELEVANT_DISTANCE_STD_DEV_THRESHOLD: 0.5,
    MIN_LOGS_FOR_PREDICTION: 3,
    DISTANCE_EPSILON: 1e-6,
    FALLBACK_MAX_ABSOLUTE_DISTANCE: 2.0,
    MIN_AUTO_CHANGE_THRESHOLD: 2,
    TIME_DECAY_HALF_LIFE_DAYS: 30,
    MIN_MANUAL_CHANGE_THRESHOLD: 1,
    MANUAL_LOG_CONFIDENCE: 1.0,
    RECENCY_BOOST_FACTOR: 5.0,
    STATS_DECAY_ALPHA: 0.005,
    HYSTERESIS_BRIGHTEN_THRESHOLD: 2,
    HYSTERESIS_DIMMING_THRESHOLD: 2.5,
    CONFIDENCE_LOG_SATURATION: 12,
    DIVERSITY_TARGET_RANGE: 0.6,
    MIN_CONFIDENCE_FOR_FULL_TRUST: 0.85,
    OUTLIER_MAD_MULTIPLIER: 2.5,
    MAX_HYSTERESIS_MULTIPLIER: 2.5,
    MAX_STEP_LOW_CONFIDENCE: 15,
    MAX_RELATIONSHIP_FEATURES: 8,
    RELATIONSHIP_SHRINKAGE: 0.25,
    MIN_LOGS_FOR_RELATIONSHIP: 8,
    RELATIONSHIP_MIN_IMPORTANCE: 0.15,
    MIN_POINTS_FOR_INTERACTION_MODEL: 8,
    REGRESSION_RIDGE_LAMBDA: 2.0,
    RECENCY_WINDOW_MINUTES: 30,
    MIN_STAT_COUNT_FOR_DISTANCE: 5,
    MANUAL_CHANGE_CONFIRM_DELAY_MS: 1500,
    MANUAL_LOG_REUSE_WINDOW_MS: 90000,
    FACE_CHECK_INTERVAL_LIGHT: 5,
    SLOW_SIGNAL_INTERVAL_MS: 10 * 60 * 1000,
    POLL_INTERVAL_FLOOR_SEC: 3,
    OVERLOAD_CYCLE_RATIO: 0.6,
    BATTERY_SCARCITY_CEILING: 50,
  },
});

function faceLuxEstimate(faceBrightness) {
  if (!Number.isFinite(faceBrightness)) return null;
  const clamped = Math.min(255, Math.max(1, faceBrightness));
  return Math.round(100 * Math.pow(clamped / 78, 2.3));
}

const FEATURE_DEFINITIONS = {
  webcam: { accessor: (s) => s?.webcamScore, type: 'numeric' },
  screen: { accessor: (s) => s?.screen, type: 'numeric' },
  ambientLight: { accessor: (s) => s?.ambientLight, type: 'numeric' },
  cloud: { accessor: (s) => s?.cloud, type: 'numeric' },
  dayLight: { accessor: (s) => s?.timeFeatures?.dayLight, type: 'numeric' },
  timeSin: { accessor: (s) => s?.timeFeatures?.sin, type: 'numeric' },
  timeCos: { accessor: (s) => s?.timeFeatures?.cos, type: 'numeric' },
  faceCount: { accessor: (s) => s?.faceCount, type: 'numeric' },
  faceBrightness: { accessor: (s) => s?.faceBrightness, type: 'numeric' },
  faceProximity: { accessor: (s) => s?.faceProximity, type: 'numeric' },
  faceCenterDeviation: { accessor: (s) => s?.faceCenterDeviation, type: 'numeric' },
  lightSourceCount: { accessor: (s) => s?.lightSourceCount, type: 'numeric' },
  visualConfidence: { accessor: (s) => s?.visualConfidence, type: 'numeric' },
  batteryLevel: { accessor: (s) => s?.batteryLevel, type: 'numeric' },
  app: { accessor: (s) => s?.app, type: 'categorical' },
  lightDirection: { accessor: (s) => s?.lightDirection, type: 'categorical' },
  powerSource: { accessor: (s) => s?.powerSource, type: 'categorical' },
  nightLight: { accessor: (s) => s?.nightLight, type: 'categorical' },
  ambientLightSource: { accessor: (s) => s?.ambientLightSource, type: 'categorical' },
};

const NUMERIC_FEATURES = [];
const CATEGORICAL_FEATURES = [];
for (const [key, def] of Object.entries(FEATURE_DEFINITIONS)) {
  if (def.type === 'numeric') NUMERIC_FEATURES.push(key);
  else CATEGORICAL_FEATURES.push(key);
}
const ALL_FEATURES = [...NUMERIC_FEATURES, ...CATEGORICAL_FEATURES];

function batteryScarcity(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return Math.min(1, Math.max(0, percent / CONFIG.ALGORITHM.BATTERY_SCARCITY_CEILING));
}

function setFeatureValue(state, key, value) {
  switch (key) {
    case 'webcam': state.webcamScore = value; return;
    case 'dayLight': if (state.timeFeatures) state.timeFeatures.dayLight = value; return;
    case 'timeSin': if (state.timeFeatures) state.timeFeatures.sin = value; return;
    case 'timeCos': if (state.timeFeatures) state.timeFeatures.cos = value; return;
    case 'batteryLevel':
      state.batteryLevel = batteryScarcity(value);
      return;
    default: state[key] = value;
  }
}

const FEATURE_NOISE_FLOOR = 0.1;
const MAD_NOISE_MULTIPLIER = 1.5;
const MIN_SAMPLES_FOR_NOISE_ESTIMATE = 5;

function arrayMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function arrayMean(arr) {  const len = arr.length;
  if (len === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += arr[i];
  return sum / len;
}

function arrayVar(arr, mean) {
  const len = arr.length;
  if (len < 2) return 0;
  let sumSqDiff = 0;
  for (let i = 0; i < len; i++) {
    const diff = arr[i] - mean;
    sumSqDiff += diff * diff;
  }
  return sumSqDiff / len;
}

function zeroMatrix(rows, cols = rows) {
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) out[i] = new Array(cols).fill(0);
  return out;
}

function identityMatrix(n) {
  const out = zeroMatrix(n, n);
  for (let i = 0; i < n; i++) out[i][i] = 1;
  return out;
}

function invertMatrix(matrix, ridge = 1e-6) {
  const n = matrix.length;
  const A = matrix.map((row, i) => row.map((v, j) => v + (i === j ? ridge : 0)));
  const I = identityMatrix(n);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const abs = Math.abs(A[r][col]);
      if (abs > maxAbs) { maxAbs = abs; pivotRow = r; }
    }
    if (maxAbs < 1e-10) return identityMatrix(n);

    if (pivotRow !== col) {
      [A[col], A[pivotRow]] = [A[pivotRow], A[col]];
      [I[col], I[pivotRow]] = [I[pivotRow], I[col]];
    }

    const pivot = A[col][col];
    for (let j = 0; j < n; j++) { A[col][j] /= pivot; I[col][j] /= pivot; }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      if (factor === 0) continue;
      const rowR = A[r];
      const rowI = I[r];
      const rowC = A[col];
      const rowCI = I[col];
      for (let j = 0; j < n; j++) {
        rowR[j] -= factor * rowC[j];
        rowI[j] -= factor * rowCI[j];
      }
    }
  }
  return I;
}

function matVecMul(matrix, vec) {
  const out = new Array(matrix.length).fill(0);
  for (let i = 0; i < matrix.length; i++) {
    let sum = 0;
    const row = matrix[i];
    for (let j = 0; j < vec.length; j++) sum += row[j] * vec[j];
    out[i] = sum;
  }
  return out;
}

function weightedRidgeRegression(rows, targets, weights, numParams, ridgeLambda) {
  const XtWX = zeroMatrix(numParams, numParams);
  const XtWy = new Array(numParams).fill(0);

  for (let i = 0; i < rows.length; i++) {
    const x = rows[i];
    const w = weights[i];
    const y = targets[i];
    for (let a = 0; a < numParams; a++) {
      XtWy[a] += w * x[a] * y;
      for (let b = 0; b < numParams; b++) {
        XtWX[a][b] += w * x[a] * x[b];
      }
    }
  }
  for (let a = 0; a < numParams; a++) XtWX[a][a] += ridgeLambda;

  const inv = invertMatrix(XtWX, 0);
  return matVecMul(inv, XtWy);
}

class BrightnessManager extends EventEmitter {
  #stats = new Map();
  #featureKeys = ALL_FEATURES;
  #numericKeys = NUMERIC_FEATURES;
  #timeDecayRate = Math.log(2) / CONFIG.ALGORITHM.TIME_DECAY_HALF_LIFE_DAYS;
  #intervals = new Map();
  #isGettingBrightness = false;
  #isDirty = false;
  #relationshipFeatures = [];
  #relationshipPrecision = null;
  #relSetCache = null;
  #interactionPair = null;
  #lastLoggedInteractionPair = null;
  #lastPowerSource = null;
  #lastBatteryLevel = null;
  #lastNightLight = null;
  #deviceProfile = null;
  #lightMode = false;
  #clearResetCyclePending = false;
  #noiseStats = new Map();
  #cycleDurations = [];
  #faceCheckCounter = 0;
  #cachedFaceData = null;
  #slowSignalsLastRead = 0;
  #cachedPowerInfo = null;
  #cachedNightLight = null;
  #ambientReadingsInFlight = null;
  #lastAmbientState = null;
  #lastAmbientStateAt = 0;
  #deferredFirstCycle = null;
  #adjustingResetTimer = null;

  constructor(initialSettings) {
    super();
    this.settings = initialSettings;
    this.logs = [];
    this.weatherInfo = {};
    this.featureImportance = {};
    this.displayImportance = {};
    this.#initializeStats();

    this.learningConfig = {
      learningMode: true,
      startTime: Date.now(),
    };

    this.lastKnownBrightness = null;
    this.manualOverrideUntil = 0;
    this.isAdjusting = false;

    this.ambientLightSensorAvailable = false;
    this.#deviceProfile = detectDeviceProfile();
  }

  #initializeStats() {
    this.#stats.clear();
    for (let i = 0; i < this.#numericKeys.length; i++) {
      const feature = this.#numericKeys[i];
      this.#stats.set(feature, { sum: 0, sumSq: 0, count: 0, mean: 0, std: 1 });
      this.featureImportance[feature] = 1.0;
      this.displayImportance[feature] = 0;
    }
    for (let i = 0; i < CATEGORICAL_FEATURES.length; i++) {
      this.featureImportance[CATEGORICAL_FEATURES[i]] = 1.0;
      this.displayImportance[CATEGORICAL_FEATURES[i]] = 0;
    }
  }

  #applyLogScale(value) {
    if (value == null || !Number.isFinite(value)) return null;
    if (value < 0) return 0;
    return Math.round(Math.log10(value + 1) * 1e5) / 1e5;
  }

  #weightedMedian(valuesWithWeights) {
    const len = valuesWithWeights.length;
    if (len === 0) return null;
    valuesWithWeights.sort((a, b) => a.value - b.value);
    let totalWeight = 0;
    for (let i = 0; i < len; i++) totalWeight += valuesWithWeights[i].weight;
    if (totalWeight === 0) return valuesWithWeights[0]?.value ?? null;
    let cumulative = 0;
    const target = totalWeight / 2;
    for (let i = 0; i < len; i++) {
      cumulative += valuesWithWeights[i].weight;
      if (cumulative >= target) return valuesWithWeights[i].value;
    }
    return valuesWithWeights[len - 1].value;
  }

  _recalculateFeatureImportance() {
    const logsLen = this.logs.length;
    if (logsLen < 2) return;

    const brightnessValues = new Array(logsLen);
    for (let i = 0; i < logsLen; i++) brightnessValues[i] = this.logs[i].brightness;
    const totalMean = arrayMean(brightnessValues);
    const totalVariance = arrayVar(brightnessValues, totalMean);
    if (totalVariance === 0) return;

    const importance = {};
    const numericFeats = this.#numericKeys;
    const catFeats = CATEGORICAL_FEATURES;
    const logs = this.logs;

    for (let f = 0; f < numericFeats.length; f++) {
      const key = numericFeats[f];
      const featureVals = new Array(logsLen);
      let validCount = 0;
      for (let i = 0; i < logsLen; i++) {
        const val = FEATURE_DEFINITIONS[key].accessor(logs[i]);
        if (val != null && Number.isFinite(val)) {
          featureVals[i] = val;
          validCount++;
        } else {
          featureVals[i] = null;
        }
      }
      if (validCount < 2) {
        importance[key] = 0;
        continue;
      }
      const pairs = [];
      for (let i = 0; i < logsLen; i++) {
        if (featureVals[i] !== null) {
          pairs.push({ v: featureVals[i], b: brightnessValues[i] });
        }
      }
      pairs.sort((a, b) => a.v - b.v);
      const m = pairs.length;

      const prefixSum = new Array(m + 1).fill(0);
      const prefixSumSq = new Array(m + 1).fill(0);
      for (let i = 0; i < m; i++) {
        const b = pairs[i].b;
        prefixSum[i + 1] = prefixSum[i] + b;
        prefixSumSq[i + 1] = prefixSumSq[i] + b * b;
      }
      const totalSum = prefixSum[m];
      const totalSumSq = prefixSumSq[m];

      let bestSplitGain = 0;
      for (let i = 1; i < m; i++) {
        if (pairs[i].v === pairs[i - 1].v) continue;
        const leftCount = i;
        const rightCount = m - i;
        if (leftCount < 1 || rightCount < 1) continue;
        const leftSum = prefixSum[i];
        const leftSumSq = prefixSumSq[i];
        const rightSum = totalSum - leftSum;
        const rightSumSq = totalSumSq - leftSumSq;

        const leftMean = leftSum / leftCount;
        const rightMean = rightSum / rightCount;
        const leftVar = Math.max(0, leftSumSq / leftCount - leftMean * leftMean);
        const rightVar = Math.max(0, rightSumSq / rightCount - rightMean * rightMean);

        const wLeft = leftCount / m;
        const wRight = rightCount / m;
        const splitGain = totalVariance - (wLeft * leftVar + wRight * rightVar);
        if (splitGain > bestSplitGain) bestSplitGain = splitGain;
      }
      importance[key] = bestSplitGain;
    }

    for (let f = 0; f < catFeats.length; f++) {
      const key = catFeats[f];
      const groups = new Map();
      for (let i = 0; i < logsLen; i++) {
        const cat = FEATURE_DEFINITIONS[key].accessor(logs[i]) ?? 'unknown';
        const list = groups.get(cat);
        if (list) list.push(brightnessValues[i]);
        else groups.set(cat, [brightnessValues[i]]);
      }
      let weightedWithinVar = 0;
      for (const vals of groups.values()) {
        const w = vals.length / logsLen;
        const mean = arrayMean(vals);
        weightedWithinVar += w * arrayVar(vals, mean);
      }
      importance[key] = totalVariance - weightedWithinVar;
    }

    let maxGain = 0;
    for (const key in importance) if (importance[key] > maxGain) maxGain = importance[key];
    if (maxGain < 0.001) maxGain = 0.001;
    for (const key in importance) {
      const norm = Math.min(1.0, importance[key] / maxGain);
      this.displayImportance[key] = Math.round(norm * 1e5) / 1e5;
      const floored = importance[key] > 0 ? Math.max(0.1, norm) : 0;
      this.featureImportance[key] = FEATURE_DEFINITIONS[key].type === 'categorical'
        ? Math.min(1.0, floored * 1.2 || floored)
        : floored;
    }

    this.#recalculateFeatureRelationships(importance, brightnessValues, totalVariance);
  }

  #recalculateFeatureRelationships(rawImportance, brightnessValues, totalVariance) {
    const cfg = CONFIG.ALGORITHM;
    const logs = this.logs;
    const logsLen = logs.length;

    this.#relationshipFeatures = [];
    this.#relationshipPrecision = null;
    this.#interactionPair = null;

    if (logsLen < cfg.MIN_LOGS_FOR_RELATIONSHIP) return;

    const ranked = this.#numericKeys
      .filter((key) => (this.featureImportance[key] ?? 0) >= cfg.RELATIONSHIP_MIN_IMPORTANCE)
      .sort((a, b) => (this.featureImportance[b] ?? 0) - (this.featureImportance[a] ?? 0))
      .slice(0, cfg.MAX_RELATIONSHIP_FEATURES);

    if (ranked.length >= 2) {
      const k = ranked.length;
      const sampleMean = new Array(k).fill(0);
      const sampleStd = new Array(k).fill(1);
      const columns = ranked.map((key) => {
        const vals = new Array(logsLen);
        for (let i = 0; i < logsLen; i++) {
          const v = FEATURE_DEFINITIONS[key].accessor(logs[i]);
          vals[i] = (v != null && Number.isFinite(v)) ? v : null;
        }
        return vals;
      });

      for (let f = 0; f < k; f++) {
        const vals = columns[f].filter((v) => v !== null);
        const mean = vals.length ? arrayMean(vals) : 0;
        const variance = vals.length > 1 ? arrayVar(vals, mean) : 1;
        sampleMean[f] = mean;
        sampleStd[f] = Math.sqrt(variance) || 1;
      }

      const Z = new Array(logsLen);
      for (let i = 0; i < logsLen; i++) {
        const row = new Array(k);
        for (let f = 0; f < k; f++) {
          const raw = columns[f][i];
          row[f] = raw === null ? 0 : (raw - sampleMean[f]) / sampleStd[f];
        }
        Z[i] = row;
      }

      const corr = zeroMatrix(k, k);
      for (let a = 0; a < k; a++) {
        for (let b = a; b < k; b++) {
          let sum = 0;
          for (let i = 0; i < logsLen; i++) sum += Z[i][a] * Z[i][b];
          const value = sum / Math.max(1, logsLen - 1);
          corr[a][b] = value;
          corr[b][a] = value;
        }
      }

      const shrinkage = Math.min(0.85, Math.max(cfg.RELATIONSHIP_SHRINKAGE, 1 - (logsLen / 150)));
      const shrunk = zeroMatrix(k, k);
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          shrunk[a][b] = (1 - shrinkage) * corr[a][b] + (a === b ? shrinkage : 0);
        }
      }

      const precisionRaw = invertMatrix(shrunk, 1e-4);
      const weighted = zeroMatrix(k, k);
      for (let a = 0; a < k; a++) {
        const wa = Math.sqrt(this.featureImportance[ranked[a]] ?? 0.1);
        for (let b = 0; b < k; b++) {
          const wb = Math.sqrt(this.featureImportance[ranked[b]] ?? 0.1);
          weighted[a][b] = wa * precisionRaw[a][b] * wb;
        }
      }

      this.#relationshipFeatures = ranked;
      this.#relationshipPrecision = weighted;
      this.#relSetCache = new Set(ranked);
    } else {
      this.#relSetCache = null;
    }

    const interactionCandidates = ranked.slice(0, Math.min(ranked.length, 5));
    let bestPair = null;
    let bestGainValue = 0;
    for (let a = 0; a < interactionCandidates.length; a++) {
      for (let b = a + 1; b < interactionCandidates.length; b++) {
        const featA = interactionCandidates[a];
        const featB = interactionCandidates[b];
        const gain = this.#computeInteractionGain(featA, featB, brightnessValues);
        if (gain > bestGainValue) { bestGainValue = gain; bestPair = [featA, featB]; }
      }
    }
    if (bestPair && totalVariance > 0 && (bestGainValue / totalVariance) > 0.03) {
      this.#interactionPair = bestPair;
    }

    const pairKey = this.#interactionPair ? this.#interactionPair.slice().sort().join('+') : null;
    if (pairKey !== this.#lastLoggedInteractionPair) {
      this.#lastLoggedInteractionPair = pairKey;
      if (this.#interactionPair) {
        this._emitLog('info', `Detected a combined effect between "${this.#interactionPair[0]}" and "${this.#interactionPair[1]}" - factoring their interaction into predictions.`);
      }
    }
  }

  #computeInteractionGain(featA, featB, brightnessValues) {
    const logs = this.logs;
    const n = logs.length;
    const valsA = [];
    const valsB = [];
    const y = [];
    for (let i = 0; i < n; i++) {
      const a = FEATURE_DEFINITIONS[featA].accessor(logs[i]);
      const b = FEATURE_DEFINITIONS[featB].accessor(logs[i]);
      if (a != null && Number.isFinite(a) && b != null && Number.isFinite(b)) {
        valsA.push(a);
        valsB.push(b);
        y.push(brightnessValues[i]);
      }
    }

    const m = y.length;
    if (m < CONFIG.ALGORITHM.MIN_POINTS_FOR_INTERACTION_MODEL) return 0;

    const sortedA = valsA.slice().sort((x, z) => x - z);
    const sortedB = valsB.slice().sort((x, z) => x - z);
    const medianA = sortedA[Math.floor(m / 2)];
    const medianB = sortedB[Math.floor(m / 2)];

    const isHighA = valsA.map((v) => (v > medianA ? 1 : 0));
    const isHighB = valsB.map((v) => (v > medianB ? 1 : 0));

    const grandMean = arrayMean(y);
    const totalVar = arrayVar(y, grandMean);
    if (totalVar <= 0) return 0;

    const quadrants = [[], [], [], []];
    for (let i = 0; i < m; i++) quadrants[isHighA[i] * 2 + isHighB[i]].push(y[i]);
    let saturatedResidual = 0;
    for (const q of quadrants) {
      if (q.length === 0) continue;
      const mean = arrayMean(q);
      for (const v of q) saturatedResidual += (v - mean) * (v - mean);
    }
    const saturatedGain = totalVar - (saturatedResidual / m);

    const rows = new Array(m);
    const weights = new Array(m).fill(1);
    for (let i = 0; i < m; i++) rows[i] = [1, isHighA[i], isHighB[i]];
    const beta = weightedRidgeRegression(rows, y, weights, 3, 0.05);

    let additiveResidual = 0;
    for (let i = 0; i < m; i++) {
      const pred = beta[0] + (beta[1] * isHighA[i]) + (beta[2] * isHighB[i]);
      const diff = y[i] - pred;
      additiveResidual += diff * diff;
    }
    const additiveGain = totalVar - (additiveResidual / m);

    return Math.max(0, saturatedGain - additiveGain);
  }

  #updateStats(log) {
    const alpha = CONFIG.ALGORITHM.STATS_DECAY_ALPHA;
    const numericFeats = this.#numericKeys;
    const statsMap = this.#stats;
    for (let i = 0; i < numericFeats.length; i++) {
      const key = numericFeats[i];
      const value = FEATURE_DEFINITIONS[key].accessor(log);
      if (value != null && Number.isFinite(value)) {
        const stat = statsMap.get(key);
        if (stat.count === 0) {
          stat.mean = value;
          stat.std = 1;
          stat.count = 1;
        } else {
          const delta = value - stat.mean;
          stat.mean += alpha * delta;
          const variance = stat.std * stat.std;
          const newVariance = (1 - alpha) * (variance + alpha * delta * delta);
          stat.std = Math.sqrt(newVariance);
          stat.count++;
        }
      }
    }
  }

  async _runAutoAdjustmentCycle(isTriggeredRun = false) {
    const now = Date.now();
    if (this.manualOverrideUntil && now < this.manualOverrideUntil) return;
    if (this.#clearResetCyclePending) return;
    this.manualOverrideUntil = 0;
    this.#clearResetCyclePending = false;
    if (!this.settings.autoEnabled) return;
    if (this.learningConfig.learningMode && this.settings.adjustDuringLearning === false) {
      this._emitLog('info', 'Learning phase active with adjustments disabled – skipping cycle.');
      return;
    }
    if (isTriggeredRun) this._resetAdjustmentInterval();

    const cycleStart = Date.now();
    try {
      this.emit('adjustment');

      const ambientState = await this._getAmbientReadings();
      if (!ambientState) return;
      this.emit('readingsUpdated');

      const confidence = this._computeAutomationConfidence();

      const candidateLogs = this.logs;

      let sortedByDistance = [];
      if (candidateLogs.length > 0) {
        const statSnapshot = {};
        const numericFeats = this.#numericKeys;
        const statsMap = this.#stats;
        for (let i = 0; i < numericFeats.length; i++) {
          const key = numericFeats[i];
          statSnapshot[key] = statsMap.get(key);
        }

        const relCtx = this._buildRelationshipContext(ambientState, statSnapshot);

        sortedByDistance = candidateLogs
          .map((log, index) => ({ index, distance: this._computeDistanceFast(log, ambientState, statSnapshot, relCtx), log }))
          .sort((a, b) => a.distance - b.distance);
      }

      const fallback = this._getFallbackBrightness(ambientState, sortedByDistance);

      let suggestion = fallback;

      if (candidateLogs.length >= CONFIG.ALGORITHM.MIN_LOGS_FOR_PREDICTION) {
        const topEntries = this._getTopLogs(sortedByDistance);
        const learned = topEntries.length > 0 ? this._computeWeightedMedianPrediction(topEntries, ambientState) : null;

        if (learned !== null && Number.isFinite(learned)) {
          suggestion = (confidence * learned) + ((1 - confidence) * fallback);
          suggestion = Math.min(100, Math.max(0, suggestion));
        }
      } else {
        this._emitLog('info', `Only ${candidateLogs.length} log(s) so far - using ambient/time-based estimate.`);
      }

      if (suggestion !== null && Number.isFinite(suggestion)) {
        await this._applyBrightnessWithHysteresis(suggestion, confidence);
      }

      this._updateLearningPhase(confidence);
    } finally {
      this.#recordCycleDuration(Date.now() - cycleStart);
    }
  }

  #recordCycleDuration(durationMs) {
    const ring = this.#cycleDurations;
    ring.push(durationMs);
    if (ring.length > 5) ring.shift();
    const intervalMs = this.settings.autoBrightMin * ONE_MIN_MS;
    if (intervalMs <= 0) return;
    const avgMs = ring.reduce((a, b) => a + b, 0) / ring.length;
    const overloaded = avgMs > intervalMs * CONFIG.ALGORITHM.OVERLOAD_CYCLE_RATIO;
    this.#updateLightMode(this.#deviceProfile?.weak === true || overloaded);
  }

  #updateLightMode(enabled) {
    if (enabled === this.#lightMode) return;
    this.#lightMode = enabled;
    this.#faceCheckCounter = 0;
    this.#slowSignalsLastRead = 0;
    this._emitLog(
      enabled ? 'warn' : 'info',
      enabled
        ? 'Low-power mode enabled: face detection and slow sensor reads are throttled to keep the app responsive.'
        : 'Low-power mode disabled: full-quality signal sampling resumed.'
    );
  }

  _computeAutomationConfidence() {
    const cfg = CONFIG.ALGORITHM;
    const logsLen = this.logs.length;

    const quantitySignal = 1 - Math.exp(-logsLen / cfg.CONFIDENCE_LOG_SATURATION);

    const daysSinceStart = (Date.now() - this.learningConfig.startTime) / ONE_DAY_MS;
    const timeSignal = Math.min(1, daysSinceStart / Math.max(1, this.settings.learningDays));

    let diversitySignal = 0;
    if (logsLen >= 2) {
      const topDiversityFeatures = this.#numericKeys
        .filter((key) => (this.featureImportance[key] ?? 0) >= cfg.RELATIONSHIP_MIN_IMPORTANCE)
        .sort((a, b) => (this.featureImportance[b] ?? 0) - (this.featureImportance[a] ?? 0))
        .slice(0, 3);
      const featuresToCheck = topDiversityFeatures.length > 0 ? topDiversityFeatures : ['dayLight'];

      let signalSum = 0;
      let signalCount = 0;
      for (const key of featuresToCheck) {
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < logsLen; i++) {
          const v = FEATURE_DEFINITIONS[key].accessor(this.logs[i]);
          if (typeof v === 'number' && Number.isFinite(v)) {
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }
        if (max === -Infinity) continue;
        const range = max - min;
        const stat = this.#stats.get(key);
        const targetRange = key === 'dayLight'
          ? cfg.DIVERSITY_TARGET_RANGE
          : Math.max(1e-3, (stat?.std ?? 1) * 1.5);
        signalSum += Math.min(1, range / targetRange);
        signalCount++;
      }
      diversitySignal = signalCount > 0 ? signalSum / signalCount : 0;
    }

    let sensorSignal = 0.3;
    if (this.ambientLightSensorAvailable) sensorSignal = 1.0;
    else if (logsLen > 0) sensorSignal = 0.6;

    const raw =
      quantitySignal * 0.35 +
      timeSignal * 0.15 +
      diversitySignal * 0.2 +
      sensorSignal * 0.3;

    return Math.max(0, Math.min(1, raw));
  }

  _computeWeightedMedianPrediction(topEntries, ambientState = null) {
    const now = Date.now();
    const cfg = CONFIG.ALGORITHM;
    const recencyThresholdMs = cfg.RECENCY_WINDOW_MINUTES * ONE_MIN_MS;
    const eps = cfg.DISTANCE_EPSILON;
    const decayRate = this.#timeDecayRate;
    const recencyBoostFactor = cfg.RECENCY_BOOST_FACTOR;
    const manualConf = cfg.MANUAL_LOG_CONFIDENCE;

    const brightnessValues = topEntries.map((e) => e.log.brightness).sort((a, b) => a - b);
    const medianB = brightnessValues[Math.floor(brightnessValues.length / 2)];
    const absDeviations = brightnessValues.map((v) => Math.abs(v - medianB)).sort((a, b) => a - b);
    const mad = absDeviations[Math.floor(absDeviations.length / 2)] || 0;

    const weightedValues = [];
    const weights = [];
    for (let i = 0; i < topEntries.length; i++) {
      const { log, distance } = topEntries[i];
      const distanceWeight = 1 / (distance + eps);
      const ageInMs = now - log.timestamp_ts;
      const ageInDays = ageInMs / ONE_DAY_MS;
      const timeDecayWeight = Math.exp(-decayRate * ageInDays);
      const recencyBoost = ageInMs < recencyThresholdMs ? recencyBoostFactor : 1.0;

      let outlierWeight = 1.0;
      if (mad > 0) {
        const deviation = Math.abs(log.brightness - medianB) / mad;
        if (deviation > cfg.OUTLIER_MAD_MULTIPLIER) {
          outlierWeight = cfg.OUTLIER_MAD_MULTIPLIER / deviation;
        }
      }

      const weight = distanceWeight * timeDecayWeight * manualConf * recencyBoost * outlierWeight;
      weightedValues.push({ value: log.brightness, weight });
      weights.push(weight);
    }

    const medianPrediction = this.#weightedMedian(weightedValues);
    if (medianPrediction === null) return null;

    const rawRegression = ambientState
      ? this.#computeInteractionRegressionPrediction(topEntries, weights, ambientState)
      : null;
    if (rawRegression === null) return medianPrediction;

    const regressionPrediction = Math.min(100, Math.max(0, rawRegression));
    const regressionTrust = Math.min(0.6, Math.max(0, (topEntries.length - cfg.MIN_POINTS_FOR_INTERACTION_MODEL) / 20));
    return (regressionTrust * regressionPrediction) + ((1 - regressionTrust) * medianPrediction);
  }

  #computeInteractionRegressionPrediction(topEntries, weights, ambientState) {
    const pair = this.#interactionPair;
    if (!pair || topEntries.length < CONFIG.ALGORITHM.MIN_POINTS_FOR_INTERACTION_MODEL) return null;

    const [featA, featB] = pair;
    const defA = FEATURE_DEFINITIONS[featA];
    const defB = FEATURE_DEFINITIONS[featB];

    const ambA = defA.accessor(ambientState);
    const ambB = defB.accessor(ambientState);
    if (ambA == null || ambB == null || !Number.isFinite(ambA) || !Number.isFinite(ambB)) return null;

    const rows = [];
    const targets = [];
    const rowWeights = [];
    for (let i = 0; i < topEntries.length; i++) {
      const log = topEntries[i].log;
      const a = defA.accessor(log);
      const b = defB.accessor(log);
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      rows.push([1, a, b, a * b]);
      targets.push(log.brightness);
      rowWeights.push(weights[i]);
    }

    if (rows.length < CONFIG.ALGORITHM.MIN_POINTS_FOR_INTERACTION_MODEL) return null;

    const beta = weightedRidgeRegression(rows, targets, rowWeights, 4, CONFIG.ALGORITHM.REGRESSION_RIDGE_LAMBDA);
    if (beta.some((v) => !Number.isFinite(v))) return null;

    const prediction = beta[0] + (beta[1] * ambA) + (beta[2] * ambB) + (beta[3] * ambA * ambB);
    return Number.isFinite(prediction) ? prediction : null;
  }

  async _applyBrightnessWithHysteresis(proposed, confidence = 1) {
    const current = this.lastKnownBrightness;
    if (current === null) {
      return await this._applyBrightness(proposed);
    }
    const cfg = CONFIG.ALGORITHM;
    const diff = proposed - current;

    const confidenceMultiplier = 1 + (1 - confidence) * (cfg.MAX_HYSTERESIS_MULTIPLIER - 1);
    const userHysteresis = Number.isFinite(this.settings.hysteresisPercent) ? this.settings.hysteresisPercent : cfg.HYSTERESIS_BRIGHTEN_THRESHOLD;
    const baseThreshold = diff > 0 ? userHysteresis : userHysteresis * (cfg.HYSTERESIS_DIMMING_THRESHOLD / cfg.HYSTERESIS_BRIGHTEN_THRESHOLD);
    const threshold = baseThreshold * confidenceMultiplier;

    if (Math.abs(diff) < threshold) {
      this._emitLog('info', `Hysteresis: proposed ${proposed.toFixed(1)} (Δ${diff.toFixed(1)}%) below threshold ${threshold.toFixed(1)}% – no change.`);
      return false;
    }

    let target = proposed;
    if (confidence < 0.5 && Math.abs(diff) > cfg.MAX_STEP_LOW_CONFIDENCE) {
      target = current + Math.sign(diff) * cfg.MAX_STEP_LOW_CONFIDENCE;
    }

    return await this._applyBrightness(target);
  }

  async _applyBrightness(value) {
    if (this.isAdjusting) return false;
    const roundedValue = Math.round(value);
    const current = this.lastKnownBrightness;
    if (current !== null && Math.abs(current - roundedValue) < CONFIG.ALGORITHM.MIN_AUTO_CHANGE_THRESHOLD) {
      return false;
    }
    this._emitLog('success', `Adjusting: ${current ?? 'N/A'} -> ${roundedValue}`);
    this.isAdjusting = true;
    try {
      const displayOpts = {
        display: this.settings?.applyToAllDisplays === false
          ? (this.settings?.targetDisplay || undefined)
          : 'all',
      };
      await setSystemBrightness(roundedValue, displayOpts);
      const verified = await this._verifyAppliedBrightness(roundedValue);
      this.lastKnownBrightness = verified === roundedValue ? roundedValue : null;
      return true;
    } catch (error) {
      this._emitLog('error', `Sys write failed: ${error.message}`);
      return false;
    } finally {
      if (this.#adjustingResetTimer) clearTimeout(this.#adjustingResetTimer);
      this.#adjustingResetTimer = setTimeout(() => {
        this.#adjustingResetTimer = null;
        this.isAdjusting = false;
      }, 500);
      if (this.#adjustingResetTimer.unref) this.#adjustingResetTimer.unref();
    }
  }

  async _verifyAppliedBrightness(target, attempts = 3, gapMs = 700) {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      let readBack = null;
      try {
        readBack = await getSystemBrightness();
      } catch {
        readBack = null;
      }
      if (readBack !== null && readBack === target) return readBack;
    }
    return null;
  }

  _sanitizeLogEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const ts = new Date(entry.timestamp).getTime();
    if (isNaN(ts)) return null;
    const parse = (val) => (val != null && Number.isFinite(Number(val)) ? Number(val) : null);
    const featuresExist = entry.timeFeatures && typeof entry.timeFeatures.dayLight === 'number';

    let webScore;
    if (entry.webcamScore !== undefined) {
      webScore = parse(entry.webcamScore);
    } else if (typeof entry.webcam === 'number') {
      webScore = this.#applyLogScale(entry.webcam);
    } else {
      webScore = null;
    }

    const screenVal = parse(entry.screen ?? entry.screenBrightness);
    const screenClean = screenVal == null ? null : Math.round(screenVal * 1e5) / 1e5;
    const cloudVal = parse(entry.cloud);
    const ambientLightVal = parse(entry.ambientLight);

    return {
      timestamp: entry.timestamp,
      timestamp_ts: ts,
      brightness: parse(entry.brightness),
      type: entry.type ?? 'unknown',
      webcamScore: webScore == null ? null : Math.round(webScore * 1e5) / 1e5,
      screen: screenClean,
      cloud: cloudVal,
      ambientLight: ambientLightVal,
      ambientLightLuxRaw: parse(entry.ambientLightLuxRaw),
      ambientLightSource: ['sensor', 'webcam', 'none'].includes(entry.ambientLightSource) ? entry.ambientLightSource : 'none',
      ambientLightDetail: typeof entry.ambientLightDetail === 'string' ? entry.ambientLightDetail : null,
      faceCount: parse(entry.faceCount) ?? 0,
      faceBrightness: parse(entry.faceBrightness),
      faceProximity: parse(entry.faceProximity) ?? 0,
      faceCenterDeviation: parse(entry.faceCenterDeviation) ?? 0,
      lightSourceCount: parse(entry.lightSourceCount) ?? 0,
      lightDirection: entry.lightDirection ?? 'Balanced',
      visualConfidence: parse(entry.visualConfidence),
      app: entry.app ?? entry.currentWindow ?? null,
      powerSource: ['AC', 'battery', 'unknown'].includes(entry.powerSource) ? entry.powerSource : 'unknown',
      batteryLevel: (rawBatteryLevel => rawBatteryLevel == null ? null : rawBatteryLevel > 1 ? batteryScarcity(rawBatteryLevel) : rawBatteryLevel)(parse(entry.batteryLevel)),
      nightLight: entry.nightLight === 'on' || entry.nightLight === 'off' ? entry.nightLight
        : (entry.nightLight === true ? 'on' : entry.nightLight === false ? 'off' : 'unknown'),
      timeFeatures: featuresExist ? entry.timeFeatures : this._getTimeFeatures(ts),
    };
  }

  async _getAmbientReadings() {
    if (this.#ambientReadingsInFlight) return this.#ambientReadingsInFlight;

    this.#faceCheckCounter = (this.#faceCheckCounter + 1) % CONFIG.ALGORITHM.FACE_CHECK_INTERVAL_LIGHT;
    const detectFaces = !this.#lightMode || this.#faceCheckCounter === 0;

    const now = Date.now();
    const readSlowSignals = !this.#lightMode || (now - this.#slowSignalsLastRead) >= CONFIG.ALGORITHM.SLOW_SIGNAL_INTERVAL_MS;
    if (readSlowSignals) this.#slowSignalsLastRead = now;

    this.#ambientReadingsInFlight = (async () => {
      try {
        const state = await this.#collectAmbientReadings(detectFaces, readSlowSignals);
        this.#lastAmbientState = state ? JSON.parse(JSON.stringify(state)) : null;
        this.#lastAmbientStateAt = Date.now();
        return state;
      } finally {
        this.#ambientReadingsInFlight = null;
      }
    })();
    return this.#ambientReadingsInFlight;
  }

  _getReusableAmbientState() {
    const cached = this.#lastAmbientState;
    if (!cached) return null;
    if (Date.now() - this.#lastAmbientStateAt > CONFIG.ALGORITHM.MANUAL_LOG_REUSE_WINDOW_MS) return null;
    const reuse = JSON.parse(JSON.stringify(cached));
    reuse.timeFeatures = this._getTimeFeatures(Date.now());
    return reuse;
  }

  async #collectAmbientReadings(detectFaces, readSlowSignals) {
    let webcamResult = null;
    try {
      webcamResult = await getWebCamBrightness({ detectFaces, device: this.settings?.cameraDevice || undefined });
    } catch {
      webcamResult = null;
    }

    const [screenOutcome, appOutcome, alsOutcome, powerOutcome, nightLightOutcome] = await Promise.allSettled([
      screenAvgBrightness(),
      getCurrentWindow(),
      this.ambientLightSensorAvailable ? readAmbientLightLux() : Promise.resolve(null),
      readSlowSignals ? getPowerStatus() : Promise.resolve(this.#cachedPowerInfo),
      readSlowSignals ? getNightLightState() : Promise.resolve(this.#cachedNightLight),
    ]);

    const screen = screenOutcome.status === 'fulfilled' ? screenOutcome.value : null;
    const app = appOutcome.status === 'fulfilled' ? appOutcome.value : null;
    let ambientLightLuxRaw = alsOutcome.status === 'fulfilled' ? alsOutcome.value : null;
    const powerInfo = powerOutcome.status === 'fulfilled' ? powerOutcome.value : null;
    const nightLightOn = nightLightOutcome.status === 'fulfilled' ? nightLightOutcome.value : null;
    const validWebcam = webcamResult && !webcamResult.error;

    let ambientLightSource = ambientLightLuxRaw !== null && ambientLightLuxRaw !== undefined ? 'sensor' : 'none';
    let ambientLightDetail = null;
    const faceDetected = validWebcam && webcamResult?.faces && webcamResult.faces.detected === true;
    const faceMeanForLux = validWebcam && webcamResult?.faces && typeof webcamResult.faces.faceBrightness === 'number'
      ? webcamResult.faces.faceBrightness
      : null;
    const statsData = validWebcam ? webcamResult.stats : null;
    const effectiveExposure = (statsData && typeof statsData.exposure === 'number')
      ? statsData.exposure
        + (typeof statsData.clippedWhitesPct === 'number' ? statsData.clippedWhitesPct : 0) * 0.6
        - (typeof statsData.crushedBlacksPct === 'number' ? statsData.crushedBlacksPct : 0) * 0.8
      : null;
    if (ambientLightLuxRaw == null) {
      if (faceDetected && faceMeanForLux !== null) {
        ambientLightLuxRaw = faceLuxEstimate(Math.max(20, Math.min(160, faceMeanForLux)));
        ambientLightDetail = 'face';
      } else if (Number.isFinite(effectiveExposure)) {
        ambientLightLuxRaw = faceLuxEstimate(Math.max(20, Math.min(160, effectiveExposure)));
        ambientLightDetail = 'scene';
      }
      if (ambientLightLuxRaw !== null) ambientLightSource = 'webcam';
    }
    if (readSlowSignals) {
      this.#cachedPowerInfo = powerInfo;
      this.#cachedNightLight = nightLightOn;
    }
    if (powerInfo) {
      this.#lastPowerSource = powerInfo.onBattery !== null ? (powerInfo.onBattery ? 'battery' : 'AC') : null;
      this.#lastBatteryLevel = powerInfo.batteryPercent ?? null;
    }
    this.#lastNightLight = (nightLightOn === true || nightLightOn === false) ? (nightLightOn ? 'on' : 'off') : null;

    if (!validWebcam && screen === null && app === null && ambientLightLuxRaw === null) {
      this._emitLog('warn', 'No camera, screen, ambient-light, or window signal available this cycle; falling back to time-of-day / weather estimate.');
    }

    let screenVal = screen;
    let cloudVal = this.weatherInfo?.cloud ?? null;
    let webcamScore = null;
    screenVal = this.#applyLogScale(screenVal);
    cloudVal = this.#applyLogScale(cloudVal);
    const ambientLightVal = this.#applyLogScale(ambientLightLuxRaw);

    let faceData = validWebcam ? webcamResult.faces : null;
    const lightingData = validWebcam ? webcamResult.lighting : null;

    if (statsData && typeof statsData.exposure === 'number') {
      const crushed = typeof statsData.crushedBlacksPct === 'number' ? statsData.crushedBlacksPct : 0;
      const clipped = typeof statsData.clippedWhitesPct === 'number' ? statsData.clippedWhitesPct : 0;
      webcamScore = this.#applyLogScale(Math.max(1, statsData.exposure + clipped * 0.6 - crushed * 0.8));
    }

    if (faceData && faceData.detected) {
      this.#cachedFaceData = faceData;
    } else if (validWebcam && !detectFaces && this.#cachedFaceData) {
      faceData = this.#cachedFaceData;
    } else if (validWebcam && detectFaces) {
      this.#cachedFaceData = null;
    }

    let faceBrightness = null;
    let faceProximity = null;
    let faceCenterDeviation = null;
    let faceCount = null;
    if (faceData && faceData.detected) {
      faceCount = faceData.count;
      if (typeof faceData.faceBrightness === 'number') faceBrightness = faceData.faceBrightness;
      const primaryFace = faceData.positions?.[0];
      const frameW = typeof webcamResult.frameWidth === 'number' ? webcamResult.frameWidth : null;
      const frameArea = typeof webcamResult.frameWidth === 'number' && typeof webcamResult.frameHeight === 'number'
        ? webcamResult.frameWidth * webcamResult.frameHeight
        : null;
      if (primaryFace) {
        const faceArea = primaryFace.width * primaryFace.height;
        faceProximity = frameArea ? Math.round((faceArea / frameArea) * 1000) : Math.round(faceArea / 1000);
        faceCenterDeviation = frameW
          ? Math.round(Math.abs((primaryFace.x + (primaryFace.width / 2)) - frameW / 2) / frameW * 640)
          : Math.round(Math.abs((primaryFace.x + (primaryFace.width / 2)) - 320));
      }
    } else if (validWebcam) {
      faceCount = 0; faceProximity = 0; faceCenterDeviation = 0;
    }

    let visualConfidence = null;
    if (validWebcam && typeof webcamResult.score === 'number') {
      visualConfidence = webcamResult.score;
    } else if (validWebcam && statsData) {
      const { exposure, noise, sharpness } = statsData;
      visualConfidence = Math.max(0, exposure - noise + Math.round(sharpness / 20));
    }

    return {
      webcamScore,
      faceCount,
      faceBrightness,
      faceProximity,
      faceCenterDeviation,
      lightSourceCount: lightingData?.sourceCount ?? null,
      lightDirection: lightingData?.direction ?? null,
      lightDirectionDetail: lightingData?.directionDetail ?? null,
      visualConfidence,
      screen: screenVal,
      app,
      cloud: cloudVal,
      ambientLight: ambientLightVal,
      ambientLightLuxRaw,
      ambientLightSource,
      ambientLightDetail,
      powerSource: powerInfo && powerInfo.onBattery !== null ? (powerInfo.onBattery ? 'battery' : 'AC') : 'unknown',
      batteryLevel: batteryScarcity(powerInfo?.batteryPercent ?? null),
      nightLight: nightLightOn === null || nightLightOn === undefined ? 'unknown' : (nightLightOn ? 'on' : 'off'),
      timeFeatures: this._getTimeFeatures(Date.now()),
    };
  }

  async initialize() {
    this._emitLog('info', 'Initializing Brightness Manager...');
    await this._loadState();
    this._updateLearningPhase();

    const [sysBrightness, alsAvailable] = await Promise.all([
      this._readStableBrightness(),
      hasAmbientLightSensor(),
    ]);
    this.lastKnownBrightness = sysBrightness;
    this.ambientLightSensorAvailable = alsAvailable;
    this._emitLog('info', `Ambient light sensor: ${alsAvailable ? 'detected' : 'not detected'}.`);

    if (this.settings.autoEnabled) this.start();
    const status = this.settings.autoEnabled ? 'ENABLED' : 'DISABLED';
    this._emitLog('info', `Initialization complete. Auto-adjustment is ${status}.`);
  }

  async _readStableBrightness(samples = 2, gapMs = 500) {
    let first = null;
    try {
      first = await this._getSystemBrightness();
    } catch {
      first = null;
    }
    if (first === null) return null;
    for (let i = 1; i < samples; i++) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      let next = null;
      try {
        next = await this._getSystemBrightness();
      } catch {
        next = null;
      }
      if (next === null || next !== first) return null;
    }
    return first;
  }

  start(deferFirstCycleMs = 0) {
    this.shutdown();
    this.#setInterval('adjustment', () => this._runAutoAdjustmentCycle(), this.settings.autoBrightMin * ONE_MIN_MS);
    this.#setInterval('polling', () => this._pollSystemState(), Math.max(CONFIG.ALGORITHM.POLL_INTERVAL_FLOOR_SEC, this.settings.pollIntervalSec) * 1000);
    this.#setInterval('sync', () => this._saveState(), this.settings.logSyncMin * ONE_MIN_MS);
    if (deferFirstCycleMs > 0) {
      const id = setTimeout(() => {
        this.#deferredFirstCycle = null;
        if (this.#intervals.has('adjustment')) this._runAutoAdjustmentCycle();
      }, deferFirstCycleMs);
      if (id.unref) id.unref();
      this.#deferredFirstCycle = id;
    } else {
      this._runAutoAdjustmentCycle();
    }
    this._emitLog('info', `Core loops started. Adjustment: ${this.settings.autoBrightMin}min, Polling: ${Math.max(CONFIG.ALGORITHM.POLL_INTERVAL_FLOOR_SEC, this.settings.pollIntervalSec)}s.`);
  }

  shutdown() {
    for (const id of this.#intervals.values()) clearInterval(id);
    this.#intervals.clear();
    if (this.#deferredFirstCycle) {
      clearTimeout(this.#deferredFirstCycle);
      this.#deferredFirstCycle = null;
    }
    if (this.#adjustingResetTimer) {
      clearTimeout(this.#adjustingResetTimer);
      this.#adjustingResetTimer = null;
      this.isAdjusting = false;
    }
    this._emitLog('info', 'Core loops stopped.');
  }

  async updateSettings(newSettings) {
    const needsRestart =
      this.settings.autoEnabled !== newSettings.autoEnabled ||
      this.settings.autoBrightMin !== newSettings.autoBrightMin ||
      this.settings.pollIntervalSec !== newSettings.pollIntervalSec ||
      this.settings.logSyncMin !== newSettings.logSyncMin;
    const learningDaysChanged = this.settings.learningDays !== newSettings.learningDays;
    this.settings = newSettings;
    this._emitLog('info', 'Settings updated.');
    if (learningDaysChanged && this.learningConfig.learningMode) {
      this.learningConfig.startTime = Date.now();
      this.#isDirty = true;
    }
    if (needsRestart) {
      this.shutdown();
    if (this.settings.autoEnabled) this.start(8000);
    }
  }

  updateWeatherInfo(weatherData) {
    this.weatherInfo = weatherData ?? {};
    if (this.weatherInfo.sunrise && !(this.weatherInfo.sunrise instanceof Date)) {
      this.weatherInfo.sunrise = new Date(this.weatherInfo.sunrise);
    }
    if (this.weatherInfo.sunset && !(this.weatherInfo.sunset instanceof Date)) {
      this.weatherInfo.sunset = new Date(this.weatherInfo.sunset);
    }
  }

  getCurrentStatus() {
    const confidence = this._computeAutomationConfidence();
    this._updateLearningPhase(confidence);
    return {
      currentBrightness: this.lastKnownBrightness,
      learningPhase: this._getLearningPhase(),
      logCount: this.logs.length,
      isLearningComplete: !this.learningConfig.learningMode,
      automationConfidence: Math.round(confidence * 100),
      currentWeights: this.displayImportance,
      relationshipFeatures: [...this.#relationshipFeatures],
      interactionPair: this.#interactionPair ? [...this.#interactionPair] : null,
      manualOverrideUntil: this.manualOverrideUntil || null,
      ambientLightSensorAvailable: this.ambientLightSensorAvailable,
      lastPowerSource: this.#lastPowerSource,
      lastBatteryLevel: this.#lastBatteryLevel,
      lastNightLight: this.#lastNightLight,
      lightMode: this.#lightMode,
      deviceWeak: this.#deviceProfile?.weak === true,
    };
  }

  _buildRelationshipContext(ambientState, statSnapshot) {
    const relFeatures = this.#relationshipFeatures;
    const relPrecision = this.#relationshipPrecision;
    if (!relFeatures.length || !relPrecision) return null;

    const idxMap = [];
    const ambientVec = [];
    for (let i = 0; i < relFeatures.length; i++) {
      const key = relFeatures[i];
      const stat = statSnapshot[key];
      if (!stat || stat.count < CONFIG.ALGORITHM.MIN_STAT_COUNT_FOR_DISTANCE) continue;
      const ambientVal = FEATURE_DEFINITIONS[key].accessor(ambientState);
      if (ambientVal == null) continue;
      const std = stat.std < 1e-6 ? 1e-6 : stat.std;
      idxMap.push(i);
      ambientVec.push((ambientVal - stat.mean) / std);
    }

    if (idxMap.length === 0) return null;

    let subPrecision = null;
    if (idxMap.length === relFeatures.length) {
      subPrecision = relPrecision;
    } else {
      const n = idxMap.length;
      subPrecision = zeroMatrix(n, n);
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          subPrecision[a][b] = relPrecision[idxMap[a]][idxMap[b]];
        }
      }
    }

    return { positions: idxMap, ambientZ: ambientVec, subPrecision };
  }

  _computeDistanceFast(log, ambientState, statSnapshot, relCtx = undefined) {
    let sumSq = 0;
    const numericFeats = this.#numericKeys;
    const catFeats = CATEGORICAL_FEATURES;
    const importance = this.featureImportance;

    if (relCtx === undefined) {
      relCtx = this._buildRelationshipContext(ambientState, statSnapshot);
    }

    if (relCtx) {
      const relFeatures = this.#relationshipFeatures;
      const { positions, ambientZ, subPrecision } = relCtx;
      const dv = [];
      const pi = [];
      for (let i = 0; i < positions.length; i++) {
        const key = relFeatures[positions[i]];
        const stat = statSnapshot[key];
        const logVal = FEATURE_DEFINITIONS[key].accessor(log);
        if (logVal == null) continue;
        const std = stat.std < 1e-6 ? 1e-6 : stat.std;
        dv.push(((logVal - stat.mean) / std) - ambientZ[i]);
        pi.push(i);
      }
      if (dv.length > 0) {
        let q = 0;
        for (let a = 0; a < dv.length; a++) {
          let row = 0;
          for (let b = 0; b < dv.length; b++) row += subPrecision[pi[a]][pi[b]] * dv[b];
          q += dv[a] * row;
        }
        sumSq += q;
      }
    }

    const inRelModel = this.#relationshipFeatures.length > 0 && this.#relationshipPrecision && this.#relSetCache;
    for (let i = 0; i < numericFeats.length; i++) {
      const key = numericFeats[i];
      if (inRelModel && this.#relSetCache.has(key)) continue;
      const weight = importance[key] ?? 0.1;
      if (weight < 0.05) continue;
      const stat = statSnapshot[key];
      if (!stat || stat.count < CONFIG.ALGORITHM.MIN_STAT_COUNT_FOR_DISTANCE) continue;
      const logVal = FEATURE_DEFINITIONS[key].accessor(log);
      const ambientVal = FEATURE_DEFINITIONS[key].accessor(ambientState);
      if (logVal == null || ambientVal == null) continue;
      const std = stat.std < 1e-6 ? 1e-6 : stat.std;
      const diff = ((logVal - ambientVal) / std);
      sumSq += weight * (diff * diff);
    }

    for (let i = 0; i < catFeats.length; i++) {
      const key = catFeats[i];
      const weight = importance[key] ?? 0.1;
      if (weight < 0.05) continue;
      const logVal = FEATURE_DEFINITIONS[key].accessor(log);
      const ambientVal = FEATURE_DEFINITIONS[key].accessor(ambientState);
      if (logVal == null || ambientVal == null) continue;
      if (logVal !== ambientVal) sumSq += weight;
    }

    return Math.sqrt(sumSq);
  }

  _computeDynamicDistanceThreshold(sortedLogIndices) {
    let sum = 0, sumSq = 0;
    const len = sortedLogIndices.length;
    for (let i = 0; i < len; i++) {
      const d = sortedLogIndices[i].distance;
      sum += d;
      sumSq += d * d;
    }
    const meanDist = sum / len;
    const variance = Math.max(0, sumSq / len - meanDist * meanDist);
    return meanDist + CONFIG.ALGORITHM.RELEVANT_DISTANCE_STD_DEV_THRESHOLD * Math.sqrt(variance);
  }

  _getTopLogs(sortedLogIndices) {
    const len = sortedLogIndices.length;
    if (len === 0) return [];
    const cfg = CONFIG.ALGORITHM;

    const dynamicThreshold = this._computeDynamicDistanceThreshold(sortedLogIndices);

    const relevant = [];
    for (let i = 0; i < len; i++) {
      if (sortedLogIndices[i].distance <= dynamicThreshold) {
        relevant.push(sortedLogIndices[i]);
      }
    }
    if (relevant.length === 0) return [sortedLogIndices[0]];

    const countByPercent = Math.ceil(relevant.length * cfg.TOP_LOGS_PERCENTAGE);
    const finalCount = Math.min(relevant.length, cfg.MAX_TOP_LOGS_COUNT, Math.max(cfg.MIN_TOP_LOGS_FALLBACK, countByPercent));
    return relevant.slice(0, finalCount);
  }

  #getNoiseEpsilon(key) {
    const stats = this.#noiseStats.get(key);
    if (!stats || stats.length < MIN_SAMPLES_FOR_NOISE_ESTIMATE) return FEATURE_NOISE_FLOOR;
    const sorted = stats.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mad = arrayMedian(sorted.map((d) => Math.abs(d - median)));
    const eps = MAD_NOISE_MULTIPLIER * mad;
    return Math.max(FEATURE_NOISE_FLOOR, eps);
  }

  async _logChange(brightness, type, ambientStateOverride = null) {
    const ambientState = ambientStateOverride ?? this._getReusableAmbientState() ?? (await this._getAmbientReadings());
    if (!ambientState) {
      this._emitLog('error', 'Log skipped: Sensor read failed.');
      return;
    }
    const now = Date.now();

    const prev = this.logs.length ? this.logs[this.logs.length - 1] : null;
    const changedFeatures = [];
    if (prev && type === 'manual') {
      for (const key of this.#numericKeys) {
        const cur = FEATURE_DEFINITIONS[key].accessor(ambientState);
        const before = FEATURE_DEFINITIONS[key].accessor(prev);
        if (cur == null || before == null) continue;

        const eps = Math.max(
          this.#getNoiseEpsilon(key),
          Math.abs(before) * 0.02
        );
        const delta = cur - before;
        if (Math.abs(delta) < eps) {
          setFeatureValue(ambientState, key, before);
          continue;
        }

        let deltas = this.#noiseStats.get(key);
        if (!deltas) { deltas = []; this.#noiseStats.set(key, deltas); }
        deltas.push(Math.abs(delta));
        if (deltas.length > 40) deltas.shift();

        changedFeatures.push(key);
      }
    }

    const newLog = {
      timestamp: new Date(now).toISOString(),
      timestamp_ts: now,
      brightness,
      type,
      ...ambientState,
    };
    if (prev && type === 'manual') newLog.changedFeatures = changedFeatures.slice();
    if (this.logs.length >= this.settings.logLimit) this.logs.shift();
    this.logs.push(newLog);
    this.#updateStats(newLog);
    this.#isDirty = true;
    this._recalculateFeatureImportance();
    this._updateLearningPhase();
    this._emitLog('info', `Log added (${type}). Learning updated. Total: ${this.logs.length}`);
  }

  async _loadState() {
    try {
      const [savedConfig, savedLogs] = await Promise.all([
        loadJSON(learningConfigPath, { learningMode: true, startTime: Date.now() }),
        loadJSON(brightnessLogsPath, [])
      ]);
      this.learningConfig = {
        ...savedConfig,
        startTime: new Date(savedConfig.startTime).getTime()
      };
      if (Array.isArray(savedLogs)) {
        this.#initializeStats();
        const cleanLogs = [];
        for (let i = 0; i < savedLogs.length; i++) {
          const clean = this._sanitizeLogEntry(savedLogs[i]);
          if (clean && clean.brightness !== null) {
            cleanLogs.push(clean);
            this.#updateStats(clean);
          }
        }
        this.logs = cleanLogs;
        this._recalculateFeatureImportance();
      }
    } catch (error) {
      this._emitLog('error', `State load failed: ${error.message}`);
    }
  }

  async _saveState() {
    if (!this.#isDirty) return;
    try {
      const logsToSave = new Array(this.logs.length);
      for (let i = 0; i < this.logs.length; i++) {
        const { timestamp_ts, ...rest } = this.logs[i];
        logsToSave[i] = rest;
      }
      const configToSave = {
        ...this.learningConfig,
        startTime: new Date(this.learningConfig.startTime).toISOString()
      };
      await Promise.all([
        saveJSON(learningConfigPath, configToSave),
        saveJSON(brightnessLogsPath, logsToSave)
      ]);
      this.#isDirty = false;
    } catch (error) {
      this._emitLog('error', `Save failed: ${error.message}`);
    }
  }

  #setInterval(name, callback, delay) {
    const existing = this.#intervals.get(name);
    if (existing) clearInterval(existing);
    this.#intervals.set(name, setInterval(callback, delay));
  }

  _resetAdjustmentInterval() {
    this.#setInterval('adjustment', () => this._runAutoAdjustmentCycle(), this.settings.autoBrightMin * ONE_MIN_MS);
    this.emit('timerReset');
  }

  _updateLearningPhase(confidence = this._computeAutomationConfidence()) {
    if (!this.learningConfig.learningMode) return;
    if (confidence >= CONFIG.ALGORITHM.MIN_CONFIDENCE_FOR_FULL_TRUST) {
      this.learningConfig.learningMode = false;
      this.#isDirty = true;
      this._emitLog('success', 'Enough data gathered - automatic adjustment is now fully trusted.');
    }
  }

  _getLearningPhase() {
    if (this.learningConfig.learningMode) return 1;
    return this.logs.length < this.settings.logLimit ? 2 : 3;
  }

  _emitLog(level, message, data = {}) {
    this.emit('log', {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...data,
    });
  }

  async _getSystemBrightness() {
    if (this.#isGettingBrightness) return null;
    this.#isGettingBrightness = true;
    try {
      const brightness = await retry(() => getSystemBrightness(), 2, 200);
      return Number.isInteger(brightness) ? brightness : null;
    } catch (error) {
      this._emitLog('error', `Sys read failed: ${error.message}`);
      return null;
    } finally {
      this.#isGettingBrightness = false;
    }
  }

  async handleShutdown() {
    this._emitLog('info', 'Shutdown...');
    this.shutdown();
    await this._saveState();
  }

  _getTimeFeatures(nowTs) {
    const d = new Date(nowTs);
    const msSinceMidnight = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
    const angle = 2 * Math.PI * (msSinceMidnight / 86400000);
    let { sunrise, sunset } = this.weatherInfo;
    if (!sunrise) { sunrise = new Date(d); sunrise.setHours(6, 0, 0, 0); }
    if (!sunset) { sunset = new Date(d); sunset.setHours(18, 0, 0, 0); }
    const sr = new Date(sunrise);
    sr.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    const ss = new Date(sunset);
    ss.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    const dayLight = BrightnessManager.#calculateDaylight(nowTs, sr, ss);
    return {
      dayLight: parseFloat(dayLight),
      sin: parseFloat(Math.sin(angle)),
      cos: parseFloat(Math.cos(angle)),
    };
  }

  _getFallbackBrightness(ambientState, sortedLogIndices = []) {
    if (sortedLogIndices.length > 0) {
      const cfg = CONFIG.ALGORITHM;
      const nearest = sortedLogIndices[0];
      if (nearest.distance <= cfg.FALLBACK_MAX_ABSOLUTE_DISTANCE) {
        const dynamicThreshold = this._computeDynamicDistanceThreshold(sortedLogIndices);
        if (nearest.distance <= dynamicThreshold) {
          return this.logs[nearest.index].brightness;
        }
      }
    }

    const luxEstimate = BrightnessManager.#luxToBrightnessEstimate(ambientState.ambientLightLuxRaw);
    if (luxEstimate !== null) return luxEstimate;

    const dayLight = ambientState.timeFeatures?.dayLight ?? 0.5;
    let estimate = dayLight * 75 + 10;

    if (Number.isFinite(ambientState.cloud) && dayLight > 0.05) {
      const cloudPct = Math.min(100, Math.max(0, Math.pow(10, ambientState.cloud) - 1));
      estimate -= (cloudPct / 100) * 15 * dayLight;
    }

    const visualSignals = [ambientState.webcamScore, ambientState.screen].filter(
      (v) => typeof v === 'number' && Number.isFinite(v)
    );
    if (visualSignals.length > 0) {
      const visualMean = visualSignals.reduce((a, b) => a + b, 0) / visualSignals.length;
      const visualBrightness = Math.min(100, Math.max(0, ((Math.pow(10, visualMean) - 1) / 2.55)));
      estimate = estimate * 0.6 + visualBrightness * 0.4;
    }

    if (ambientState.powerSource === 'battery') {
      estimate *= 0.9;
    }

    const envelope = this._getUserBrightnessEnvelope();
    if (envelope) {
      const clamped = Math.min(100, Math.max(0, estimate));
      estimate = envelope.lo + (clamped / 100) * (envelope.hi - envelope.lo);
    }

    return Math.round(Math.min(100, Math.max(5, estimate)));
  }

  _getUserBrightnessEnvelope() {
    const n = this.logs.length;
    if (n < CONFIG.ALGORITHM.MIN_LOGS_FOR_PREDICTION) return null;
    const values = new Array(n);
    let lo = Infinity;
    for (let i = 0; i < n; i++) {
      const b = this.logs[i].brightness;
      if (!Number.isFinite(b)) return null;
      values[i] = b;
      if (b < lo) lo = b;
    }
    values.sort((a, b) => a - b);
    const hi = values[Math.min(n - 1, Math.floor(n * 0.95))];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null;
    return { lo, hi };
  }

  static #luxToBrightnessEstimate(lux) {
    if (!Number.isFinite(lux) || lux < 0) return null;
    const estimate = 15 + 20 * Math.log10(lux + 1);
    return Math.round(Math.min(100, Math.max(5, estimate)));
  }

  static #calculateDaylight(nowTs, sunrise, sunset) {
    if (!sunrise || !sunset) return 0;
    const riseTime = sunrise.getTime();
    const setTime = sunset.getTime();
    if (nowTs < riseTime || nowTs > setTime) return 0;
    const daySpan = setTime - riseTime;
    if (daySpan <= 0) return 0;
    const rawRatio = (nowTs - riseTime) / daySpan;
    return Math.sin(Math.PI * rawRatio);
  }

  async _pollSystemState() {
    if (this.isAdjusting || this.#isGettingBrightness) return;
    try {
      const currentBrightness = await this._getSystemBrightness();
      if (currentBrightness === null) return;
      if (this.lastKnownBrightness !== null && this.lastKnownBrightness !== currentBrightness) {
        this.emit('brightnessChanged', currentBrightness);
        const previous = this.lastKnownBrightness;
        const delta = Math.abs(currentBrightness - previous);
        if (delta >= CONFIG.ALGORITHM.MIN_MANUAL_CHANGE_THRESHOLD) {
          const observed = currentBrightness;
          setTimeout(async () => {
            try {
              const confirmed = await getSystemBrightness();
              if (confirmed === null || confirmed !== observed || this.isAdjusting) return;
              await new Promise((resolve) => setTimeout(resolve, CONFIG.ALGORITHM.MANUAL_CHANGE_CONFIRM_DELAY_MS));
              const reconfirmed = await getSystemBrightness();
              if (reconfirmed === null || reconfirmed !== observed || this.isAdjusting) return;
              if (this.lastKnownBrightness !== observed) return;
              this.lastKnownBrightness = observed;
              await this._handleManualChange(previous, observed);
            } catch { /* ignore */ }
          }, CONFIG.ALGORITHM.MANUAL_CHANGE_CONFIRM_DELAY_MS);
        }
      }
      this.lastKnownBrightness = currentBrightness;
    } catch (error) { /* ignore */ }
  }

  async _handleManualChange(previousBrightness, newBrightness) {
    if (this.isAdjusting) return;
    this._emitLog('info', `Manual brightness change detected: ${previousBrightness} → ${newBrightness}`);
    await this._logChange(newBrightness, 'manual');
    const manualOverride = Date.now() + (this.settings.manualOverrideMinutes || 5) * 60 * 1000;
    if (manualOverride > this.manualOverrideUntil) this.manualOverrideUntil = manualOverride;
    this._resetAdjustmentInterval();
  }

  pauseAdjustments(durationMs) {
    const ms = Number(durationMs);
    this.manualOverrideUntil = Date.now() + (Number.isFinite(ms) && ms > 0 ? ms : 60 * 60 * 1000);
    this._resetAdjustmentInterval();
    this._emitLog('info', `Adjustments paused until ${new Date(this.manualOverrideUntil).toLocaleTimeString()}.`);
    return this.manualOverrideUntil;
  }

  resumeAdjustments() {
    this.manualOverrideUntil = 0;
    this._resetAdjustmentInterval();
    this._emitLog('info', 'Adjustments resumed.');
  }

  restartLearningPhase() {
    this.learningConfig.learningMode = true;
    this.learningConfig.startTime = Date.now();
    this.#isDirty = true;
    this._updateLearningPhase(0);
    this._emitLog('info', 'Learning phase restarted from day 0.');
  }

  clearLearningLogs() {
    this.logs = [];
    this.#initializeStats();
    this.featureImportance = {};
    this.displayImportance = {};
    this.#relationshipFeatures = [];
    this.#relationshipPrecision = null;
    this.#relSetCache = null;
    this.#interactionPair = null;
    this.#isDirty = true;
    this.learningConfig.learningMode = true;
    this.learningConfig.startTime = Date.now();
    this.manualOverrideUntil = Date.now() + 30000;
    this.#clearResetCyclePending = true;
    this.#lastAmbientState = null;
    this.#lastAmbientStateAt = 0;
    this._resetAdjustmentInterval();
    this._emitLog('success', 'Learning history cleared. Learning phase restarted; brightness now follows the safe fallback estimate.');
    setImmediate(() => {
      this.#clearResetCyclePending = false;
      this.manualOverrideUntil = 0;
      this._runAutoAdjustmentCycle();
    });
  }

  async exportLogsCsv() {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const keys = ['timestamp', 'brightness', 'type', 'webcamScore', 'screen', 'cloud', 'ambientLight', 'ambientLightLuxRaw', 'ambientLightSource', 'ambientLightDetail', 'faceCount', 'faceBrightness', 'faceProximity', 'faceCenterDeviation', 'lightSourceCount', 'lightDirection', 'visualConfidence', 'app', 'powerSource', 'batteryLevel', 'nightLight'];
    const lines = [keys.join(',')];
    for (const log of this.logs) {
      const row = keys.map((k) => {
        if (k === 'timestamp') return esc(log.timestamp);
        if (k === 'timeFeatures') return '';
        const v = FEATURE_DEFINITIONS[k] ? FEATURE_DEFINITIONS[k].accessor(log) : log[k];
        return esc(v);
      });
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }

}

module.exports = BrightnessManager;