// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Events sent before the renderer registers its listeners (e.g. right after
// did-finish-load) would otherwise be lost, leaving status fields stuck at
// their "--" placeholders. Buffer the latest payload per channel and replay
// it on first subscription.
const earlyBuffer = {};
const bufferedChannels = ['weather-update', 'dynamic-status-update', 'settings-updated', 'log-update', 'update-available', 'os-support-update'];
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
     openExternal: (url) => ipcRenderer.invoke('open-external', url)
});