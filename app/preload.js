// preload.js
const { contextBridge, ipcRenderer } = require('electron');

const earlyBuffer = {};
const bufferedChannels = ['weather-update', 'dynamic-status-update', 'settings-updated', 'log-update', 'update-available', 'update-download-progress', 'update-downloaded', 'os-support-update', 'pin-hint'];
for (const channel of bufferedChannels) {
    ipcRenderer.on(channel, (_event, value) => {
        earlyBuffer[channel] = value;
    });
}

function subscribe(channel, callback) {
    const wrapped = (_event, value) => callback(value);
    ipcRenderer.on(channel, wrapped);
    if (channel in earlyBuffer) {
        queueMicrotask(() => callback(earlyBuffer[channel]));
    }
    return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
     saveSettings: (config) => ipcRenderer.invoke('save-settings', config),
     loadSettings: () => ipcRenderer.invoke('load-settings'),
     loadLearningConfig: () => ipcRenderer.invoke('load-learning-config'),
     getUsername: () => ipcRenderer.invoke('get-username'),
     resetSettings: () => ipcRenderer.invoke('reset-settings'),
     getOsSupport: () => ipcRenderer.invoke('get-os-support'),
     openOsSettings: (target) => ipcRenderer.invoke('open-os-settings', target),
     getPowerStatus: () => ipcRenderer.invoke('get-power-status'),
     listCameras: () => ipcRenderer.invoke('list-cameras'),
     listDisplays: () => ipcRenderer.invoke('list-displays'),
     getBrightnessBackend: () => ipcRenderer.invoke('get-brightness-backend'),
     openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
     openSettingsFile: () => ipcRenderer.invoke('open-settings-file'),
     getActivities: () => ipcRenderer.invoke('activities:get'),
     setActivities: (raw) => ipcRenderer.invoke('activities:set', raw),
     addActivity: (a) => ipcRenderer.invoke('activity:add', a),
     updateActivity: (id, patch) => ipcRenderer.invoke('activity:update', { id, patch }),
     deleteActivity: (id) => ipcRenderer.invoke('activity:delete', id),
     checkActivityWindow: () => ipcRenderer.invoke('activity:check-window'),
     getVersion: () => ipcRenderer.invoke('about:get-version'),
     checkUpdatesNow: () => ipcRenderer.invoke('about:check-updates'),
     downloadUpdate: () => ipcRenderer.invoke('about:download-update'),
     installUpdate: () => ipcRenderer.invoke('about:install-update'),
     onUpdateDownloadProgress: (callback) => subscribe('update-download-progress', callback),
     onUpdateDownloaded: (callback) => subscribe('update-downloaded', callback),
     exportData: () => ipcRenderer.invoke('export-data'),
     importData: () => ipcRenderer.invoke('import-data'),
     windowControl: (action) => ipcRenderer.invoke('window-control', action),
     pauseAdjustments: (durationMs) => ipcRenderer.invoke('pause-adjustments', durationMs),
     resumeAdjustments: () => ipcRenderer.invoke('resume-adjustments'),
     getBrightnessHistory: (hours) => ipcRenderer.invoke('get-brightness-history', hours),
     clearLearningLogs: () => ipcRenderer.invoke('clear-learning-logs'),
     exportLogsCsv: () => ipcRenderer.invoke('export-logs-csv'),
     onWeatherUpdate: (callback) => subscribe('weather-update', callback),
     onDynamicStatusUpdate: (callback) => subscribe('dynamic-status-update', callback),
     onSettingsUpdated: (callback) => subscribe('settings-updated', callback),
     onLogUpdate: (callback) => subscribe('log-update', callback),
     onUpdateAvailable: (callback) => subscribe('update-available', callback),
     onOsSupportUpdate: (callback) => subscribe('os-support-update', callback),
     onPinHint: (callback) => subscribe('pin-hint', callback),
     openExternal: (url) => ipcRenderer.invoke('open-external', url)
});