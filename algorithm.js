// algorithm.js — math utilities for the learning engine: array stats,
// matrix algebra, weighted ridge regression, and feature definitions.
// Extracted from BrightnessManager to keep the ML core independently testable.

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

const FEATURE_DEFINITIONS = {
  webcam:          { accessor: (s) => s?.webcamScore,            type: 'numeric' },
  screen:          { accessor: (s) => s?.screen,                 type: 'numeric' },
  ambientLight:    { accessor: (s) => s?.ambientLight,           type: 'numeric' },
  cloud:           { accessor: (s) => s?.cloud,                  type: 'numeric' },
  dayLight:        { accessor: (s) => s?.timeFeatures?.dayLight, type: 'numeric' },
  timeSin:         { accessor: (s) => s?.timeFeatures?.sin,      type: 'numeric' },
  timeCos:         { accessor: (s) => s?.timeFeatures?.cos,      type: 'numeric' },
  faceCount:       { accessor: (s) => s?.faceCount,              type: 'numeric' },
  faceBrightness:  { accessor: (s) => s?.faceBrightness,         type: 'numeric' },
  faceProximity:   { accessor: (s) => s?.faceProximity,          type: 'numeric' },
  faceCenterDeviation: { accessor: (s) => s?.faceCenterDeviation, type: 'numeric' },
  lightSourceCount:{ accessor: (s) => s?.lightSourceCount,       type: 'numeric' },
  visualConfidence:{ accessor: (s) => s?.visualConfidence,       type: 'numeric' },
  batteryLevel:    { accessor: (s) => s?.batteryLevel,           type: 'numeric' },
  colorTempCct:    { accessor: (s) => s?.colorTempCct,           type: 'numeric' },
  app:             { accessor: (s) => s?.app,                    type: 'categorical' },
  lightDirection:  { accessor: (s) => s?.lightDirection,         type: 'categorical' },
  powerSource:     { accessor: (s) => s?.powerSource,            type: 'categorical' },
  nightLight:      { accessor: (s) => s?.nightLight,             type: 'categorical' },
  ambientLightSource: { accessor: (s) => s?.ambientLightSource,  type: 'categorical' },
};

const NUMERIC_FEATURES = [];
const CATEGORICAL_FEATURES = [];
for (const [key, def] of Object.entries(FEATURE_DEFINITIONS)) {
  if (def.type === 'numeric') NUMERIC_FEATURES.push(key);
  else CATEGORICAL_FEATURES.push(key);
}
const ALL_FEATURES = [...NUMERIC_FEATURES, ...CATEGORICAL_FEATURES];

// ---------------------------------------------------------------------------
// Array helpers
// ---------------------------------------------------------------------------

function arrayMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function arrayMean(arr) {
  const len = arr.length;
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

// ---------------------------------------------------------------------------
// Matrix algebra
// ---------------------------------------------------------------------------

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
      const rowR = A[r]; const rowI = I[r];
      const rowC = A[col]; const rowCI = I[col];
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  FEATURE_DEFINITIONS,
  NUMERIC_FEATURES,
  CATEGORICAL_FEATURES,
  ALL_FEATURES,
  arrayMedian,
  arrayMean,
  arrayVar,
  zeroMatrix,
  identityMatrix,
  invertMatrix,
  matVecMul,
  weightedRidgeRegression,
};
