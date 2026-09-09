// weather.js

const SunCalc = require('suncalc');
const { loadJSON, retry, WEATHER_JSON_PATH, DEFAULT_SUNRISE, DEFAULT_SUNSET, PLATFORM, execPowerShell } = require('./core');

const CONFIG = {
    API_URL: 'https://api.weatherapi.com/v1/forecast.json',
    IP_GEOLOCATION_URL: 'https://ipapi.co/json/',
    DEFAULT_LOCATION: { latitude: 0, longitude: 0 },
    LOCATION_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
    MAX_LOCATION_DRIFT_KM: 50,
    POWERSHELL_TIMEOUT_MS: 10000,
    API_TIMEOUT_MS: 8000,
    IP_GEOLOCATION_TIMEOUT_MS: 5000,
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
    timestamp: 0
};

let lastAcceptedLocation = null;

const PS_COMMAND = `
$ErrorActionPreference='Stop';
try{
 Add-Type -AssemblyName System.Device;
 $w=New-Object System.Device.Location.GeoCoordinateWatcher;
 $w.Start();
 $s=Get-Date;
 while($w.Status-ne'Ready'-and(Get-Date)-lt $s.AddSeconds(5)){Start-Sleep -m 200}
 if($w.Position.Location.IsUnknown){throw}
 @{lat=$w.Position.Location.Latitude;lon=$w.Position.Location.Longitude}|ConvertTo-Json -Compress
}catch{Write-Output "{}"}
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

function isPlausibleDrift(candidate) {
    if (!lastAcceptedLocation) return true;
    const distanceKm = haversineDistanceKm(lastAcceptedLocation, candidate);
    if (distanceKm > CONFIG.MAX_LOCATION_DRIFT_KM) {
        console.warn(
            `Rejected GPS reading ${distanceKm.toFixed(1)}km from last known location ` +
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
        const lat = Number(data?.latitude);
        const lon = Number(data?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error('IP geolocation response missing coordinates');
        }
        return { latitude: lat, longitude: lon };
    } finally {
        clearTimeout(timeout);
    }
}

async function findLocation() {
    const now = Date.now();
    if (memCache.location && (now - memCache.timestamp < CONFIG.LOCATION_CACHE_TTL_MS)) {
        return memCache.location;
    }

    let loc = null;

    if (PLATFORM === 'win32') {
        try {
            const output = await execPowerShell(PS_COMMAND, CONFIG.POWERSHELL_TIMEOUT_MS);
            const data = JSON.parse(output);
            if (data && data.lat) loc = { latitude: data.lat, longitude: data.lon };
        } catch (error) {
        }
    }

    if (!loc) {
        try {
            loc = await ipGeolocation();
        } catch (error) {
        }
    }

    if (!loc) {
        return lastAcceptedLocation || CONFIG.DEFAULT_LOCATION;
    }

    if (!isPlausibleDrift(loc)) {
        const fallback = lastAcceptedLocation || CONFIG.DEFAULT_LOCATION;
        memCache = { location: fallback, timestamp: now };
        return fallback;
    }

    lastAcceptedLocation = loc;
    memCache = { location: loc, timestamp: now };
    return loc;
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

        const res = await fetch(`${CONFIG.API_URL}?${params}`, { signal: controller.signal });
        return { res };
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchFromApi() {
    const keys = getWeatherApiKeys();
    if (keys.length === 0) {
        throw new Error('WEATHERAPI_KEYS is not configured; skipping live weather lookup.');
    }

    const { latitude, longitude } = await findLocation();
    const query = `${latitude},${longitude}`;

    let lastError = null;
    let attemptedKey = null;
    const usedKeys = new Set();

    for (let attempt = 0; attempt < Math.min(3, keys.length); attempt++) {
        const privateUnused = keys.filter((k) => isPrivateKey(k) && !usedKeys.has(k));
        const apiKey = privateUnused.length > 0 ? privateUnused[0]
            : pickRandomKey(keys.filter((k) => !usedKeys.has(k)), null);
        if (!apiKey) break;
        usedKeys.add(apiKey);
        attemptedKey = apiKey;

        let res;
        try {
            ({ res } = await fetchForecastWithKey(apiKey, query));
        } catch (err) {
            lastError = err;
            continue;
        }
        if (res.status === 401 || res.status === 403 || res.status === 429) {
            lastError = new Error(`WeatherAPI rejected key (HTTP ${res.status})`);
            continue;
        }
        if (res.status >= 500) {
            lastError = new Error(`WeatherAPI server error (HTTP ${res.status})`);
            continue;
        }
        if (!res.ok) throw new Error(`API ${res.status}`);

        const data = await res.json();

        const { location, current, forecast } = data;
        const astro = forecast?.forecastday?.[0]?.astro;
        if (!astro) throw new Error('WeatherAPI response missing forecast astro data');
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

        return {
            sunrise: parseTime(astro.sunrise),
            sunset: parseTime(astro.sunset),
            cloud: typeof current.cloud === 'number' ? current.cloud : 0,
            city: location.name,
            latitude,
            longitude,
            tz_id: timeZone,
            lastUpdated: new Date().toISOString(),
        };
    }

    if (lastError) throw lastError;
    throw new Error('WeatherAPI request failed');
}

async function calculateFromCache() {
    const saved = await loadJSON(WEATHER_JSON_PATH, null);
    if (!Number.isFinite(saved?.latitude) || !Number.isFinite(saved?.longitude)) throw new Error("No Cache");

    const times = SunCalc.getTimes(new Date(), saved.latitude, saved.longitude);

    return {
        ...saved,
        sunrise: times.sunrise.toISOString(),
        sunset: times.sunset.toISOString(),
        lastUpdated: saved.lastUpdated
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
            lastUpdated: new Date().toISOString(),
        };
    }

    try {
        return { isCustom: false, ...(await retry(fetchFromApi, 2, 500)) };
    } catch (e) {
        try {
            return { isCustom: false, ...(await calculateFromCache()) };
        } catch (e2) {
            return getFallbackTimes();
        }
    }
}

module.exports = { updateDailyWeatherInfo };