// webcamAnalysis.worker.js

const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const cv = require('@techstark/opencv-js');
const bmp = require('bmp-js');
const sharp = require('sharp');

// OpenCV color-conversion constants verified against a synthetic asymmetric
// Bayer frame: for an ffmpeg 'bayer_<XXXX>' stream the demosaic constant is
// cv['COLOR_Bayer' + <XXXX> + '2RGB'] — i.e. the pattern name is used as-is.
const BAYER_DEMOSAIC = {
  rggb: 'COLOR_BayerRG2RGBA',
  bggr: 'COLOR_BayerBG2RGBA',
  gbrg: 'COLOR_BayerGB2RGBA',
  grbg: 'COLOR_BayerGR2RGBA',
};

const THRESHOLDS = {
  WHITE_CLIP: 230,
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

let linearLut = null;

function getLinearLut() {
  if (linearLut) return linearLut;
  const lut = new cv.Mat(1, 256, cv.CV_8UC1);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    lut.data[i] = Math.round(lin * 255);
  }
  linearLut = lut;
  return lut;
}

function analyzeBasicStatsOpencv(grayMat) {
  const totalPixels = grayMat.rows * grayMat.cols;
  if (totalPixels === 0) return { mean: 0, stdDev: 0, crushedBlacksPct: 0, clippedWhitesPct: 0, p50: 0, p90: 0, p95: 0, linMean: 0, gridMedian: 0, gridSpread: 0, colorTemp: null };

  const meanMat = new cv.Mat();
  const stdDevMat = new cv.Mat();
  const mask = new cv.Mat();
  const linMat = new cv.Mat();
  const { lowerBound, zeroBound, clipBound, maxBound } = getBoundMats(grayMat);

  try {
    cv.meanStdDev(grayMat, meanMat, stdDevMat);
    const mean = meanMat.doubleAt(0, 0);
    const stdDev = stdDevMat.doubleAt(0, 0);

    cv.inRange(grayMat, zeroBound, lowerBound, mask);
    const crushedCount = cv.countNonZero(mask);

    cv.inRange(grayMat, clipBound, maxBound, mask);
    const clippedCount = cv.countNonZero(mask);

    const hist = new Array(256).fill(0);
    const step = Math.max(1, Math.floor(totalPixels / 20000));
    let sampled = 0;
    for (let y = 0; y < grayMat.rows; y += step) {
      for (let x = 0; x < grayMat.cols; x += step) {
        hist[grayMat.ucharAt(y, x)]++;
        sampled++;
      }
    }
    const quantile = (q) => {
      const target = sampled * q;
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= target) return v;
      }
      return 255;
    };

    cv.LUT(grayMat, getLinearLut(), linMat);
    const linMean = cv.mean(linMat)[0];

    const gw = 8, gh = 6;
    const cw = Math.floor(grayMat.cols / gw), chh = Math.floor(grayMat.rows / gh);
    const cellMeans = [];
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const cell = linMat.roi({ x: gx * cw, y: gy * chh, width: cw, height: chh });
        cellMeans.push(cv.mean(cell)[0]);
        cell.delete();
      }
    }
    cellMeans.sort((a, b) => a - b);
    const gridMedian = cellMeans[Math.floor(cellMeans.length / 2)];
    const gridSpread = cellMeans[cellMeans.length - 1] - cellMeans[0];

    return {
      mean,
      stdDev,
      crushedBlacksPct: (crushedCount / totalPixels) * 100,
      clippedWhitesPct: (clippedCount / totalPixels) * 100,
      p50: quantile(0.5),
      p90: quantile(0.9),
      p95: quantile(0.95),
      linMean: Math.round(linMean * 10) / 10,
      gridMedian: Math.round(gridMedian * 10) / 10,
      gridSpread: Math.round(gridSpread * 10) / 10,
      colorTemp: null
    };

  } finally {
    meanMat.delete();
    stdDevMat.delete();
    mask.delete();
    linMat.delete();
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

    // Weak blobs (below significance area) are excluded from direction so a
    // few noisy pixels don't swing the centroid; count still reports all
    // significant blobs. Strength = share of frame area covered by bright
    // blobs — tiny coverage means the direction reading is unreliable.
    let direction = 'Front/Balanced';
    let directionDetail = null;
    let directionStrength = 0;
    if (blobs.length > 0) {
      let areaTotal = 0;
      let cxSum = 0, cySum = 0;
      for (const b of blobs) {
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        cxSum += cx * b.area;
        cySum += cy * b.area;
        areaTotal += b.area;
      }
      directionStrength = Math.round((areaTotal / (width * height)) * 1000) / 1000;
      const relX = cxSum / areaTotal / width;
      const relY = cySum / areaTotal / height;
      const dx = Math.abs(relX - 0.5);
      const dy = Math.abs(relY - 0.5);
      if (dx < 0.08 && dy < 0.08) {
        direction = 'Front/Balanced';
      } else if (dx >= dy) {
        direction = relX < 0.5 ? 'Left' : 'Right';
        directionDetail = { axis: 'horizontal', offset: Math.round(dx * 200) / 100 };
      } else {
        direction = relY < 0.5 ? 'Top' : 'Bottom';
        directionDetail = { axis: 'vertical', offset: Math.round(dy * 200) / 100 };
      }
    }

    return { count: blobs.length, direction, directionDetail, directionStrength, sources: blobs };

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

    const infos = [];
    for (let i = 0; i < facesRects.size(); ++i) {
      const f = facesRects.get(i);
      const roi = grayMat.roi(f);
      const mean = cv.mean(roi)[0];
      roi.delete();
      infos.push({ x: f.x, y: f.y, width: f.width, height: f.height, mean });
    }

    let primary = null;
    let bestScore = Infinity;
    for (const info of infos) {
      const cx = info.x + info.width / 2;
      const cy = info.y + info.height / 2;
      const score = Math.hypot(
        (cx - grayMat.cols / 2) / grayMat.cols,
        (cy - grayMat.rows / 2) / grayMat.rows
      );
      if (score < bestScore) { bestScore = score; primary = info; }
    }

    const ordered = primary ? [primary, ...infos.filter((f) => f !== primary)] : [];
    const resultFaces = ordered.map((info) => {
      const centerX = info.x + info.width / 2;
      const relX = centerX / grayMat.cols;
      let loc = 'Center';
      if (relX < 0.33) loc = 'Left';
      else if (relX > 0.66) loc = 'Right';
      return { x: info.x, y: info.y, width: info.width, height: info.height, location: loc };
    });

    return {
      detected: resultFaces.length > 0,
      count: resultFaces.length,
      faces: resultFaces,
      faceExposure: primary ? primary.mean : null
    };

  } catch (err) {
    console.error('[webcamAnalysis.worker] Face detection error:', err.message);
    return { detected: false, count: 0, faces: [], error: err.message };
  } finally {
    if (facesRects) facesRects.delete();
  }
}

function analyzeFrame({ buffer, width, height, detectFaces }) {
  const data = new Uint8Array(buffer);

  let srcMatFull = null;
  let grayMatFull = null;

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

    const grayForFull = new cv.Mat();
    cv.cvtColor(srcMatFull, grayForFull, cv.COLOR_RGBA2GRAY);

    const baseStats = analyzeBasicStatsOpencv(grayForFull);
    const colorAnalysis = analyzeColorBalanceOpencv(srcMatFull);
    const blurStats = analyzeBlurOpencv(grayForFull);
    const lighting = analyzeLightingOpencv(grayForFull, baseStats);
    grayForFull.delete();

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
        crushedBlacksPct: Math.round(baseStats.crushedBlacksPct * 10) / 10,
        clippedWhitesPct: Math.round(baseStats.clippedWhitesPct * 10) / 10,
        p50: baseStats.p50,
        p90: baseStats.p90,
        p95: baseStats.p95,
        linMean: baseStats.linMean,
        gridMedian: baseStats.gridMedian,
        gridSpread: baseStats.gridSpread,
        color: colorAnalysis.diagnosis
      },
      lighting: {
        direction: lighting.direction,
        directionDetail: lighting.directionDetail,
        directionStrength: lighting.directionStrength,
        sourceCount: lighting.count
      },
      faces: {
        detected: faceAnalysis.detected,
        count: faceAnalysis.count,
        faceBrightness: faceAnalysis.faceExposure ? Math.round(faceAnalysis.faceExposure) : 'N/A',
        positions: faceAnalysis.faces
      },
      frameWidth: width,
      frameHeight: height
    };

  } finally {
    if (srcMatFull) srcMatFull.delete();
    if (grayMatFull) grayMatFull.delete();
  }
}

function decodeBmpToRgba(imageBuffer) {
  const decoded = bmp.decode(Buffer.from(imageBuffer));
  const { width, height } = decoded;
  const src = decoded.data;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = src[i + 3];
    rgba[i + 1] = src[i + 2];
    rgba[i + 2] = src[i + 1];
    rgba[i + 3] = 255;
  }
  return { buffer: rgba, width, height };
}

async function decodeLossyToRgba(imageBuffer) {
  const { data, info } = await sharp(Buffer.from(imageBuffer)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { buffer: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

// Demosaic a Bayer raw plane to RGBA via OpenCV. Pattern must be one of
// rggb / bggr / gbrg / grbg; width/height are the sensor dimensions. 10-
// and 12-bit values packed by ffmpeg as 16-bit words are normalized to
// 8-bit with a bit shift so the downstream pipeline stays depth-invariant.
function demosaicRaw(buffer, width, height, pattern, bitDepth = 8) {
  const fn = BAYER_DEMOSAIC[pattern];
  if (!fn) throw new Error(`Unknown Bayer pattern "${pattern}"`);
  const shift = bitDepth === 16 ? 8 : bitDepth === 12 ? 4 : bitDepth === 10 ? 2 : 0;
  const plane = shift > 0
    ? Uint16Array.from(buffer, (v) => Math.min(255, v >> shift))
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const src = new cv.Mat(height, width, cv.CV_8UC1);
  src.data.set(plane.subarray(0, width * height));
  const out = new cv.Mat();
  cv.demosaicing(src, out, cv[fn]);
  src.delete();
  const rgba = new Uint8ClampedArray(out.cols * out.rows * 4);
  rgba.set(new Uint8Array(out.data.buffer, out.data.byteOffset, rgba.length));
  out.delete();
  return rgba;
}

async function decodeLossyToRgba(imageBuffer) {
  const { data, info } = await sharp(Buffer.from(imageBuffer)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { buffer: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

// Mean of each Bayer color channel straight from the mosaic plane, without
// demosaicing. Each sensor site holds one channel; the 2x2 mosaic phase
// (pattern) says which. Values normalized to 0-255 for depth parity with
// the demosaiced path.
function bayerChannelMeans(buffer, width, height, pattern, bitDepth = 8) {
  const map = {
    rggb: { 0: 'r', 1: 'g1', 2: 'g2', 3: 'b' },
    grbg: { 0: 'g1', 1: 'b', 2: 'r', 3: 'g2' },
    gbrg: { 0: 'g1', 1: 'r', 2: 'b', 3: 'g2' },
    bggr: { 0: 'b', 1: 'g1', 2: 'g2', 3: 'r' },
  };
  const siteMap = map[pattern] || map.rggb;
  const sums = { r: 0, g: 0, b: 0 };
  const counts = { r: 0, g: 0, b: 0 };
  const shift = bitDepth === 16 ? 8 : bitDepth === 12 ? 4 : bitDepth === 10 ? 2 : 0;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      let v = buffer[rowBase + x];
      if (shift) v = Math.min(255, v >> shift);
      const site = (y & 1) * 2 + (x & 1);
      const ch = siteMap[site][0]; // g1/g2 both fold into 'g'
      sums[ch] += v;
      counts[ch]++;
    }
  }
  return {
    rMean: counts.r ? sums.r / counts.r : 0,
    gMean: counts.g ? sums.g / counts.g : 0,
    bMean: counts.b ? sums.b / counts.b : 0,
  };
}

// Distance from the Planckian locus in CIE 1960 uv, used to reject
// chromaticities that aren't "whitish" (a frame dominated by a red poster
// or green plant produces nonsense CCT). Planckian chromaticity per
// Kim et al. 2002: cubic in 1/T for x, with y as a polynomial in x.
function planckianXyAtCct(cct) {
  // Kang et al. 2002 (colour-science/colour kang2002 reference), x branch
  // coefficients transcribed verbatim.
  const t = 1 / cct;
  let x;
  if (cct <= 4000) {
    x = -0.2661239e9 * t ** 3 - 0.2343589e6 * t ** 2 + 0.8776956e3 * t + 0.179910;
  } else {
    x = -3.0258469e9 * t ** 3 + 2.1070379e6 * t ** 2 + 0.2226347e3 * t + 0.240390;
  }
  // Kang/Y position branches (colour-science/colour kang2002 reference):
  //  <=2222K: i coeffs; 2222–4000K: j coeffs; >4000K: k coeffs.
  let y;
  if (cct <= 2222) {
    y = -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683;
  } else if (cct <= 4000) {
    y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.0817580 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  }
  return { x, y };
}

function xyToUv1960(x, y) {
  const d = -2 * x + 12 * y + 3;
  if (d === 0) return null;
  return { u: 4 * x / d, v: 6 * y / d };
}

// CCT from raw Bayer channel means. Camera RGB responses are not CIE
// XYZ, so the means first go through the standard sRGB-primary matrix
// (a reasonable approximation for typical Bayer sensors with IR-cut
// filters — same approach as the Analog Devices RGB-sensor app note),
// then CIE xy -> McCamy (1992) cubic, with a Planckian-locus Duv guard
// so strongly colored scenes don't produce a bogus Kelvin number.
function computeColorTempCct(rMean, gMean, bMean) {
  if (!(rMean > 0 && gMean > 0 && bMean > 0)) return null;
  const X = 0.4124 * rMean + 0.3576 * gMean + 0.1805 * bMean;
  const Y = 0.2126 * rMean + 0.7152 * gMean + 0.0722 * bMean;
  const Z = 0.0193 * rMean + 0.1192 * gMean + 0.9505 * bMean;
  const xyzSum = X + Y + Z;
  if (xyzSum <= 0) return null;
  const x = X / xyzSum;
  const y = Y / xyzSum;
  const n = (x - 0.3320) / (y - 0.1858);
  if (!Number.isFinite(n)) return null;
  const cct = -449 * n ** 3 + 3525 * n ** 2 - 6823.3 * n + 5520.33;
  if (!Number.isFinite(cct) || cct < 1500 || cct > 20000) return null;
  const locus = planckianXyAtCct(Math.min(20000, Math.max(1667, cct)));
  if (locus) {
    const a = xyToUv1960(x, y);
    const b = xyToUv1960(locus.x, locus.y);
    if (a && b && Math.hypot(a.u - b.u, a.v - b.v) > 0.05) return null;
  }
  return Math.round(cct);
}

// Re-encode demosaiced linear sensor values into the sRGB transfer
// function (inverse of the srgbToLinear LUT) so the demosaiced frame's
// face/exposure stats sit on the same scale as every processed-path
// reading the app has calibrated against.
function srgbEncode(rgba) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c] / 255;
      const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      out[i + c] = Math.max(0, Math.min(255, Math.round(s * 255)));
    }
    out[i + 3] = 255;
  }
  return out;
}

parentPort.on('message', async (msg) => {
  const { id, raw, bmpBuffer, detectFaces } = msg;
  try {
    await waitForCvReady();
    let buffer = raw;
    let width, height;
    let rawMeta = null;
    if (bmpBuffer) {
      const buf = Buffer.from(bmpBuffer);
      const isBmp = buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4D;
      const decoded = isBmp ? decodeBmpToRgba(buf) : await decodeLossyToRgba(buf);
      buffer = decoded.buffer;
      width = decoded.width;
      height = decoded.height;
    } else if (msg.bayerBuffer) {
      const bayer = Buffer.from(msg.bayerBuffer);
      width = msg.width;
      height = msg.height;
      const pattern = msg.bayerPattern || 'rggb';
      const bitDepth = msg.bayerBitDepth || 8;
      const view = bitDepth === 8
        ? new Uint8Array(bayer.buffer, bayer.byteOffset, bayer.length)
        : new Uint16Array(bayer.buffer, bayer.byteOffset, Math.floor(bayer.length / 2));
      const rawMeans = bayerChannelMeans(view, width, height, pattern, bitDepth);
      // Demosaiced values are sensor-referred linear light; re-encode to
      // sRGB so face/exposure stats stay on the same scale as every
      // processed-path reading (the lux anchors and learned models are
      // calibrated on sRGB-encoded camera output).
      const rgba = srgbEncode(demosaicRaw(view, width, height, pattern, bitDepth));
      buffer = rgba;
      rawMeta = {
        bayerPattern: pattern,
        bayerBitDepth: bitDepth,
        rawMeans,
      };
    } else {
      width = msg.width;
      height = msg.height;
    }
    const result = analyzeFrame({ buffer, width, height, detectFaces });
    if (rawMeta) {
      const { rMean, gMean, bMean } = rawMeta.rawMeans;
      result.raw = {
        bayerPattern: rawMeta.bayerPattern,
        bayerBitDepth: rawMeta.bayerBitDepth,
        rawMeanR: Math.round(rMean * 10) / 10,
        rawMeanG: Math.round(gMean * 10) / 10,
        rawMeanB: Math.round(bMean * 10) / 10,
        colorTempCct: computeColorTempCct(rMean, gMean, bMean),
      };
    }
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});