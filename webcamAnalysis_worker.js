// webcamAnalysis.worker.js

const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const cv = require('@techstark/opencv-js');
const bmp = require('bmp-js');

const THRESHOLDS = {
  WHITE_CLIP: 250,
  BLACK_CRUSH: 5,
  NOISE_HIGH: 50.0,
  BLUR_VARIANCE_LOW: 100.0,
  IDEAL_FACE_MEAN: 130.0,
  IDEAL_GLOBAL_MEAN: 110.0,
  COLOR_IMBALANCE_RATIO: 1.4
};

const HAAR_CASCADE_FILE = 'haarcascade_frontalface_default.xml';

let faceClassifier = null;
let cvLoaded = false;
let cvReadyPromise = null;

function waitForCvReady() {
  if (cvLoaded || cv.Mat) {
    cvLoaded = true;
    return Promise.resolve();
  }
  if (!cvReadyPromise) {
    cvReadyPromise = new Promise((resolve) => {
      const previousHook = cv['onRuntimeInitialized'];
      cv['onRuntimeInitialized'] = () => {
        if (typeof previousHook === 'function') {
          try { previousHook(); } catch (e) { /* ignore */ }
        }
        cvLoaded = true;
        resolve();
      };
    });
  }
  return cvReadyPromise;
}

function getFaceClassifier() {
  if (!cvLoaded && cv.Mat) cvLoaded = true;
  if (!cvLoaded) return null;

  if (!faceClassifier) {
    const searchPaths = [
      path.resolve(__dirname, HAAR_CASCADE_FILE),
      path.resolve(process.cwd(), HAAR_CASCADE_FILE),
    ];

    const xmlPath = searchPaths.find(p => fs.existsSync(p));

    if (xmlPath) {
      try {
        const data = fs.readFileSync(xmlPath);
        cv.FS_createDataFile('/', 'face_cascade.xml', data, true, false, false);
        faceClassifier = new cv.CascadeClassifier();
        const loaded = faceClassifier.load('face_cascade.xml');
        if (!loaded) throw new Error('OpenCV load method returned false');
      } catch (err) {
        console.warn('[webcamAnalysis.worker] Failed to load Haar Cascade:', err.message);
        faceClassifier = null;
      }
    } else {
      console.warn(`[webcamAnalysis.worker] Haar Cascade file not found. Checked: ${searchPaths.join(', ')}. ` +
        `Make sure ${HAAR_CASCADE_FILE} is bundled next to this file in the packaged app.`);
    }
  }
  return faceClassifier;
}

const boundMatCache = new Map();
const MAX_BOUND_MAT_ENTRIES = 8;

function evictUnusedBoundMats(activeKey) {
  if (boundMatCache.size < MAX_BOUND_MAT_ENTRIES) return;
  for (const [key, entry] of boundMatCache) {
    if (key === activeKey) continue;
    for (const mat of Object.values(entry)) {
      try { mat.delete(); } catch { /* already freed */ }
    }
    boundMatCache.delete(key);
    if (boundMatCache.size < MAX_BOUND_MAT_ENTRIES) break;
  }
}

function getBoundMats(grayMat) {
  const key = `${grayMat.rows}x${grayMat.cols}x${grayMat.type()}`;
  evictUnusedBoundMats(key);
  let entry = boundMatCache.get(key);
  if (!entry) {
    entry = {
      lowerBound: new cv.Mat(grayMat.rows, grayMat.cols, grayMat.type(), [THRESHOLDS.BLACK_CRUSH, 0, 0, 0]),
      zeroBound: new cv.Mat(grayMat.rows, grayMat.cols, grayMat.type(), [0, 0, 0, 0]),
      clipBound: new cv.Mat(grayMat.rows, grayMat.cols, grayMat.type(), [THRESHOLDS.WHITE_CLIP, 0, 0, 0]),
      maxBound: new cv.Mat(grayMat.rows, grayMat.cols, grayMat.type(), [255, 0, 0, 0]),
    };
    boundMatCache.set(key, entry);
  }
  return entry;
}

function analyzeBasicStatsOpencv(grayMat) {
  const totalPixels = grayMat.rows * grayMat.cols;
  if (totalPixels === 0) return { mean: 0, stdDev: 0, crushedBlacksPct: 0, clippedWhitesPct: 0 };

  const meanMat = new cv.Mat();
  const stdDevMat = new cv.Mat();
  const mask = new cv.Mat();
  const { lowerBound, zeroBound, clipBound, maxBound } = getBoundMats(grayMat);

  try {
    cv.meanStdDev(grayMat, meanMat, stdDevMat);
    const mean = meanMat.doubleAt(0, 0);
    const stdDev = stdDevMat.doubleAt(0, 0);

    cv.inRange(grayMat, zeroBound, lowerBound, mask);
    const crushedCount = cv.countNonZero(mask);

    cv.inRange(grayMat, clipBound, maxBound, mask);
    const clippedCount = cv.countNonZero(mask);

    return {
      mean,
      stdDev,
      crushedBlacksPct: (crushedCount / totalPixels) * 100,
      clippedWhitesPct: (clippedCount / totalPixels) * 100
    };

  } finally {
    meanMat.delete();
    stdDevMat.delete();
    mask.delete();
  }
}

function analyzeColorBalanceOpencv(rgbaMat) {
  const means = cv.mean(rgbaMat);
  const r = means[0];
  const g = means[1];
  const b = means[2];

  let diagnosis = 'Balanced';
  let penalty = 0;

  if (b > r * THRESHOLDS.COLOR_IMBALANCE_RATIO) {
    diagnosis = 'Too Cold/Blue';
    penalty = 10;
  } else if (r > b * THRESHOLDS.COLOR_IMBALANCE_RATIO) {
    diagnosis = 'Too Warm/Yellow';
    penalty = 10;
  } else if (g > (r + b) / 2 * 1.2) {
    diagnosis = 'Green Tint';
    penalty = 15;
  }

  return { r, g, b, diagnosis, penalty };
}

function analyzeBlurOpencv(grayMat) {
  const laplacian = new cv.Mat();
  const meanMat = new cv.Mat();
  const stdDevMat = new cv.Mat();

  try {
    cv.Laplacian(grayMat, laplacian, cv.CV_64F);

    cv.meanStdDev(laplacian, meanMat, stdDevMat);
    const stdDev = stdDevMat.doubleAt(0, 0);
    const variance = stdDev * stdDev;

    return {
      variance,
      isBlurry: variance < THRESHOLDS.BLUR_VARIANCE_LOW
    };
  } finally {
    laplacian.delete();
    meanMat.delete();
    stdDevMat.delete();
  }
}

function analyzeLightingOpencv(grayMat, stats) {
  const blobs = [];
  const width = grayMat.cols;
  const height = grayMat.rows;

  const threshMat = new cv.Mat();
  const labels = new cv.Mat();
  const blobStats = new cv.Mat();
  const centroids = new cv.Mat();

  try {
    const adaptiveThreshold = Math.max(120, Math.min(253, stats.mean + 1.5 * stats.stdDev));
    cv.threshold(grayMat, threshMat, adaptiveThreshold, 255, cv.THRESH_BINARY);
    const count = cv.connectedComponentsWithStats(threshMat, labels, blobStats, centroids);

    const minBlobSize = Math.max(20, width * height * 0.001);

    for (let i = 1; i < count; i++) {
      const area = blobStats.intAt(i, cv.CC_STAT_AREA);
      if (area > minBlobSize) {
        blobs.push({
          x: blobStats.intAt(i, cv.CC_STAT_LEFT),
          y: blobStats.intAt(i, cv.CC_STAT_TOP),
          width: blobStats.intAt(i, cv.CC_STAT_WIDTH),
          height: blobStats.intAt(i, cv.CC_STAT_HEIGHT),
          area: area
        });
      }
    }

    const halfW = Math.floor(width / 2);
    const halfH = Math.floor(height / 2);
    const top = new cv.Mat();
    const bottom = new cv.Mat();
    const left = new cv.Mat();
    const right = new cv.Mat();
    let sumTop = 0, sumBottom = 0, sumLeft = 0, sumRight = 0;
    try {
      grayMat.rowRange(0, halfH).copyTo(top);
      grayMat.rowRange(halfH, height).copyTo(bottom);
      grayMat.colRange(0, halfW).copyTo(left);
      grayMat.colRange(halfW, width).copyTo(right);
      sumTop = cv.mean(top)[0] * top.rows * top.cols;
      sumBottom = cv.mean(bottom)[0] * bottom.rows * bottom.cols;
      sumLeft = cv.mean(left)[0] * left.rows * left.cols;
      sumRight = cv.mean(right)[0] * right.rows * right.cols;
    } finally {
      top.delete(); bottom.delete(); left.delete(); right.delete();
    }

    let direction = 'Front/Balanced';
    const verticalDiff = sumTop - sumBottom;
    const horizontalDiff = sumLeft - sumRight;
    const total = sumTop + sumBottom + 1;
    const vertRatio = Math.abs(verticalDiff) / total;
    const horizRatio = Math.abs(horizontalDiff) / total;

    if (Math.max(vertRatio, horizRatio) < 0.06) {
      direction = 'Front/Balanced';
    } else if (vertRatio >= horizRatio) {
      direction = verticalDiff > 0 ? 'Top' : 'Bottom';
    } else {
      direction = horizontalDiff > 0 ? 'Left' : 'Right';
    }

    return { count: blobs.length, direction, sources: blobs };

  } finally {
    threshMat.delete();
    labels.delete();
    blobStats.delete();
    centroids.delete();
  }
}

function detectFacesOnMat(grayMat) {
  const classifier = getFaceClassifier();
  if (!classifier) return { detected: false, count: 0, faces: [], faceExposure: null };

  let facesRects = null;

  try {
    facesRects = new cv.RectVector();

    classifier.detectMultiScale(grayMat, facesRects, 1.1, 5, 0, new cv.Size(30, 30));

    const resultFaces = [];
    let faceRegionMean = null;
    let accumulatedMean = 0;
    let countWithMean = 0;

    for (let i = 0; i < facesRects.size(); ++i) {
      const f = facesRects.get(i);

      const roi = grayMat.roi(f);
      const mean = cv.mean(roi);
      accumulatedMean += mean[0];
      countWithMean++;
      roi.delete();

      const centerX = f.x + f.width / 2;
      const relX = centerX / grayMat.cols;
      let loc = 'Center';
      if (relX < 0.33) loc = 'Left';
      else if (relX > 0.66) loc = 'Right';

      resultFaces.push({ x: f.x, y: f.y, width: f.width, height: f.height, location: loc });
    }

    if (countWithMean > 0) {
      faceRegionMean = accumulatedMean / countWithMean;
    }

    return {
      detected: resultFaces.length > 0,
      count: resultFaces.length,
      faces: resultFaces,
      faceExposure: faceRegionMean
    };

  } catch (err) {
    console.error('[webcamAnalysis.worker] Face detection error:', err.message);
    return { detected: false, count: 0, faces: [], error: err.message };
  } finally {
    if (facesRects) facesRects.delete();
  }
}

function analyzeFrame({ buffer, width, height, faceDetectWidth, analysisWidth, analysisHeight, detectFaces }) {
  const data = new Uint8Array(buffer);

  let srcMatFull = null;
  let grayMatFull = null;
  let srcMatSmall = null;
  let grayMatSmall = null;

  try {
    srcMatFull = new cv.Mat(height, width, cv.CV_8UC4);
    srcMatFull.data.set(data);

    let faceAnalysis = { detected: false, count: 0, faces: [], faceExposure: null };
    if (detectFaces !== false) {
      grayMatFull = new cv.Mat();
      cv.cvtColor(srcMatFull, grayMatFull, cv.COLOR_RGBA2GRAY);
      faceAnalysis = detectFacesOnMat(grayMatFull);
      grayMatFull.delete();
      grayMatFull = null;
    }

    srcMatSmall = new cv.Mat();
    grayMatSmall = new cv.Mat();

    const smallSize = new cv.Size(analysisWidth, analysisHeight);
    cv.resize(srcMatFull, srcMatSmall, smallSize, 0, 0, cv.INTER_AREA);

    const grayForSmall = new cv.Mat();
    cv.cvtColor(srcMatSmall, grayForSmall, cv.COLOR_RGBA2GRAY);

    const baseStats = analyzeBasicStatsOpencv(grayForSmall);
    const colorAnalysis = analyzeColorBalanceOpencv(srcMatSmall);
    const blurStats = analyzeBlurOpencv(grayForSmall);
    const lighting = analyzeLightingOpencv(grayForSmall, baseStats);
    grayForSmall.delete();

    let exposureScore = 0;
    let scoreDiagnosis = [];

    let effectiveMean = baseStats.mean;
    let targetMean = THRESHOLDS.IDEAL_GLOBAL_MEAN;

    if (faceAnalysis.detected && faceAnalysis.faceExposure !== null) {
      effectiveMean = faceAnalysis.faceExposure;
      targetMean = THRESHOLDS.IDEAL_FACE_MEAN;
      scoreDiagnosis.push('Face Detected');
    } else {
      scoreDiagnosis.push('No Face Detected');
    }

    const dist = Math.abs(effectiveMean - targetMean);
    if (dist < 15) exposureScore = 100;
    else exposureScore = Math.max(0, 100 - (dist * 0.8));

    let finalScore = exposureScore;
    let problems = [];

    if (effectiveMean < 50) problems.push('Severe Underexposure');
    else if (effectiveMean < 80) problems.push('Underexposed');
    else if (effectiveMean > 220) problems.push('Severe Overexposure');
    else if (effectiveMean > 190) problems.push('Overexposed');

    if (faceAnalysis.detected && baseStats.mean > effectiveMean + 40) {
      problems.push('Backlighting (Face dark, background bright)');
      finalScore -= 20;
    }

    if (baseStats.stdDev < 20) {
      problems.push('Low Contrast / Foggy');
      finalScore -= 15;
    }

    if (colorAnalysis.diagnosis !== 'Balanced') {
      problems.push(colorAnalysis.diagnosis);
      finalScore -= colorAnalysis.penalty;
    }

    if (blurStats.isBlurry && baseStats.stdDev > 10) {
      problems.push('Potential Blur / Out of Focus');
      finalScore -= 20;
    }

    if (baseStats.crushedBlacksPct > 30) {
      problems.push('Shadows Crushed (Too Dark)');
      finalScore -= 10;
    }

    if (baseStats.clippedWhitesPct > 10) {
      problems.push('Highlights Clipped (Too Bright)');
      finalScore -= 10;
    }

    finalScore = Math.round(Math.max(0, Math.min(100, finalScore)));

    let mainDiagnosis = '';
    if (finalScore >= 85) mainDiagnosis = 'Excellent Quality';
    else if (finalScore >= 70) mainDiagnosis = 'Good Quality';
    else if (finalScore >= 50) mainDiagnosis = 'Fair / Average';
    else if (finalScore >= 30) mainDiagnosis = 'Poor Quality';
    else mainDiagnosis = 'Unusable / Very Bad';

    if (problems.length > 0) {
      mainDiagnosis += `: ${problems.join(', ')}`;
    }

    return {
      score: finalScore,
      diagnosis: mainDiagnosis,
      stats: {
        exposure: Math.round(effectiveMean),
        noise: Math.round(baseStats.stdDev),
        sharpness: Math.round(blurStats.variance),
        // AE-invariant light cues: auto-exposure pins the mean, so these
        // tail fractions carry the real room-light variance.
        crushedBlacksPct: Math.round(baseStats.crushedBlacksPct * 10) / 10,
        clippedWhitesPct: Math.round(baseStats.clippedWhitesPct * 10) / 10,
        color: colorAnalysis.diagnosis
      },
      lighting: {
        direction: lighting.direction,
        sourceCount: lighting.count
      },
      faces: {
        detected: faceAnalysis.detected,
        count: faceAnalysis.count,
        faceBrightness: faceAnalysis.faceExposure ? Math.round(faceAnalysis.faceExposure) : 'N/A',
        positions: faceAnalysis.faces
      }
    };

  } finally {
    if (srcMatFull) srcMatFull.delete();
    if (grayMatFull) grayMatFull.delete();
    if (srcMatSmall) srcMatSmall.delete();
    if (grayMatSmall) grayMatSmall.delete();
  }
}

parentPort.on('message', async (msg) => {
  const { id, raw, bmpBuffer, faceDetectWidth, analysisWidth, analysisHeight, detectFaces } = msg;
  try {
    await waitForCvReady();
    let buffer = raw;
    let width, height;
    if (bmpBuffer) {
      const decoded = bmp.decode(Buffer.from(bmpBuffer));
      width = decoded.width;
      height = decoded.height;
      const srcMat = new cv.Mat(height, width, cv.CV_8UC4);
      srcMat.data.set(decoded.data);
      const faceW = Math.min(width, faceDetectWidth || width);
      const scale = faceW / width;
      const dstW = faceW;
      const dstH = Math.round(height * scale);
      const dst = new cv.Mat(dstH, dstW, cv.CV_8UC4);
      cv.resize(srcMat, dst, new cv.Size(dstW, dstH), 0, 0, cv.INTER_AREA);
      buffer = new Uint8ClampedArray(dst.data);
      width = dstW;
      height = dstH;
      srcMat.delete();
      dst.delete();
    } else {
      width = msg.width;
      height = msg.height;
    }
    const result = analyzeFrame({ buffer, width, height, faceDetectWidth, analysisWidth, analysisHeight, detectFaces });
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});