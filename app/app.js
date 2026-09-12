// app.js — Electron main process (entry point; loads .env first).
// To build a distributable, use one of the packaging scripts in package.json,
// e.g. `npm run dist:win` / `npm run dist:mac` / `npm run dist:linux`.

require('dotenv').config();

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, dialog, shell, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { loadJSON, saveJSON, defaultSettings, sanitizeSettings, settingsPath, ICON_PATH, ICON_PNG_PATH, WEATHER_JSON_PATH, execAsync } = require('../core');

const { updateDailyWeatherInfo } = require('../weather');
const BrightnessManager = require('../BrightnessManager');
const { shutdownWebcamWorker, resolveCaptureBackendInfo, listCameras } = require('../webcam');
const { getBrightnessBackendName, getActiveWindowSafe, getPowerStatus, listDisplays } = require('../signals');

const UPDATE_STATUS_INTERVAL_MS = 5000;
const WEATHER_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const REPO_OWNER = 'shahk70';
const REPO_NAME = 'luxlearn';

let autoUpdater = null;
try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;
    autoUpdater.on('update-available', (info) => {
        sendToMainWindow('update-available', {
            version: info.version,
            url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${info.version}`,
            notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
            source: 'electron-updater',
        });
    });
    autoUpdater.on('update-not-available', () => {
        sendToMainWindow('update-none', { checkedAt: Date.now() });
    });
    autoUpdater.on('error', (err) => {
        console.warn('Auto-update error:', err && err.message);
    });
    autoUpdater.on('download-progress', (p) => {
        sendToMainWindow('update-download-progress', {
            percent: Math.round(p.percent || 0),
            bytesPerSecond: p.bytesPerSecond || 0,
        });
    });
    autoUpdater.on('update-downloaded', (info) => {
        state.updateDownloaded = true;
        sendToMainWindow('update-downloaded', { version: info.version });
    });
} catch (err) {
    console.warn('electron-updater unavailable, falling back to notify-only checks:', err.message);
}

let mainWindow;
let tray = null;
let brightnessManager = null;
let statusUpdateInterval = null;
app.isQuitting = false;

const state = {
    settings: { ...defaultSettings },
    weather: {},
    lastAdjustment: null,
    availableUpdate: null,
};

if (process.platform === 'win32') app.setAppUserModelId('SKR.LuxLearn');

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception in main process:', error);
    try {
        dialog.showErrorBox('Unexpected Error', `Auto Brightness hit an unexpected error and may be unstable:\n${error.message}`);
    } catch (e) { /* dialog module may not be ready yet */ }
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in main process:', reason);
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.whenReady().then(async () => {
        if (process.platform === 'darwin' && app.dock) app.dock.hide();
        createTray();
        createWindow();
        setTimeout(initializeLogic, 100);
        startUpdateChecks((update) => {
            state.availableUpdate = update;
            sendToMainWindow('update-available', update);
        });
    });
}

const timeFormatter = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
const formatTime = (d) => {
    if (!d) return 'N/A';
    const date = d instanceof Date ? d : new Date(d);
    return isNaN(date.getTime()) ? 'N/A' : timeFormatter.format(date);
};

function getAppIcon() {
    const iconPath = process.platform === 'win32' ? ICON_PATH : ICON_PNG_PATH;
    try {
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) {
            if (process.platform === 'darwin') {
                img.setTemplateImage(true);
                return img.resize({ width: 16, height: 16 });
            }
            return img;
        }
    } catch { }
    return nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
}

function sendToMainWindow(channel, ...args) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
    }
}

const DEFAULT_ACTIVITY_SETTINGS = {
    gaming: { enabled: false },
    video: { enabled: false },
    custom: []
};

const VIDEO_PROCESSES = ['vlc', 'mpv', 'potplayer', 'netflix', 'disney', 'prime video', 'youtube', 'twitch', 'plex', 'kodi', 'movies', 'tv'];
const GAME_HINTS = ['game', 'steam', 'epic', 'origin', 'uplay', 'riot', 'battle.net', 'minecraft', 'roblox'];

function normalizeActivities(raw) {
    const base = { ...DEFAULT_ACTIVITY_SETTINGS, custom: Array.isArray(raw?.custom) ? raw.custom : [] };
    base.gaming = { enabled: raw?.gaming?.enabled === true };
    base.video = { enabled: raw?.video?.enabled === true };
    base.custom = base.custom.map((a, i) => ({
        id: typeof a?.id === 'string' ? a.id : 'custom-' + i + '-' + Date.now(),
        name: String(a?.name || 'Activity').slice(0, 60),
        matchType: a?.matchType === 'title' ? 'title' : 'process',
        value: String(a?.value || '').slice(0, 120),
        enabled: a?.enabled === true,
    })).filter(a => a.value.trim().length > 0);
    return base;
}

function activityMatchesWindow(activities, win) {
    const title = (win?.title || '').toLowerCase();
    const processName = (win?.name || '').toLowerCase();
    const isFullscreenLike = win?.bounds
        ? win.bounds.width >= (screen.getPrimaryDisplay().workAreaSize.width - 20)
        : false;

    if (activities.gaming.enabled) {
        const hint = GAME_HINTS.some(h => processName.includes(h) || title.includes(h));
        if (hint && isFullscreenLike) return 'Gaming';
    }
    if (activities.video.enabled) {
        if (VIDEO_PROCESSES.some(v => processName.includes(v)) && isFullscreenLike) return 'Watching Video';
    }
    for (const a of activities.custom) {
        if (!a.enabled) continue;
        if (a.matchType === 'process' && processName.includes(a.value.toLowerCase())) return a.name;
        if (a.matchType === 'title' && title.includes(a.value.toLowerCase())) return a.name;
    }
    return null;
}

let activityPauseLabel = null;

let initRetryCount = 0;
const MAX_INIT_RETRIES = 3;

async function initializeLogic() {
    try {
        const [loadedSettings, loadedWeather] = await Promise.all([
            loadJSON(settingsPath, defaultSettings),
            loadJSON(WEATHER_JSON_PATH, {}),
        ]);

        state.settings = sanitizeSettings(loadedSettings, defaultSettings);
        state.weather = loadedWeather;

        console.log('--- Brightness Manager Starting ---');
        brightnessManager = new BrightnessManager(state.settings);

        brightnessManager.on('log', (logData) => sendToMainWindow('log-update', logData));
        brightnessManager.on('adjustment', () => {
            state.lastAdjustment = Date.now();
            sendDynamicStatusUpdate();
        });
        brightnessManager.on('timerReset', () => {
            state.lastAdjustment = Date.now();
            updateTrayMenu();
            sendDynamicStatusUpdate();
        });
        brightnessManager.on('brightnessChanged', sendDynamicStatusUpdate);
        brightnessManager.on('readingsUpdated', sendDynamicStatusUpdate);

        await brightnessManager.initialize();
        brightnessManager.updateWeatherInfo(state.weather);
        sendDynamicStatusUpdate();

        updateTrayMenu();
        updateLoginItemSettings();

        // One-time follow-up for users who ticked "pin to taskbar" in the
        // installer: Windows refuses silent pinning, so surface how to do it.
        checkTaskbarPinRequest().then((result) => {
            if (result?.pinHint && mainWindow) {
                sendToMainWindow('pin-hint', {});
            }
        });

        setTimeout(() => refreshWeatherData(true), 15000).unref();
        setInterval(refreshWeatherData, WEATHER_REFRESH_INTERVAL_MS).unref();

        if (mainWindow) {
            sendWeatherUpdateToUI();
            sendToMainWindow('settings-updated', {
                settings: state.settings,
                learningConfig: brightnessManager?.learningConfig || {},
            });
        }

        setTimeout(() => {
            computeOsSupport().then((osSupport) => {
                sendToMainWindow('os-support-update', osSupport);
            });
        }, 12000).unref();

    } catch (error) {
        console.error('FATAL:', error);
        initRetryCount++;
        if (initRetryCount <= MAX_INIT_RETRIES) {
            console.warn(`Retrying initialization (${initRetryCount}/${MAX_INIT_RETRIES})...`);
            setTimeout(initializeLogic, 2000 * initRetryCount);
            return;
        }
        dialog.showErrorBox(
            'Initialization Error',
            'Auto Brightness failed to start after several attempts.\nCheck logs, then restart the app.'
        );
    }
}

async function refreshWeatherData(isInitialLoad = false) {
    const lastUpdated = state.weather?.lastUpdated ? new Date(state.weather.lastUpdated).getTime() : 0;
    if (!isInitialLoad && Date.now() - lastUpdated < 3600000) return;

    try {
        const newWeatherInfo = await updateDailyWeatherInfo(state.settings);
        if (newWeatherInfo) {
            state.weather = newWeatherInfo;
            brightnessManager?.updateWeatherInfo(state.weather);
            if (mainWindow) sendWeatherUpdateToUI();
            saveJSON(WEATHER_JSON_PATH, newWeatherInfo);
        }
    } catch (error) {
        console.error("Weather refresh failed:", error);
    }
}

function sendWeatherUpdateToUI() {
    const { city, sunrise, sunset, lastUpdated } = state.weather || {};
    sendToMainWindow('weather-update', {
        city: city || 'Unknown',
        sunrise: formatTime(sunrise),
        sunset: formatTime(sunset),
        lastUpdated: lastUpdated || 'Unknown'
    });
}

let dynamicStatusPending = false;
function sendDynamicStatusUpdate() {
    if (!brightnessManager || dynamicStatusPending) return;
    dynamicStatusPending = true;

    setImmediate(() => {
        dynamicStatusPending = false;
        const status = brightnessManager.getCurrentStatus();
        const { logLimit, autoBrightMin, autoEnabled } = state.settings;

        let nextTime = 'N/A';
        const learningPaused = status.isLearningComplete === false
            && state.settings.adjustDuringLearning === false;
        if (status.manualOverrideUntil && status.manualOverrideUntil > Date.now()) {
            nextTime = formatTime(new Date(status.manualOverrideUntil));
        } else if (learningPaused) {
            nextTime = 'Waiting for learning';
        } else if (state.lastAdjustment) {
            const scheduledNext = state.lastAdjustment + (autoBrightMin * 60000);
            nextTime = formatTime(new Date(scheduledNext));
        }

        sendToMainWindow('dynamic-status-update', {
            brightness: status.currentBrightness,
            learningPhase: status.learningPhase,
            logsRecorded: status.logCount,
            logLimit,
            autoEnabled,
            nextAdjustment: nextTime,
            isLearningComplete: status.isLearningComplete,
            automationConfidence: status.automationConfidence,
            ambientLightSensorAvailable: status.ambientLightSensorAvailable,
            ...(status.lastPowerSource !== null && { powerSource: status.lastPowerSource }),
            ...(status.lastBatteryLevel !== null && { batteryLevel: status.lastBatteryLevel }),
            ...(status.lastNightLight !== null && { nightLight: status.lastNightLight }),
            lightMode: status.lightMode,
            deviceWeak: status.deviceWeak,
            manualOverrideUntil: status.manualOverrideUntil,
            currentWeights: status.currentWeights,
            interactionPair: status.interactionPair,
        });
    });
}

async function persistAndApplySettings(newSettings) {
    try {
        const oldAutoEnabled = state.settings.autoEnabled;
        const merged = sanitizeSettings({ ...state.settings, ...newSettings }, state.settings);
        state.settings = merged;

        await Promise.all([
            saveJSON(settingsPath, state.settings),
            brightnessManager?.updateSettings(state.settings)
        ]);

        if (state.settings.autoEnabled && !oldAutoEnabled) {
            state.lastAdjustment = Date.now();
        }
        sendDynamicStatusUpdate();

        updateLoginItemSettings();

        const updateData = {
            settings: state.settings,
            learningConfig: brightnessManager?.learningConfig || {}
        };

        sendToMainWindow('settings-updated', updateData);
        updateTrayMenu();
        return { success: true, ...updateData };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function setLinuxAutostart(enabled) {
    try {
        const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        const autostartDir = path.join(configHome, 'autostart');
        const desktopFile = path.join(autostartDir, 'luxlearn.desktop');
        if (!enabled) {
            await fs.unlink(desktopFile).catch(() => { });
            return;
        }
        await fs.mkdir(autostartDir, { recursive: true });
        const execPath = process.env.APPIMAGE || process.execPath;
        const contents = [
            '[Desktop Entry]',
            'Type=Application',
            'Version=1.0',
            'Name=LuxLearn',
            'Comment=Automatic screen brightness',
            `Exec=${execPath} --hidden`,
            'X-GNOME-Autostart-enabled=true',
            'NoDisplay=true',
            '',
        ].join('\n');
        await fs.writeFile(desktopFile, contents, 'utf8');
    } catch (err) {
        console.error('Failed to update Linux autostart entry:', err.message);
    }
}

function updateLoginItemSettings() {
    if (process.platform === 'win32') {
        // Single Run-key name shared with the installer; previously the app
        // registered under the AUMID ("SKR.LuxLearn") while the installer
        // wrote "LuxLearn", leaving two startup entries per update.
        app.setLoginItemSettings({
            openAtLogin: state.settings.startWithSystem,
            name: 'LuxLearn',
            args: ['--hidden']
        });
        removeLegacyLoginItems();
        return;
    }
    app.setLoginItemSettings({
        openAtLogin: state.settings.startWithSystem,
        openAsHidden: true,
        args: ['--hidden']
    });
    if (process.platform === 'linux') {
        setLinuxAutostart(state.settings.startWithSystem);
    }
}

function removeLegacyLoginItems() {
    try {
        const names = new Set((app.getLoginItemSettings().launchItems || []).map((i) => i.name));
        for (const legacy of ['SKR.LuxLearn', 'SKR.AutoBright']) {
            if (names.has(legacy)) app.setLoginItemSettings({ openAtLogin: false, name: legacy });
        }
    } catch { /* best effort */ }
}

const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const CAMERA_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera';

async function getPermissionState() {
    const screen = systemPreferences.getMediaAccessStatus('screen');
    const camera = systemPreferences.getMediaAccessStatus('camera');
    return { screen, camera };
}

async function ensureCameraAccess() {
    const { camera } = await getPermissionState();
    if (camera === 'granted') return camera;
    if (camera !== 'not-determined') return camera;
    try {
        return await systemPreferences.askForMediaAccess('camera');
    } catch {
        return 'denied';
    }
}

function openScreenRecordingSettings() {
    shell.openExternal(SCREEN_SETTINGS_URL).catch(() => { });
}

function openCameraSettings() {
    shell.openExternal(CAMERA_SETTINGS_URL).catch(() => { });
}

const getMacPermissionsModule = () => process.platform === 'darwin'
    ? { getPermissionState, ensureCameraAccess, openScreenRecordingSettings, openCameraSettings }
    : false;

async function computeOsSupport() {
    const warnings = [];
    let brightnessBackend = null;
    let webcamBackend = null;
    let permissions = null;

    try { brightnessBackend = await getBrightnessBackendName(); } catch { }
    try { webcamBackend = await resolveCaptureBackendInfo(); } catch { }

    if (brightnessBackend === null) {
        const hint = process.platform === 'win32'
            ? 'No brightness backend found. WMI/CIM need an internal laptop display; external monitors need DDC/CI support.'
            : process.platform === 'linux'
                ? "No brightness backend found. Install one of: brightnessctl (recommended, works on Wayland), light, ddcutil, xrandr."
                : "No brightness backend found. Install one of: brew install brightness, brew install m1ddc, brew install ddcctl";
        warnings.push({ id: 'brightness-backend', message: hint, action: null });
    } else if (process.platform === 'win32' && brightnessBackend === 'DDC/CI') {
        warnings.push({
            id: 'external-display',
            message: 'Using DDC/CI for external monitor brightness. If controls feel slow, check your monitor OSD for DDC/CI enable.',
            action: null,
        });
    } else if (process.platform === 'linux' && brightnessBackend === 'xrandr') {
        warnings.push({
            id: 'wayland',
            message: 'Only xrandr is available: brightness changes are software gamma in X11 and will not work on Wayland.',
            action: null,
        });
    }

    if (webcamBackend === null) {
        const hint = process.platform === 'win32'
            ? 'Webcam capture tool not found (CommandCam.exe should be bundled, or install ffmpeg). Webcam signals disabled.'
            : process.platform === 'linux'
                ? "Webcam capture tool not found. Install fswebcam (e.g. sudo apt install fswebcam) or ffmpeg. Webcam signals disabled."
                : "Webcam capture tool not found. Install imagesnap (brew install imagesnap) or ffmpeg. Webcam signals disabled.";
        warnings.push({ id: 'webcam-backend', message: hint, action: null });
    }

    const macPerms = getMacPermissionsModule();
    if (macPerms) {
        try {
            permissions = await macPerms.getPermissionState();
            if (permissions.screen && permissions.screen !== 'granted' && permissions.screen !== 'restricted') {
                warnings.push({
                    id: 'screen-permission',
                    message: 'Screen sampling is disabled: grant Screen Recording to LuxLearn in System Settings.',
                    action: 'open-screen-settings',
                });
            }
            if (permissions.camera === 'denied' || permissions.camera === 'restricted') {
                warnings.push({
                    id: 'camera-permission',
                    message: 'Webcam sampling is blocked: grant Camera access to LuxLearn in System Settings.',
                    action: 'open-camera-settings',
                });
            }
        } catch { }
    }

    return { platform: process.platform, brightnessBackend, webcamBackend, permissions, warnings };
}

ipcMain.handle('save-settings', (_, s) => persistAndApplySettings(s));
ipcMain.handle('load-settings', () => state.settings);
ipcMain.handle('load-learning-config', () => brightnessManager?.learningConfig || {});
ipcMain.handle('reset-settings', async () => {
    brightnessManager?.restartLearningPhase();
    return persistAndApplySettings({ ...defaultSettings });
});
ipcMain.handle('get-username', () => os.userInfo().username || 'User');
ipcMain.handle('get-os-support', () => computeOsSupport());
ipcMain.handle('get-brightness-backend', () => getBrightnessBackendName().catch(() => null));
ipcMain.handle('open-logs-folder', () => { shell.openPath(path.dirname(settingsPath)); return { success: true }; });
ipcMain.handle('open-settings-file', () => { shell.showItemInFolder(settingsPath); return { success: true }; });
ipcMain.handle('get-power-status', () => getPowerStatus().catch(() => null));
ipcMain.handle('list-cameras', () => listCameras().catch(() => []));
ipcMain.handle('list-displays', () => listDisplays().catch(() => []));

const RELEASES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const REQUEST_TIMEOUT_MS = 8000;

function parseVersion(v) {
    return String(v)
        .trim()
        .replace(/^v/i, '')
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
}

function isNewer(remoteVersion, localVersion) {
    const remote = parseVersion(remoteVersion);
    const local = parseVersion(localVersion);
    const len = Math.max(remote.length, local.length);
    for (let i = 0; i < len; i++) {
        const r = remote[i] || 0;
        const l = local[i] || 0;
        if (r > l) return true;
        if (r < l) return false;
    }
    return false;
}

async function checkForUpdates() {
    if (!REPO_OWNER || REPO_OWNER === 'your-github-username') {
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const res = await fetch(RELEASES_API, {
            signal: controller.signal,
            headers: {
                'User-Agent': `${REPO_NAME}-update-checker`,
                Accept: 'application/vnd.github+json',
            },
        });
        if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);

        const data = await res.json();
        const latestTag = data.tag_name || data.name;
        if (!latestTag) return null;

        const currentVersion = app.getVersion();
        if (!isNewer(latestTag, currentVersion)) return null;

        return {
            version: latestTag,
            url: data.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
            notes: data.body || '',
        };
    } catch (error) {
        console.warn('Update check failed:', error.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function startUpdateChecks(onUpdateAvailable) {
    const run = async () => {
        try {
            if (autoUpdater) {
                await autoUpdater.checkForUpdates().catch((err) => {
                    console.warn('electron-updater tick failed:', err && err.message);
                    return checkForUpdates().then((u) => { if (u) onUpdateAvailable(u); });
                });
                return;
            }
            const update = await checkForUpdates();
            if (update) onUpdateAvailable(update);
        } catch (err) {
            console.warn('Update check tick failed:', err.message);
        }
    };

    run();
    const interval = setInterval(run, CHECK_INTERVAL_MS);
    if (interval.unref) interval.unref();
    return () => clearInterval(interval);
}

ipcMain.handle('activities:get', () => normalizeActivities(state.settings.activities));
ipcMain.handle('activities:set', (_, raw) => {
    const current = normalizeActivities(state.settings.activities);
    const merged = { ...current };
    if (raw && typeof raw === 'object') {
        if ('gaming' in raw) merged.gaming = { enabled: raw.gaming?.enabled === true };
        if ('video' in raw) merged.video = { enabled: raw.video?.enabled === true };
        if ('custom' in raw) merged.custom = raw.custom;
    }
    state.settings.activities = normalizeActivities(merged);
    persistAndApplySettings(state.settings);
    return { success: true, activities: state.settings.activities };
});
ipcMain.handle('activity:add', (_, activity) => {
    const list = normalizeActivities(state.settings.activities);
    const entry = {
        id: 'custom-' + Date.now(),
        name: String(activity?.name || '').trim().slice(0, 60) || 'Activity',
        matchType: activity?.matchType === 'title' ? 'title' : 'process',
        value: String(activity?.value || '').trim().slice(0, 120),
        enabled: true,
    };
    if (!entry.value) return { success: false, error: 'empty-value' };
    list.custom.push(entry);
    state.settings.activities = list;
    persistAndApplySettings(state.settings);
    return { success: true, activities: list };
});
ipcMain.handle('activity:update', (_, { id, patch }) => {
    const list = normalizeActivities(state.settings.activities);
    const item = list.custom.find(a => a.id === id);
    if (!item) return { success: false, error: 'not-found' };
    if (typeof patch?.name === 'string' && patch.name.trim()) item.name = patch.name.trim().slice(0, 60);
    if (typeof patch?.value === 'string' && patch.value.trim()) item.value = patch.value.trim().slice(0, 120);
    if (patch?.matchType) item.matchType = patch.matchType === 'title' ? 'title' : 'process';
    if (typeof patch?.enabled === 'boolean') item.enabled = patch.enabled;
    state.settings.activities = list;
    persistAndApplySettings(state.settings);
    return { success: true, activities: list };
});
ipcMain.handle('activity:delete', (_, id) => {
    const list = normalizeActivities(state.settings.activities);
    list.custom = list.custom.filter(a => a.id !== id);
    state.settings.activities = list;
    persistAndApplySettings(state.settings);
    return { success: true, activities: list };
});
ipcMain.handle('activity:check-window', async () => {
    try {
        const win = await getActiveWindowSafe();
        const activities = normalizeActivities(state.settings.activities);
        const label = win ? activityMatchesWindow(activities, win) : null;
        const wasLabel = activityPauseLabel;
        activityPauseLabel = label;

        if (label && brightnessManager && brightnessManager.manualOverrideUntil < Date.now()) {
            if (label !== wasLabel) {
                brightnessManager.pauseAdjustments(60 * 60 * 1000);
                sendDynamicStatusUpdate();
                updateTrayMenu();
            }
        } else if (!label && wasLabel && brightnessManager) {
            brightnessManager.resumeAdjustments();
            sendDynamicStatusUpdate();
            updateTrayMenu();
        }
        return { label };
    } catch {
        return { label: activityPauseLabel };
    }
});

ipcMain.handle('about:get-version', () => app.getVersion());

// Windows blocks silent taskbar pinning from installers (the "pin to
// taskbar" verb rejects non-explorer callers since 1809; copying .lnk
// files into User Pinned no longer sticks; WinRT TaskbarManager needs the
// app itself foregrounded with user consent). So the installer checkbox
// records intent in the registry, and on the next foreground start the
// app shows a one-time hint pointing at the running icon instead of
// pretending to pin. Flag is cleared either way so it never nags.
function checkTaskbarPinRequest() {
    if (process.platform !== 'win32') return Promise.resolve(null);
    return new Promise((resolve) => {
        execAsync('reg query "HKCU\\Software\\LuxLearn" /v PinToTaskbarRequested', { windowsHide: true })
            .then(({ stdout }) => resolve(/\bPinToTaskbarRequested\s+REG_SZ\s+1/.test(stdout) ? true : null))
            .catch(() => resolve(null));
    }).then((requested) => {
        if (!requested) return null;
        execAsync('reg delete "HKCU\\Software\\LuxLearn" /v PinToTaskbarRequested /f', { windowsHide: true }).catch(() => { });
        return { pinHint: true };
    });
}

ipcMain.handle('about:check-updates', async () => {
    try {
        if (autoUpdater) {
            try {
                const result = await autoUpdater.checkForUpdates();
                const info = result && result.updateInfo;
                if (info && isNewer(info.version, app.getVersion())) {
                    const update = {
                        version: `v${info.version}`,
                        url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${info.version}`,
                        notes: (Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note).join('\n') : info.releaseNotes) || '',
                    };
                    state.availableUpdate = update;
                    sendToMainWindow('update-available', update);
                    return { available: true, version: update.version, url: update.url };
                }
                return { available: false };
            } catch (updaterErr) {
                console.warn('electron-updater check failed, trying notify-only check:', updaterErr.message);
            }
        }
        const update = await checkForUpdates();
        if (update) {
            state.availableUpdate = update;
            sendToMainWindow('update-available', update);
            return { available: true, version: update.version, url: update.url };
        }
        return { available: false };
    } catch (err) {
        return { available: false, error: err.message };
    }
});

ipcMain.handle('about:download-update', async () => {
    if (!autoUpdater) return { success: false, error: 'updater-unavailable' };
    try {
        await autoUpdater.downloadUpdate();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('about:install-update', () => {
    if (!autoUpdater) return { success: false, error: 'updater-unavailable' };
    try {
        app.isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
        return { success: true };
    } catch (err) {
        app.isQuitting = false;
        console.warn('quitAndInstall failed:', err && err.message);
        return { success: false, error: 'nothing-downloaded' };
    }
});

function buildExportPayload() {
    return {
        format: 'auto-bright-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        settings: sanitizeSettings(state.settings, defaultSettings),
        learningConfig: brightnessManager?.learningConfig || {},
        logs: brightnessManager?.logs || [],
        activities: normalizeActivities(state.settings.activities),
    };
}

function validateImportPayload(data) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'not-an-object' };
    if (data.format !== 'auto-bright-export') return { ok: false, reason: 'unknown-format' };
    if (typeof data.version !== 'number' || data.version < 1 || data.version > 1) return { ok: false, reason: 'unsupported-version' };
    if (data.settings && typeof data.settings !== 'object') return { ok: false, reason: 'bad-settings' };
    if (data.logs && !Array.isArray(data.logs)) return { ok: false, reason: 'bad-logs' };
    return { ok: true };
}

ipcMain.handle('export-data', async () => {
    try {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Export LuxLearn data',
            defaultPath: `luxlearn-backup-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (canceled || !filePath) return { success: false, canceled: true };
        const payload = buildExportPayload();
        await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
        return { success: true, filePath, count: (payload.logs || []).length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('import-data', async () => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Import LuxLearn data',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile']
        });
        if (canceled || !filePaths?.length) return { success: false, canceled: true };
        const raw = await fs.readFile(filePaths[0], 'utf8');
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return { success: false, error: 'invalid-json' };
        }
        const check = validateImportPayload(data);
        if (!check.ok) return { success: false, error: check.reason };

        let imported = 0;
        if (data.settings) {
            const merged = sanitizeSettings({ ...defaultSettings, ...data.settings }, defaultSettings);
            state.settings = merged;
            await brightnessManager?.updateSettings(merged);
            imported++;
        }
        if (data.activities) {
            state.settings.activities = normalizeActivities(data.activities);
            imported++;
        }
        if (Array.isArray(data.logs) && brightnessManager) {
            const clean = data.logs.map(l => brightnessManager._sanitizeLogEntry(l)).filter(Boolean);
            brightnessManager.logs = clean;
            brightnessManager._recalculateFeatureImportance();
            imported++;
        }
        if (data.learningConfig && brightnessManager) {
            const lc = data.learningConfig;
            if (typeof lc.startTime !== 'undefined' && !isNaN(new Date(lc.startTime).getTime())) {
                brightnessManager.learningConfig.startTime = new Date(lc.startTime).getTime();
                imported++;
            }
            if (typeof lc.learningMode === 'boolean') {
                brightnessManager.learningConfig.learningMode = lc.learningMode;
                if (!lc.learningMode) brightnessManager._updateLearningPhase(1);
                imported++;
            }
            sendDynamicStatusUpdate();
        }
        persistAndApplySettings(state.settings);
        sendDynamicStatusUpdate();
        updateTrayMenu();
        return { success: true, count: imported };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('window-control', (_event, action) => {
    if (!mainWindow) return { success: false };
    switch (action) {
        case 'minimize': mainWindow.minimize(); break;
        case 'maximize':
            mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
            break;
        case 'close':
            mainWindow.hide();
            break;
        default: return { success: false };
    }
    return { success: true, maximized: mainWindow.isMaximized() };
});
ipcMain.handle('pause-adjustments', (_, durationMs) => {
    if (!brightnessManager) return { success: false, error: 'Not ready' };
    const until = brightnessManager.pauseAdjustments(durationMs);
    sendDynamicStatusUpdate();
    return { success: true, manualOverrideUntil: until };
});
ipcMain.handle('resume-adjustments', () => {
    if (!brightnessManager) return { success: false, error: 'Not ready' };
    brightnessManager.resumeAdjustments();
    sendDynamicStatusUpdate();
    return { success: true };
});
ipcMain.handle('get-brightness-history', (_, hours = 24) => {
    if (!brightnessManager) return [];
    const cutoff = Date.now() - Math.max(1, Math.min(24 * 30, Number(hours) || 24)) * 3600000;
    return brightnessManager.logs
        .filter((l) => l.timestamp_ts >= cutoff)
        .map((l) => ({ t: l.timestamp_ts, b: l.brightness, type: l.type }));
});
ipcMain.handle('clear-learning-logs', () => {
    if (!brightnessManager) return { success: false, error: 'Not ready' };
    brightnessManager.clearLearningLogs();
    sendDynamicStatusUpdate();
    return { success: true };
});
ipcMain.handle('export-logs-csv', async () => {
    if (!brightnessManager) return { success: false, error: 'Not ready' };
    try {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Export brightness logs',
            defaultPath: `luxlearn-logs-${new Date().toISOString().slice(0, 10)}.csv`,
            filters: [{ name: 'CSV', extensions: ['csv'] }]
        });
        if (canceled || !filePath) return { success: false, canceled: true };
        const csv = await brightnessManager.exportLogsCsv();
        await fs.writeFile(filePath, csv, 'utf8');
        return { success: true, filePath, count: brightnessManager.logs.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});
ipcMain.handle('open-os-settings', (_, target) => {
    const macPerms = getMacPermissionsModule();
    if (!macPerms) return { success: false, error: 'Not supported on this platform' };
    if (target === 'screen') { macPerms.openScreenRecordingSettings(); return { success: true }; }
    if (target === 'camera') {
        macPerms.ensureCameraAccess();
        macPerms.openCameraSettings();
        return { success: true };
    }
    return { success: false, error: 'Unknown settings target' };
});
ipcMain.handle('open-external', (_, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        shell.openExternal(url);
        return { success: true };
    }
    return { success: false, error: 'Blocked non-http(s) URL' };
});

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const isHidden = process.argv.includes('--hidden');

    mainWindow = new BrowserWindow({
        width: Math.floor(width * 0.65),
        height: Math.floor(height * 0.8),
        minWidth: 720,
        minHeight: 520,
        show: false,
        frame: false,
        icon: getAppIcon(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        },
        autoHideMenuBar: true,
        skipTaskbar: isHidden,
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.on('did-finish-load', () => {
        if (brightnessManager) {
            sendWeatherUpdateToUI();
            sendToMainWindow('settings-updated', {
                settings: state.settings,
                learningConfig: brightnessManager?.learningConfig || {},
            });
        }
        if (state.availableUpdate) {
            sendToMainWindow('update-available', state.availableUpdate);
        }
        if (!isHidden) mainWindow.show();
    });

    mainWindow.webContents.on('unresponsive', () => {
        console.warn('Renderer became unresponsive.');
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error('Renderer process gone:', details.reason);
    });

    mainWindow.on('show', () => {
        if (!statusUpdateInterval) {
            sendDynamicStatusUpdate();
            statusUpdateInterval = setInterval(sendDynamicStatusUpdate, UPDATE_STATUS_INTERVAL_MS);
        }
    });

    mainWindow.on('hide', () => {
        if (statusUpdateInterval) {
            clearInterval(statusUpdateInterval);
            statusUpdateInterval = null;
        }
    });

    mainWindow.on('minimize', () => {
        if (statusUpdateInterval) {
            clearInterval(statusUpdateInterval);
            statusUpdateInterval = null;
        }
    });

    mainWindow.on('restore', () => {
        if (!statusUpdateInterval) {
            sendDynamicStatusUpdate();
            statusUpdateInterval = setInterval(sendDynamicStatusUpdate, UPDATE_STATUS_INTERVAL_MS);
        }
    });

    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.setSkipTaskbar(true);
            mainWindow.hide();
        }
    });
}

function createTray() {
    if (tray) return;
    tray = new Tray(getAppIcon());
    updateTrayMenu();
    tray.on('click', () => {
        if (!mainWindow) createWindow();
        else if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
        else showMainWindow();
    });
}

function applyPause(action) {
    if (brightnessManager) action(brightnessManager);
    updateTrayMenu();
    sendDynamicStatusUpdate();
}

function showMainWindow() {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
}

function updateTrayMenu() {
    if (!tray) return;
    const active = !!brightnessManager;
    const paused = active && brightnessManager.manualOverrideUntil > Date.now();
    const contextMenu = Menu.buildFromTemplate([
        {
            label: active ? 'Enable Auto Brightness' : 'Loading...',
            type: 'checkbox',
            enabled: active,
            checked: state.settings.autoEnabled,
            click: (m) => persistAndApplySettings({ autoEnabled: m.checked })
        },
        {
            label: paused
                ? `Resume (paused until ${formatTime(new Date(brightnessManager.manualOverrideUntil))})`
                : 'Pause adjustments',
            enabled: active && state.settings.autoEnabled,
            submenu: paused
                ? [
                    { label: 'Resume now', click: () => applyPause((bm) => bm.resumeAdjustments()) }
                ]
                : [
                    { label: 'Pause for 1 hour', click: () => applyPause((bm) => bm.pauseAdjustments(60 * 60 * 1000)) },
                    { label: 'Pause for 4 hours', click: () => applyPause((bm) => bm.pauseAdjustments(4 * 60 * 60 * 1000)) },
                    {
                        label: 'Pause until tomorrow (8:00 AM)', click: () => {
                            const until = new Date();
                            until.setHours(8, 0, 0, 0);
                            if (until <= Date.now()) until.setDate(until.getDate() + 1);
                            applyPause((bm) => bm.pauseAdjustments(until.getTime() - Date.now()));
                        }
                    }
                ]
        },
        { type: 'separator' },
        { label: 'Show App', click: showMainWindow },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip(`Auto Brightness: ${active ? (state.settings.autoEnabled ? 'ON' : 'OFF') : 'Loading...'}`);
}

app.on('second-instance', (_, cmd) => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!cmd.includes('--hidden')) showMainWindow();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
});

app.on('window-all-closed', (e) => {
    if (!app.isQuitting) e.preventDefault();
});

app.on('before-quit', async (e) => {
    if (autoUpdater && autoUpdater.quitAndInstallCalled) return;
    if (!app.isQuitting && brightnessManager) {
        e.preventDefault();
        app.isQuitting = true;
        await brightnessManager.handleShutdown();
        await shutdownWebcamWorker();
        app.quit();
    }
});