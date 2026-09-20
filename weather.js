// weather.js

const SunCalc = require('suncalc');
const logger = require('./logger');
const { loadJSON, retry, WEATHER_JSON_PATH, DEFAULT_SUNRISE, DEFAULT_SUNSET, PLATFORM, execPowerShell } = require('./core');

const CONFIG = {
    WEATHERAPI_URL: 'https://api.weatherapi.com/v1/forecast.json',
    OPEN_METEO_URL: 'https://api.open-meteo.com/v1/forecast',
    IP_GEOLOCATION_URL: 'https://ip-api.com/json/?fields=status,lat,lon,city,countryCode,query',
    DEFAULT_LOCATION: { latitude: 0, longitude: 0 },
    LOCATION_CACHE_TTL_MS: 6 * 60 * 60 * 1000,      // GPS fix – authoritative for 6 h
    IP_LOCATION_CACHE_TTL_MS: 2 * 60 * 60 * 1000,   // IP fix – re-validate against GPS frequently
    MAX_LOCATION_DRIFT_KM: 50,
    API_TIMEOUT_MS: 15000,
    IP_GEOLOCATION_TIMEOUT_MS: 5000,
    DAILY_WEATHER_TTL_MS: 3600000, // 1 hour
};

const BUNDLED_PUBLIC_KEYS = '6St40m8Siqww0dlFI1g7FqVKGP8A8lCi,cuNEvvF9R6nrkgfxtyb6i4ESJn8Ni8b6,cnI9GWvp7hOzR7qPI9Z3uQpREHRKn6jb,5KrZFlv6DbWosTDfrcSv1F8s5bLZdNf0,NcoH9JHLho0vPsqap57C2aAdO2HtcaVA,gI4KPjPSN04O0kiuk4O7gNkysjWfF2fI'
    .split(',').map((k) => k.trim()).filter(Boolean);

function getWeatherApiKeys() {
    const privateKeys = (process.env.WEATHERAPI_PRIVATE_KEYS || '')
        .split(',').map((k) => k.trim()).filter(Boolean);
    const envPublicKeys = (process.env.WEATHERAPI_KEYS || '')
        .split(',').map((k) => k.trim()).filter(Boolean);
    const publicKeys = [...new Set([...envPublicKeys, ...BUNDLED_PUBLIC_KEYS])];
    if (privateKeys.length > 0) return [...privateKeys, ...publicKeys];
    const single = (process.env.WEATHERAPI_KEY || '').trim();
    if (single) return [single, ...publicKeys];
    return publicKeys;
}

function pickRandomKey(keys, excludeKey = null) {
    const pool = excludeKey ? keys.filter((k) => k !== excludeKey) : keys;
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

function isPrivateKey(key) {
    const privateSet = new Set(
        (process.env.WEATHERAPI_PRIVATE_KEYS || '')
            .split(',').map((k) => k.trim()).filter(Boolean)
    );
    return privateSet.has(key);
}

let memCache = {
    location: null,
    timestamp: 0,
    source: null
};

let lastAcceptedLocation = null;
let lastAcceptedSource = null; // 'gps' | 'ip'

const PS_COMMAND = `
$ErrorActionPreference='Stop';
try{
 Add-Type -AssemblyName System.Device;
 $w=New-Object System.Device.Location.GeoCoordinateWatcher;
 $w.Start();
 $s=Get-Date;
 while($w.Status -ne 'Ready' -and (Get-Date) -lt $s.AddSeconds(20)){Start-Sleep -m 300}
 if($w.Position.Location.IsUnknown){throw}
 @{lat=$w.Position.Location.Latitude;lon=$w.Position.Location.Longitude;status=$w.Status.ToString()}|ConvertTo-Json -Compress
}catch{ @{status=$(if($w){$w.Status.ToString()}else{'NoSensor'})}|ConvertTo-Json -Compress }
`.replace(/[\r\n]+/g, ' ');

function haversineDistanceKm(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isPlausibleDrift(candidate, candidateSource) {
    if (!lastAcceptedLocation) return true;
    // GPS is authoritative over an IP baseline — the IP city can be hundreds
    // of km away when using a VPN or carrier-level NAT, so a GPS fix that
    // disagrees with a stale IP location is perfectly normal.
    if (candidateSource === 'gps' && lastAcceptedSource === 'ip') return true;
    const distanceKm = haversineDistanceKm(lastAcceptedLocation, candidate);
    if (distanceKm > CONFIG.MAX_LOCATION_DRIFT_KM) {
        logger.warn(
            `Rejected ${candidateSource} reading ${distanceKm.toFixed(1)}km from last known location ` +
            `(threshold ${CONFIG.MAX_LOCATION_DRIFT_KM}km); keeping previous location.`
        );
        return false;
    }
    return true;
}

async function ipGeolocation() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.IP_GEOLOCATION_TIMEOUT_MS);
    try {
        const res = await fetch(CONFIG.IP_GEOLOCATION_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`IP geolocation API ${res.status}`);
        const data = await res.json();
        if (data?.status === 'fail') throw new Error('IP geolocation lookup failed');
        const lat = Number(data?.lat ?? data?.latitude);
        const lon = Number(data?.lon ?? data?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error('IP geolocation response missing coordinates');
        }
        return { latitude: lat, longitude: lon, city: data.city };
    } finally {
        clearTimeout(timeout);
    }
}

function isValidCoord(loc) {
    return Number.isFinite(loc?.latitude) && Number.isFinite(loc?.longitude)
        && (Math.abs(loc.latitude) > 0.01 || Math.abs(loc.longitude) > 0.01);
}

let lastGpsProbeTime = 0;
// GPS probes can block for up to ~20 s (the in-script watcher timeout) on
// machines without a sensor, so rate-limit them. The cooldown is kept just
// under the hourly weather refresh, so every hourly cycle re-validates an
// IP-derived location against the sensor (instantly fixing VPN cases) while
// GPS-less machines only pay the probe cost once per cycle.
const GPS_PROBE_COOLDOWN_MS = 45 * 60 * 1000;

// Last sensor probe outcome — surfaced to the UI so a permanent IP fallback
// explains itself instead of failing silently (sensor missing vs. Windows
// Location turned off vs. still warming up).
let lastProbeAdvice = null;

function probeAdviceForStatus(status) {
    switch (status) {
        case 'Disabled':
            return 'Windows Location is turned off or blocked for desktop apps — enable it under Settings > Privacy & security > Location';
        case 'NoData':
            return 'No location sensor is reporting data on this device (no GPS hardware or no signal)';
        case 'Initializing':
            return 'Location sensor was still starting — will retry automatically';
        case 'NoSensor':
            return 'Windows location API is unavailable on this device';
        default:
            return 'Location sensor returned no fix — will retry automatically';
    }
}

async function findLocation(forceRefresh = false) {
    const now = Date.now();
    const cacheFresh = !forceRefresh && memCache.location
        && (now - memCache.timestamp < CONFIG.LOCATION_CACHE_TTL_MS);

    // A cached GPS fix is authoritative — return it immediately.
    if (cacheFresh && memCache.source === 'gps') {
        return memCache.location;
    }

    // Non-Windows has no GPS sensor: the IP cache stands as-is.
    if (cacheFresh && PLATFORM !== 'win32') {
        return memCache.location;
    }

    let loc = null;
    let source = null;

    // On Windows, always probe the GPS sensor unless we already have a fresh
    // GPS fix (handled above). An IP-derived cache entry — which can be
    // hundreds of km off when the user is on a VPN or carrier NAT — must
    // never blind the sensor. Probing is rate-limited so GPS-less machines
    // aren't stalled for 12 s on every call.
    if (PLATFORM === 'win32' && (forceRefresh || now - lastGpsProbeTime >= GPS_PROBE_COOLDOWN_MS)) {
        lastGpsProbeTime = now;
        try {
            logger.debug('Probing Windows location sensor…');
            const output = await execPowerShell(PS_COMMAND, null);
            const data = JSON.parse(output);
            const lat = Number(data?.lat);
            const lon = Number(data?.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                loc = { latitude: lat, longitude: lon };
                source = 'gps';
                lastProbeAdvice = null;
                logger.info(`Location sensor fix: ${lat.toFixed(4)}, ${lon.toFixed(4)} (${data?.status || 'Ready'})`);
            } else {
                const status = typeof data?.status === 'string' ? data.status : 'unknown';
                lastProbeAdvice = probeAdviceForStatus(status);
                logger.warn(`Location sensor returned no fix (status: ${status}) — ${lastProbeAdvice}`);
            }
        } catch (error) {
            lastProbeAdvice = probeAdviceForStatus('unknown');
            logger.warn(`Location sensor lookup failed: ${error?.message || error} — ${lastProbeAdvice}`);
        }
    }

    // The sensor yielded nothing but the IP cache is still within its shorter
    // TTL — reuse it instead of re-hitting the IP geolocation service.
    if (!loc && cacheFresh && (now - memCache.timestamp < CONFIG.IP_LOCATION_CACHE_TTL_MS)) {
        return memCache.location;
    }

    if (!loc) {
        try {
            loc = await ipGeolocation();
            // Only claim IP if a fix was actually produced — GPS staying null
            // is the "we already know loc is ip-derived" signal.
            if (loc && isValidCoord(loc)) {
                source = 'ip';
                logger.info(`Using IP geolocation (${loc.city || 'unknown city'}) — sensor provided no fix this cycle`);
            }
        } catch (error) {
            logger.warn(`IP geolocation lookup failed: ${error?.message || error}`);
        }
    }

    if (!loc || !isValidCoord(loc)) {
        if (forceRefresh) memCache = { location: null, timestamp: 0, source: null };
        return lastAcceptedLocation || CONFIG.DEFAULT_LOCATION;
    }

    if (!isPlausibleDrift(loc, source)) {
        const fallback = lastAcceptedLocation || CONFIG.DEFAULT_LOCATION;
        // Keep the original accepted source on the cache — do NOT record the
        // rejected fix as our new baseline (fixes state-corruption of drift guard).
        memCache = { location: fallback, timestamp: now, source: lastAcceptedSource || memCache.source };
        return fallback;
    }

    lastAcceptedLocation = loc;
    lastAcceptedSource = source;
    memCache = { location: loc, timestamp: now, source };
    loc._locationSource = source; // stash for the caller so it can show provenance
    return loc;
}

function resetLocationCache() {
    memCache = { location: null, timestamp: 0, source: null };
    lastAcceptedLocation = null;
    lastAcceptedSource = null;
}

async function refreshLocationNow() {
    resetLocationCache();
    return findLocation(true);
}

function getTimeZoneOffsetMs(timeZone, date) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(date).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});
    const asUTC = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    return asUTC - date.getTime();
}

function parseAstroTime(timeStr) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(String(timeStr || ''));
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const meridiem = m[3] ? m[3].toUpperCase() : null;
    if (meridiem === 'AM' && h === 12) h = 0;
    else if (meridiem === 'PM' && h !== 12) h += 12;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, min };
}

async function fetchForecastWithKey(apiKey, query) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

    try {
        const params = new URLSearchParams({
            key: apiKey,
            q: query,
            days: '1',
            aqi: 'no',
            alerts: 'no'
        });

        const res = await fetch(`${CONFIG.WEATHERAPI_URL}?${params}`, { signal: controller.signal });
        return { res };
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchFromOpenMeteo(latitude, longitude) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

    try {
        const params = new URLSearchParams({
            latitude: String(latitude),
            longitude: String(longitude),
            current: 'cloud_cover',
            timezone: 'auto',
            forecast_days: '1',
        });

        const res = await fetch(`${CONFIG.OPEN_METEO_URL}?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchFromApi() {
    const keys = getWeatherApiKeys();
    if (keys.length === 0) {
        throw new Error('WEATHERAPI_KEYS is not configured; skipping live weather lookup.');
    }

    const loc = await findLocation();
    const { latitude, longitude } = loc;
    const query = `${latitude},${longitude}`;

    let lastError = null;
    const usedKeys = new Set();

    // Try several distinct keys before giving up: a rejected, throttled, or
    // flaky key must never sink the whole cycle while others are configured.
    // (Key values are never logged — only their position in the pool.)
    const maxAttempts = Math.min(5, keys.length);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const privateUnused = keys.filter((k) => isPrivateKey(k) && !usedKeys.has(k));
        const apiKey = privateUnused.length > 0 ? privateUnused[0]
            : pickRandomKey(keys.filter((k) => !usedKeys.has(k)), null);
        if (!apiKey) break;
        usedKeys.add(apiKey);
        const keyLabel = `key ${keys.indexOf(apiKey) + 1}/${keys.length}`;

        let res;
        try {
            ({ res } = await fetchForecastWithKey(apiKey, query));
        } catch (err) {
            lastError = err;
            logger.debug(`WeatherAPI ${keyLabel} network failure (${err?.message || err}); trying another key…`);
            continue;
        }
        if (res.status === 401 || res.status === 403 || res.status === 429) {
            lastError = new Error(`WeatherAPI rejected key (HTTP ${res.status})`);
            logger.debug(`WeatherAPI ${keyLabel} rejected (HTTP ${res.status}); trying another key…`);
            continue;
        }
        if (!res.ok) {
            lastError = new Error(`WeatherAPI request failed (HTTP ${res.status})`);
            logger.debug(`WeatherAPI ${keyLabel} failed (HTTP ${res.status}); trying another key…`);
            continue;
        }

        let data;
        try {
            data = await res.json();
        } catch (err) {
            lastError = err;
            logger.debug(`WeatherAPI ${keyLabel} returned an unreadable response; trying another key…`);
            continue;
        }

        const { location, current, forecast } = data;
        const astro = forecast?.forecastday?.[0]?.astro;
        if (!astro || !location?.localtime || !location?.tz_id) {
            lastError = new Error('WeatherAPI response missing forecast astro data');
            logger.debug(`WeatherAPI ${keyLabel} returned an incomplete response; trying another key…`);
            continue;
        }
        const dateDate = location.localtime.split(' ')[0];
        const timeZone = location.tz_id;

        const parseTime = (timeStr) => {
            const parsed = parseAstroTime(timeStr);
            if (!parsed) throw new Error(`Unparseable astro time: ${timeStr}`);
            const naiveUTC = new Date(Date.UTC(
                Number(dateDate.slice(0, 4)),
                Number(dateDate.slice(5, 7)) - 1,
                Number(dateDate.slice(8, 10)),
                parsed.h, parsed.min, 0
            ));
            const offsetMs = getTimeZoneOffsetMs(timeZone, naiveUTC);
            return new Date(naiveUTC.getTime() - offsetMs).toISOString();
        };

        try {
            return {
                sunrise: parseTime(astro.sunrise),
                sunset: parseTime(astro.sunset),
                cloud: typeof current.cloud === 'number' ? current.cloud : 0,
                city: location.name,
                latitude,
                longitude,
                tz_id: timeZone,
                lastUpdated: new Date().toISOString(),
                locationSource: loc._locationSource || memCache.source || null,
            };
        } catch (err) {
            lastError = err;
            logger.debug(`WeatherAPI ${keyLabel} response failed to parse (${err?.message || err}); trying another key…`);
            continue;
        }
    }

    if (lastError) throw lastError;
    throw new Error('WeatherAPI request failed');
}

async function calculateFromCache() {
    const saved = await loadJSON(WEATHER_JSON_PATH, null);
    if (!saved || typeof saved !== 'object') throw new Error("No Cache");

    // The persisted file may carry IP-derived (VPN) coordinates from a run
    // where GPS hadn't locked yet. Prefer the freshest in-memory GPS fix so
    // sunrise/sunset and the recorded lat/lon track the sensor even when the
    // live weather APIs are unreachable — no extra probes on a failing network.
    const useGPS = lastAcceptedSource === 'gps' && isValidCoord(lastAcceptedLocation);
    const latitude  = useGPS ? lastAcceptedLocation.latitude : (Number.isFinite(saved.latitude)  ? saved.latitude  : 0);
    const longitude = useGPS ? lastAcceptedLocation.longitude : (Number.isFinite(saved.longitude) ? saved.longitude : 0);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("No Cache");

    const times = SunCalc.getTimes(new Date(), latitude, longitude);

    return {
        ...saved,
        sunrise: times.sunrise.toISOString(),
        sunset: times.sunset.toISOString(),
        lastUpdated: saved.lastUpdated,
        latitude,
        longitude,
        ...(useGPS ? { locationSource: 'gps' } : {}),
    };
}

function getFallbackTimes() {
    const now = new Date();
    const setHour = (h, m = 0) => {
        const d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString();
    };

    return {
        sunrise: setHour(DEFAULT_SUNRISE.h, DEFAULT_SUNRISE.m),
        sunset: setHour(DEFAULT_SUNSET.h, DEFAULT_SUNSET.m),
        cloud: 0,
        city: 'Unknown',
        latitude: CONFIG.DEFAULT_LOCATION.latitude,
        longitude: CONFIG.DEFAULT_LOCATION.longitude,
        tz_id: 'UTC',
        lastUpdated: now.toISOString(),
    };
}

async function updateDailyWeatherInfo(userSettings = {}) {
    if (userSettings?.method === 'custom') {
        const { sunrise: s, sunset: n } = userSettings.custom || {};
        const now = new Date();
        const setTime = (h, m) => {
            const d = new Date(now); d.setHours(h ?? DEFAULT_SUNRISE.h, m ?? 0, 0, 0); return d.toISOString();
        };

        return {
            isCustom: true,
            sunrise: setTime(s?.h ?? DEFAULT_SUNRISE.h, s?.m ?? DEFAULT_SUNRISE.m),
            sunset: setTime(n?.h ?? DEFAULT_SUNSET.h, n?.m ?? DEFAULT_SUNSET.m),
            cloud: 0,
            city: 'Custom',
            latitude: null,
            longitude: null,
            lastUpdated: now.toISOString(),
        };
    }

    // Try sources in order: WeatherAPI (with keys), Open-Meteo (free, no key), cached suncalc, defaults
    let result = null;
    let source = 'unknown';
    let locRef = null;

    try {
        result = await retry(fetchFromApi, 2, 500);
        source = 'weatherapi';
        // findLocation ran inside fetchFromApi — its coordinates were cached,
        // so we can't pull locRef._locationSource directly; fall back to the
        // cache source (gps / ip) recorded by findLocation itself.
        locRef = { _locationSource: memCache.source || lastAcceptedSource || null };
    } catch (e) {
        logger.debug(`WeatherAPI failed: ${e.message}`);
    }

    if (!result) {
        try {
            locRef = await findLocation();
            const { latitude, longitude } = locRef;
            if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
                const om = await fetchFromOpenMeteo(latitude, longitude);
                const cloud = om?.current?.cloud_cover ?? 0;
                const times = SunCalc.getTimes(new Date(), latitude, longitude);
                result = {
                    sunrise: times.sunrise.toISOString(),
                    sunset: times.sunset.toISOString(),
                    cloud: typeof cloud === 'number' ? cloud : 0,
                    city: 'Open-Meteo',
                    latitude,
                    longitude,
                    tz_id: om?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                    lastUpdated: new Date().toISOString(),
                    locationSource: locRef._locationSource || memCache.source || null,
                };
                source = 'open-meteo';
            }
        } catch (e) {
            logger.debug(`Open-Meteo failed: ${e.message}`);
        }
    }

    if (!result) {
        try {
            result = await calculateFromCache();
            source = 'cached-suncalc';
        } catch (e) {
            logger.debug(`Cached suncalc failed: ${e.message}`);
        }
    }

    if (!result) {
        result = getFallbackTimes();
        source = 'default';
    }

    result._source = source;
    // Pull the per-call location source (gps / ip) from whichever findLocation
    // call produced the coordinates used.  If the path never called findLocation
    // (cached-suncalc / default fallback) the field simply stays undefined.
    if (locRef && locRef._locationSource) result.locationSource = locRef._locationSource;
    // When the sensor lost and IP won, explain why so the UI can show the
    // reason instead of a bare "IP" badge.
    if (result.locationSource && result.locationSource !== 'gps' && lastProbeAdvice) {
        result.locationDetail = lastProbeAdvice;
    }
    return result;
}

module.exports = { updateDailyWeatherInfo, refreshLocationNow, getLocationDiagnostic: () => lastProbeAdvice };