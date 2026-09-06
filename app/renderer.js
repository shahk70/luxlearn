// renderer.js

window.addEventListener('DOMContentLoaded', () => {
    const THREE_HOURS_IN_MS = 3 * 60 * 60 * 1000;
    const MAX_LOGS_TO_SHOW = 20;

    let hasLogs = false;

    let lastAppliedConfig = null;

    const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

    const $ = (id) => document.getElementById(id);

    function syncSelectValue(select, value) {
        if (!select) return;
        const values = Array.from(select.options).map(o => o.value);
        if (values.includes(value)) select.value = value;
    }

    async function populateDeviceSelects() {
        const cameraSelect = $('cameraDeviceSelect');
        const displaySelect = $('targetDisplaySelect');
        if (cameraSelect) {
            const keep = cameraSelect.value;
            const cameras = await window.api.listCameras?.().catch?.(() => []) || [];
            while (cameraSelect.options.length > 1) cameraSelect.remove(1);
            for (const cam of cameras) {
                const opt = document.createElement('option');
                opt.value = cam.id;
                opt.textContent = cam.name || cam.id;
                cameraSelect.appendChild(opt);
            }
            syncSelectValue(cameraSelect, keep || lastAppliedConfig?.cameraDevice || '');
        }
        if (displaySelect) {
            const keep = displaySelect.value;
            const displays = await window.api.listDisplays?.().catch?.(() => []) || [];
            while (displaySelect.options.length > 1) displaySelect.remove(1);
            for (const d of displays) {
                const opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = (d.name || d.id) + (d.kind ? ` (${d.kind})` : '');
                displaySelect.appendChild(opt);
            }
            syncSelectValue(displaySelect, keep || lastAppliedConfig?.targetDisplay || 'all');
        }
    }

    // --- i18n ---
    initI18n(I18N);
    const t = (key, params) => window.t ? window.t(key, params) : key;
    const getLocale = () => window.getLocale ? window.getLocale() : savedLocale;
    let savedLocale = localStorage.getItem('appLanguage') || 'en';
    function applyAppLanguage(lang) {
        savedLocale = lang || 'en';
        try { localStorage.setItem('appLanguage', savedLocale); } catch { /* private mode */ }
        setLocale(savedLocale);
        applyStaticTranslations();
        const languageSelect = $('languageSelect');
        if (languageSelect) languageSelect.value = savedLocale;
    }
    applyAppLanguage(savedLocale);
    const elems = {
        toggle: $('enableAuto'),
        stateText: $('toggleState'),
        optionsBox: $('optionsBox'),
        customFields: $('customFields'),
        note: $('note'),
        locationData: $('locationData'),
        resetSettingsBtn: $('resetSettingsBtn'),
        advancedSettings: $('advanced-settings'),
        mainContent: document.querySelector('.main-content'),

        updateBanner: $('updateBanner'),
        updateBannerText: $('updateBannerText'),
        updateBannerViewBtn: $('updateBannerViewBtn'),
        updateBannerDismissBtn: $('updateBannerDismissBtn'),

        menuContainer: document.querySelector('.menu'),
        footerMenuContainer: document.querySelector('.footer-menu'),
        pages: document.querySelectorAll('.page'),

        pauseBtn: $('pauseBtn'),
        resumeBtn: $('resumeBtn'),
        historyCanvas: $('historyChart'),
        chartEmpty: $('chartEmpty'),
        chartCaption: $('chartCaption'),
        weightsList: $('weightsList'),
        weightsNote: $('weightsNote'),
        clearLogsBtn: $('clearLogsBtn'),
        themeLightBtn: $('themeLightBtn'),
        themeDarkBtn: $('themeDarkBtn'),
        themeSystemBtn: $('themeSystemBtn'),

        inputs: {
            sunriseHour: $('sunriseHour'),
            sunriseMinute: $('sunriseMinute'),
            sunsetHour: $('sunsetHour'),
            sunsetMinute: $('sunsetMinute'),
            learningDuration: $('learning-duration'),
            pollInterval: $('learning-polinterval'),
            logSync: $('learning-logSyncInterval'),
            logLimit: $('learning-loglimit'),
            autoInterval: $('auto-interval'),
            manualOverrideMinutes: $('manual-override-minutes'),
            hysteresisPercent: $('hysteresis-percent'),
            adjustDuringLearning: $('adjustDuringLearning'),
        },

        location: { city: $('cityName'), sunrise: $('lightTime'), sunset: $('darkTime'), nextUpdate: $('nextUpdate') },
        profile: { username: $('profile-username'), method: $('profile-method'), progress: $('profile-learning-progress'), interval: $('profile-auto-interval') },
        status: { brightness: $('status-brightness'), phase: $('status-learning-phase'), logs: $('status-logs-recorded'), auto: $('status-auto-brightness'), next: $('status-next-adjustment'), als: $('status-als'), confidence: $('status-confidence'), power: $('status-power'), nightLight: $('status-nightlight'), lightMode: $('status-lightmode'), lightModeLabel: $('status-lightmode-label') },
        activitiesList: $('activitiesList'),
        activityGaming: $('activityGaming'),
        activityVideo: $('activityVideo'),
        activityName: $('activityName'),
        activityMatchType: $('activityMatchType'),
        activityValue: $('activityValue'),
        activityAddBtn: $('activityAddBtn'),
        aboutVersion: $('about-version'),
        checkUpdatesBtn: $('checkUpdatesBtn'),
        updateCheckResult: $('updateCheckResult'),
        exportDataBtn: $('exportDataBtn'),
        importDataBtn: $('importDataBtn'),
        osWarningsCard: $('os-warnings-card'),
        osWarningsList: $('os-warnings-list'),

        toast: $("toast"),
        logsList: document.querySelector('.recent-changes-list'),
    };

    const toggleDisplay = (el, show, displayType = 'block') => {
        if (!el) return;
        const newVal = show ? displayType : 'none';
        if (el.style.display !== newVal) el.style.display = newVal;
    };

    const debounce = (func, delay = 400) => {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func(...args), delay);
        };
    };

    const getNumericValue = (input, fallback) => {
        const value = Number(input.value);
        return isNaN(value) ? fallback : value;
    };

    const setText = (el, text) => {
        if (el && el.textContent !== text) el.textContent = text;
    };

    let pendingUIUpdates = null;
    function requestUIUpdate(fn) {
        if (!pendingUIUpdates) {
            requestAnimationFrame(() => {
                const batch = pendingUIUpdates;
                pendingUIUpdates = null;
                for (const update of batch) {
                    try { update(); } catch (err) { console.error('UI update failed:', err); }
                }
            });
        }
        (pendingUIUpdates ||= []).push(fn);
    }

    let lastKnownLearningState = { autoEnabled: null, learningComplete: null, adjustDuringLearning: true };
    let lastLearningConfig = null;
    let chartStaticCanvas = null;
    let chartHoverRaf = 0;
    let chartHoverTargetX = null;
    function updateUIVisibility() {
        requestUIUpdate(() => {
            const isEnabled = elems.toggle.checked;
            const method = document.querySelector('input[name="method"]:checked').value;
            setText(elems.stateText, isEnabled ? t('settings.on') : t('settings.off'));

            toggleDisplay(elems.advancedSettings, true);
            elems.advancedSettings?.classList.toggle('disabled-when-off', !isEnabled);

            const learningComplete = lastKnownLearningState.learningComplete;
            const learningRow = $('adjustDuringLearningRow');
            if (learningRow && learningComplete !== null) {
                learningRow.hidden = !(isEnabled && learningComplete === false);
            }

            const isCustom = isEnabled && method === 'custom';
            toggleDisplay(elems.customFields, isCustom, 'flex');
            toggleDisplay(elems.note, isCustom);
            toggleDisplay(elems.locationData, isEnabled && method === 'location');
        });
    }

    function updateLocationUI(data = {}) {
        requestUIUpdate(() => {
            setText(elems.location.city, data.city || 'N/A');
            setText(elems.location.sunrise, data.sunrise || 'N/A');
            setText(elems.location.sunset, data.sunset || 'N/A');

            if (data.lastUpdated) {
                const next = new Date(new Date(data.lastUpdated).getTime() + THREE_HOURS_IN_MS);
                setText(elems.location.nextUpdate, next.toLocaleTimeString());
            } else {
                setText(elems.location.nextUpdate, 'N/A');
            }
        });
    }

    function updateStatusUI(data = {}) {
        requestUIUpdate(() => {
            const { status } = elems;
            lastKnownLearningState.autoEnabled = data.autoEnabled ?? lastKnownLearningState.autoEnabled;
            if (data.isLearningComplete !== undefined) {
                const prev = lastKnownLearningState.learningComplete;
                lastKnownLearningState.learningComplete = data.isLearningComplete;
                if (prev !== data.isLearningComplete) {
                    updateUIVisibility();
                }
            }
            setText(status.brightness, `${data.brightness ?? 0}%`);
            setText(status.logs, `${data.logsRecorded ?? 0} / ${data.logLimit ?? 'N/A'}`);
            setText(status.phase, data.learningPhase > 0 ? t('status.phaseN', { n: data.learningPhase }) : t('status.inactive'));
            const learningPaused = data.isLearningComplete === false
                && lastKnownLearningState.adjustDuringLearning === false;
            setText(status.next, data.autoEnabled ? (data.nextAdjustment ?? 'N/A') : 'N/A');
            let autoText = data.autoEnabled ? t('status.active') : t('status.inactive');
            let statusClass = data.autoEnabled ? 'active' : 'inactive';
            if (data.autoEnabled && learningPaused) {
                autoText = t('status.pausedLearning');
                statusClass = 'paused';
            }
            setText(status.auto, autoText);
            if (status.auto.className !== statusClass) status.auto.className = statusClass;

            if (status.als) {
                setText(status.als, data.ambientLightSensorAvailable ? t('status.detected') : t('status.notDetected'));
            }

            if (status.confidence) {
                setText(status.confidence, `${data.automationConfidence ?? 0}%`);
            }

            if (data.powerSource !== undefined) {
                let powerText = '—';
                if (data.powerSource === 'AC') powerText = t('status.powerAC');
                else if (data.powerSource === 'battery') {
                    powerText = data.batteryLevel != null ? t('status.powerBatteryPct', { pct: Math.round(data.batteryLevel) }) : t('status.powerBattery');
                } else if (data.batteryLevel != null) {
                    powerText = t('status.powerLevel', { pct: Math.round(data.batteryLevel) });
                }
                if (status.power) setText(status.power, powerText);
            }

            if (data.nightLight !== undefined && status.nightLight) {
                setText(status.nightLight, data.nightLight === 'on' ? t('settings.on') : data.nightLight === 'off' ? t('settings.off') : '—');
            }

            if (status.lightMode && status.lightModeLabel) {
                const show = data.lightMode === true || data.deviceWeak === true;
                status.lightMode.hidden = !show;
                status.lightModeLabel.hidden = !show;
                setText(status.lightMode, data.lightMode === true ? t('status.active') : t('status.lowpowerStandby'));
            }

            const paused = typeof data.manualOverrideUntil === 'number' && data.manualOverrideUntil > Date.now();
            if (elems.pauseBtn && elems.resumeBtn) {
                elems.pauseBtn.hidden = paused;
                elems.resumeBtn.hidden = !paused;
                setText(elems.resumeBtn, paused ? t('status.pausedUntil', { time: timeFormat.format(new Date(data.manualOverrideUntil)) }) : t('status.resume'));
            }

            if (data.currentWeights && typeof data.currentWeights === 'object') {
                lastKnownWeights = data.currentWeights;
                lastInteractionPair = data.interactionPair ?? null;
                renderWeights(lastKnownWeights, lastInteractionPair);
            }
        });
    }

    let lastPowerText = null;
    const status_power_el = elems.status?.power ?? $('status-power');
    let powerRefreshTimer = null;
    function refreshPowerRow() {
        window.api.getPowerStatus?.().then((power) => {
            requestUIUpdate(() => {
                if (!status_power_el) return;
                let text = '—';
                if (power) {
                    if (power.onBattery === false) text = power.batteryPercent != null ? t('status.powerACPct', { pct: Math.round(power.batteryPercent) }) : t('status.powerAC');
                    else if (power.onBattery === true) text = t('status.powerBatteryPct', { pct: Math.round(power.batteryPercent ?? 0) });
                    else if (power.batteryPercent != null) text = t('status.powerLevel', { pct: Math.round(power.batteryPercent) });
                    else text = t('status.noBattery');
                }
                if (text !== lastPowerText) {
                    lastPowerText = text;
                    setText(status_power_el, text);
                }
            });
        }).catch(() => {});
    }
    function startPowerRefresh() {
        if (powerRefreshTimer) return;
        refreshPowerRow();
        powerRefreshTimer = setInterval(() => {
            if (document.getElementById('page-status')?.classList.contains('active')) refreshPowerRow();
        }, 30000);
    }

    function renderOsSupport(osSupport = {}) {
        lastOsSupport = osSupport;
        requestUIUpdate(() => {
            const warnings = osSupport.warnings ?? [];
            if (!elems.osWarningsCard || !elems.osWarningsList) return;

            if (warnings.length === 0) {
                elems.osWarningsCard.hidden = true;
                elems.osWarningsList.innerHTML = '';
                return;
            }

            elems.osWarningsCard.hidden = false;
            elems.osWarningsList.innerHTML = '';
            for (const warning of warnings) {
                const li = document.createElement('li');
                li.className = 'os-warning-item';

                const message = document.createElement('span');
                const warningKey = `warn.${warning.id}`;
                const translated = t(warningKey);
                message.textContent = translated === warningKey ? warning.message : translated;
                li.appendChild(message);

                if (warning.action) {
                    const button = document.createElement('button');
                    button.className = 'btn btn-secondary btn-sm';
                    button.textContent = t('status.openSettings');
                    button.addEventListener('click', () => {
                        const target = warning.action === 'open-camera-settings' ? 'camera' : 'screen';
                        window.api.openOsSettings?.(target).then((result) => {
                            if (result?.success) {
                                setTimeout(() => window.api.getOsSupport?.().then(renderOsSupport), 5000);
                            }
                        });
                    });
                    li.appendChild(button);
                }

                elems.osWarningsList.appendChild(li);
            }
        });
    }

    function updateProfileUI(settings = {}, learningConfig = {}) {
        if (learningConfig && Object.keys(learningConfig).length) lastLearningConfig = learningConfig;
        requestUIUpdate(() => {
            const { profile } = elems;
            const pad = (n) => String(n).padStart(2, '0');

            if (settings.method === 'location') {
                setText(profile.method, t('settings.location'));
            } else if (settings.method === 'custom' && settings.custom) {
                const s = settings.custom;
                setText(profile.method, `${t('settings.custom')} (${pad(s.sunrise.h)}:${pad(s.sunrise.m)} - ${pad(s.sunset.h)}:${pad(s.sunset.m)})`);
            } else {
                setText(profile.method, 'N/A');
            }

            setText(profile.interval, t('profile.intervalMinutes', { n: settings.autoBrightMin ?? 'N/A' }));

            if (learningConfig.startTime && settings.learningDays > 0) {
                const diffDays = Math.floor((Date.now() - new Date(learningConfig.startTime).getTime()) / 86400000);
                const completedDays = Math.min(Math.max(0, diffDays), settings.learningDays);
                setText(profile.progress, t('profile.progressDays', { done: completedDays, total: settings.learningDays }));
            } else {
                setText(profile.progress, 'N/A');
            }
        });
    }

    function updateLogsUI({ level, timestamp, message }) {
        requestUIUpdate(() => {
            if (!hasLogs) {
                elems.logsList.innerHTML = '';
                hasLogs = true;
            }
            const li = document.createElement('li');
            li.className = `log-level-${level}`;
            const time = document.createElement('span');
            time.textContent = `${timeFormat.format(new Date(timestamp))}:`;
            li.appendChild(time);
            li.appendChild(document.createTextNode(` ${message}`));

            elems.logsList.prepend(li);

            if (elems.logsList.childElementCount > MAX_LOGS_TO_SHOW) {
                elems.logsList.lastElementChild.remove();
            }
        });
    }

    const NUMERIC_FIELDS = [
        { id: 'learningDuration', key: 'learningDays', def: 3 },
        { id: 'pollInterval', key: 'pollIntervalSec', def: 20 },
        { id: 'logSync', key: 'logSyncMin', def: 1 },
        { id: 'logLimit', key: 'logLimit', def: 240 },
        { id: 'autoInterval', key: 'autoBrightMin', def: 5 },
        { id: 'manualOverrideMinutes', key: 'manualOverrideMinutes', def: 5 },
        { id: 'hysteresisPercent', key: 'hysteresisPercent', def: 2 },
    ];

    function getConfig() {
        const prev = lastAppliedConfig || {};
        const prevCustom = prev.custom || {};
        const cameraSelect = $('cameraDeviceSelect');
        const displaySelect = $('targetDisplaySelect');
        const config = {
            autoEnabled: elems.toggle.checked,
            method: document.querySelector('input[name="method"]:checked').value,
            custom: {
                sunrise: {
                    h: getNumericValue(elems.inputs.sunriseHour, prevCustom.sunrise?.h ?? 7),
                    m: getNumericValue(elems.inputs.sunriseMinute, prevCustom.sunrise?.m ?? 0)
                },
                sunset: {
                    h: getNumericValue(elems.inputs.sunsetHour, prevCustom.sunset?.h ?? 19),
                    m: getNumericValue(elems.inputs.sunsetMinute, prevCustom.sunset?.m ?? 0)
                },
            },
            adjustDuringLearning: elems.inputs.adjustDuringLearning?.checked ?? true,
            cameraDevice: cameraSelect?.value ?? prev.cameraDevice ?? '',
            targetDisplay: displaySelect?.value ?? prev.targetDisplay ?? 'all',
        };
        for (const { id, key, def } of NUMERIC_FIELDS) {
            config[key] = getNumericValue(elems.inputs[id], prev[key] ?? def);
        }
        return config;
    }

    let lastEchoedConfigSig = null;
    const configSignature = (value) => {
        if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
        if (Array.isArray(value)) return `[${value.map(configSignature).join(',')}]`;
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${configSignature(value[k])}`).join(',')}}`;
    };
    function applyConfig(cfg = {}, { skipIfCurrent = false } = {}) {
        if (skipIfCurrent) {
            const sig = configSignature(cfg);
            if (sig === lastEchoedConfigSig) return;
            lastEchoedConfigSig = sig;
        }
        if (cfg.language && cfg.language !== getLocale()) {
            applyAppLanguage(cfg.language);
        }
        requestUIUpdate(() => {
            elems.toggle.checked = cfg.autoEnabled ?? false;

            const radio = document.querySelector(`input[name="method"][value="${cfg.method || 'location'}"]`);
            if (radio) radio.checked = true;

            const { inputs } = elems;
            inputs.sunriseHour.value = cfg.custom?.sunrise?.h ?? 7;
            inputs.sunriseMinute.value = cfg.custom?.sunrise?.m ?? 0;
            inputs.sunsetHour.value = cfg.custom?.sunset?.h ?? 19;
            inputs.sunsetMinute.value = cfg.custom?.sunset?.m ?? 0;

            for (const { id, key, def } of NUMERIC_FIELDS) {
                const input = inputs[id];
                if (input) input.value = cfg[key] ?? def;
            }

            if (inputs.adjustDuringLearning) {
                inputs.adjustDuringLearning.checked = cfg.adjustDuringLearning !== false;
                setText($('adjustDuringLearningState'), cfg.adjustDuringLearning !== false ? t('settings.on') : t('settings.off'));
                lastKnownLearningState.adjustDuringLearning = cfg.adjustDuringLearning !== false;
            }

            const cameraSelect = $('cameraDeviceSelect');
            if (cameraSelect) syncSelectValue(cameraSelect, cfg.cameraDevice ?? '');
            const displaySelect = $('targetDisplaySelect');
            if (displaySelect) syncSelectValue(displaySelect, cfg.targetDisplay ?? 'all');

            lastAppliedConfig = cfg;

            updateUIVisibility();
        });
    }

    let dismissedUpdateVersion = null;

    const updateThemeToggleImg = () => {
        const current = document.documentElement.getAttribute('data-theme') || 'system';
        const map = { light: elems.themeLightBtn, dark: elems.themeDarkBtn, system: elems.themeSystemBtn };
        for (const [choice, btn] of Object.entries(map)) {
            if (!btn) continue;
            const isActive = choice === current;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
    };
    const applyThemeChoice = (choice) => {
        const root = document.documentElement;
        if (choice === 'dark') root.setAttribute('data-theme', 'dark');
        else if (choice === 'light') root.setAttribute('data-theme', 'light');
        else root.removeAttribute('data-theme');
        updateThemeToggleImg();
        chartStaticCanvas = null;
        if (typeof drawHistoryChart === 'function' && document.getElementById('page-status')?.classList.contains('active')) {
            drawHistoryChart();
        }
    };

    const setThemeChoice = (choice) => {
        applyThemeChoice(choice);
        try { localStorage.setItem('theme', choice); } catch { /* ignore */ }
    };
    elems.themeLightBtn?.addEventListener('click', () => setThemeChoice('light'));
    elems.themeDarkBtn?.addEventListener('click', () => setThemeChoice('dark'));
    elems.themeSystemBtn?.addEventListener('click', () => setThemeChoice('system'));

    $('winMinimize')?.addEventListener('click', () => window.api.windowControl?.('minimize'));
    $('winMaximize')?.addEventListener('click', () => window.api.windowControl?.('maximize'));
    $('winClose')?.addEventListener('click', () => window.api.windowControl?.('close'));
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        updateThemeToggleImg();
        if (document.getElementById('page-status')?.classList.contains('active')) drawHistoryChart();
    });
    try {
        applyThemeChoice(localStorage.getItem('theme') || 'system');
    } catch {
        applyThemeChoice('system');
    }

    function showUpdateBanner(update) {
        if (!update || !elems.updateBanner) return;
        if (dismissedUpdateVersion === update.version) return;

        setText(elems.updateBannerText, t('update.availableDetail', { version: update.version }));
        elems.updateBanner.hidden = false;

        elems.updateBannerViewBtn.onclick = () => window.api.openExternal?.(update.url);
        elems.updateBannerDismissBtn.onclick = () => {
            dismissedUpdateVersion = update.version;
            elems.updateBanner.hidden = true;
        };
    }

    let toastTimer = null;
    function showToast(message) {
        setText(elems.toast, message);
        elems.toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            elems.toast.classList.remove('show');
            toastTimer = null;
        }, 3000);
    }

    async function copyWallet(button, address) {
        try {
            await navigator.clipboard.writeText(address);
            showToast(t('toast.addressCopied'));
        } catch (err) {
            try {
                const textarea = document.createElement('textarea');
                textarea.value = address;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                showToast(t('toast.addressCopied'));
            } catch (fallbackErr) {
                showToast(t('toast.copyFailed'));
            }
        }
    }

    const handleCopyClick = (event) => {
        const button = event.target.closest('[data-copy-value]');
        if (!button) return;
        copyWallet(button, button.dataset.copyValue);
    };

    let confirmAction = null;
    function showConfirm(title, message, okLabel, onConfirm) {
        const overlay = $('confirmOverlay');
        if (!overlay) return;
        setText($('confirmTitle'), title);
        setText($('confirmMessage'), message);
        setText($('confirmOkBtn'), okLabel || 'Confirm');
        confirmAction = onConfirm;
        overlay.hidden = false;
        requestAnimationFrame(() => $('confirmOkBtn')?.focus());
    }
    function hideConfirm() {
        const overlay = $('confirmOverlay');
        if (overlay) overlay.hidden = true;
        confirmAction = null;
    }
    $('confirmOkBtn')?.addEventListener('click', () => {
        const action = confirmAction;
        hideConfirm();
        action?.();
    });
    $('confirmCancelBtn')?.addEventListener('click', hideConfirm);
    $('confirmOverlay')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) hideConfirm();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('confirmOverlay')?.hidden) hideConfirm();
    });

    const debouncedSave = debounce(async () => {
        const config = getConfig();
        lastEchoedConfigSig = configSignature(config);
        const result = await window.api.saveSettings(config);
        if (result.success) {
            lastAppliedConfig = result.settings;
            updateProfileUI(result.settings, result.learningConfig);
        } else {
            showToast(t('toast.saveFailed'));
        }
    }, 500);

    const handleSettingsChange = () => {
        updateUIVisibility();
        debouncedSave();
    };

    const handleNavClick = (event) => {
        const li = event.target.closest('li[data-page]');
        if (!li) return;

        const pageId = `page-${li.dataset.page}`;
        const activate = (item) => {
            item.classList.toggle('active', item === li);
            if (item.hasAttribute('aria-selected')) {
                item.setAttribute('aria-selected', item === li ? 'true' : 'false');
            }
        };
        document.querySelectorAll('.menu li, .footer-menu li').forEach(activate);

        elems.pages.forEach(p => p.classList.toggle('active', p.id === pageId));
        const activePage = document.getElementById(pageId);
        if (activePage) {
            activePage.classList.remove('page-enter');
            void activePage.offsetWidth;
            activePage.classList.add('page-enter');
        }

        if (pageId === 'page-status') drawHistoryChart();
        if (pageId === 'page-activities') loadActivities();
    };

    const handleNavKeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const li = event.target.closest('li[data-page]');
        if (!li) return;
        event.preventDefault();
        li.click();
    };

    const handleStepperClick = (event) => {
        const button = event.target.closest('.stepper-up, .stepper-down');
        if (!button) return;

        const wrapper = button.closest('.number-input-wrapper');
        const input = wrapper && wrapper.querySelector('input');
        if (!input) return;

        const step = Number(input.step) || 1;
        let val = Number(input.value) || 0;

        val += button.classList.contains('stepper-up') ? step : -step;

        if (input.min) val = Math.max(Number(input.min), val);
        if (input.max) val = Math.min(Number(input.max), val);

        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    elems.toggle.addEventListener('change', handleSettingsChange);
    elems.optionsBox.addEventListener('change', (e) => e.target.name === 'method' && handleSettingsChange());

    elems.resetSettingsBtn.addEventListener('click', async () => {
        const result = await window.api.resetSettings();
        if (result.success) {
            applyConfig(result.settings);
            updateProfileUI(result.settings, result.learningConfig);
            showToast(t('toast.settingsReset'));
        }
    });

    elems.pauseBtn?.addEventListener('click', async () => {
        const result = await window.api.pauseAdjustments?.(60 * 60 * 1000);
        if (result?.success) showToast(t('toast.paused1h'));
    });

    elems.resumeBtn?.addEventListener('click', async () => {
        const result = await window.api.resumeAdjustments?.();
        if (result?.success) showToast(t('toast.resumed'));
    });



    // --- Language selector ---
    let lastKnownWeights = null;
    let lastInteractionPair = null;
    let lastOsSupport = null;
    function applyLanguageUI(lang) {
        applyAppLanguage(lang);
        updateUIVisibility();
        updateProfileUI(lastAppliedConfig || {}, lastLearningConfig || {});
        if (lastKnownWeights) {
            lastRenderedWeights = null;
            renderWeights(lastKnownWeights, lastInteractionPair);
        }
        chartStaticCanvas = null;
        lastChartGeom = null;
        if (lastChartPoints) drawHistoryChart();
        window.api.getActivities?.().then((a) => { if (a) renderActivitiesList(a); });
        if (lastOsSupport) renderOsSupport(lastOsSupport);
    }
    const languageSelect = $('languageSelect');
    if (languageSelect) {
        languageSelect.addEventListener('change', () => {
            const lang = languageSelect.value;
            applyLanguageUI(lang);
            const cfg = { ...(lastAppliedConfig || {}), language: lang };
            lastEchoedConfigSig = configSignature(cfg);
            window.api.saveSettings(cfg).then((result) => {
                if (result.success) {
                    lastAppliedConfig = result.settings;
                    updateProfileUI(result.settings, result.learningConfig);
                }
            });
        });
    }

    // --- Activities page ---
    function renderActivitiesList(activities) {
        const list = elems.activitiesList;
        if (!list) return;
        list.textContent = '';
        const custom = activities.custom || [];
        if (custom.length === 0) {
            const li = document.createElement('li');
            const span = document.createElement('span');
            span.className = 'activity-summary-match';
            span.textContent = t('activities.empty');
            li.appendChild(span);
            list.appendChild(li);
            return;
        }
        for (const a of custom) {
            const li = document.createElement('li');

            const summary = document.createElement('span');
            summary.className = 'activity-summary';
            const name = document.createElement('span');
            name.className = 'activity-summary-name';
            name.textContent = a.name;
            const match = document.createElement('span');
            match.className = 'activity-summary-match';
            match.textContent = (a.matchType === 'title' ? t('activities.matchTitle') + ': ' : t('activities.matchProcess') + ': ') + a.value;
            summary.appendChild(name);
            if (!a.enabled) {
                const badge = document.createElement('span');
                badge.className = 'activity-disabled-badge';
                badge.textContent = t('common.disabled');
                summary.appendChild(badge);
            }
            summary.appendChild(match);
            li.appendChild(summary);

            const actions = document.createElement('span');
            actions.className = 'activity-actions';
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn btn-secondary btn-sm';
            toggleBtn.textContent = a.enabled ? t('common.enabled') : t('common.disabled');
            toggleBtn.addEventListener('click', async () => {
                await window.api.updateActivity(a.id, { enabled: !a.enabled });
                loadActivities();
            });
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-danger btn-sm';
            delBtn.textContent = t('common.delete');
            delBtn.addEventListener('click', async () => {
                await window.api.deleteActivity(a.id);
                loadActivities();
            });
            actions.appendChild(toggleBtn);
            actions.appendChild(delBtn);
            li.appendChild(actions);
            list.appendChild(li);
        }
    }

    async function loadActivities() {
        const activities = await window.api.getActivities?.();
        if (!activities) return;
        if (elems.activityGaming) elems.activityGaming.checked = activities.gaming?.enabled === true;
        if (elems.activityVideo) elems.activityVideo.checked = activities.video?.enabled === true;
        renderActivitiesList(activities);
    }

    elems.activityGaming?.addEventListener('change', async () => {
        const current = await window.api.getActivities?.();
        await window.api.setActivities({ ...current, gaming: { enabled: elems.activityGaming.checked } });
    });
    elems.activityVideo?.addEventListener('change', async () => {
        const current = await window.api.getActivities?.();
        await window.api.setActivities({ ...current, video: { enabled: elems.activityVideo.checked } });
    });
    elems.activityAddBtn?.addEventListener('click', async () => {
        const name = elems.activityName?.value.trim();
        const value = elems.activityValue?.value.trim();
        if (!value) return;
        await window.api.addActivity?.({ name, value, matchType: elems.activityMatchType?.value });
        if (elems.activityName) elems.activityName.value = '';
        if (elems.activityValue) elems.activityValue.value = '';
        loadActivities();
    });

    document.querySelectorAll('.preset-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const nameEl = document.getElementById('activityName');
            const valueEl = document.getElementById('activityValue');
            const matchEl = document.getElementById('activityMatchType');
            if (nameEl) nameEl.value = chip.dataset.presetTitle;
            if (valueEl) valueEl.value = chip.dataset.presetProcess;
            if (matchEl) matchEl.value = 'process';
        });
    });

    // --- About page ---
    window.api.getVersion?.().then((v) => {
        const el = elems.aboutVersion;
        if (el) setText(el, v);
    });
    elems.checkUpdatesBtn?.addEventListener('click', async () => {
        if (elems.updateCheckResult) setText(elems.updateCheckResult, t('about.checking'));
        const result = await window.api.checkUpdatesNow?.();
        if (!elems.updateCheckResult) return;
        if (result?.available) {
            setText(elems.updateCheckResult, t('about.updateAvailable', { version: result.version }));
        } else if (result?.error) {
            setText(elems.updateCheckResult, result.error);
        } else {
            setText(elems.updateCheckResult, t('about.upToDate'));
        }
    });
    document.getElementById('aboutGithubBtn')?.addEventListener('click', () => window.api.openExternal?.('https://github.com/shahk70/luxlearn'));
    document.getElementById('aboutLogsBtn')?.addEventListener('click', () => window.api.openLogsFolder?.());
    document.getElementById('aboutConfigBtn')?.addEventListener('click', () => window.api.openSettingsFile?.());
    window.api.getBrightnessBackend?.().then((backend) => {
        const chip = document.getElementById('about-backend-chip');
        if (chip && backend) { chip.hidden = false; chip.textContent = backend; }
    }).catch(() => {});
    // --- Export / Import full data ---
    elems.exportDataBtn?.addEventListener('click', async () => {
        const result = await window.api.exportData?.();
        if (result?.success) showToast(t('toast.exportDone'));
        else if (result && !result.canceled && result.error) showToast(t('toast.exportFailed') + ' ' + (result.error || ''));
    });

    elems.importDataBtn?.addEventListener('click', async () => {
        const result = await window.api.importData?.();
        if (result?.success) {
            showToast(t('profile.importSuccess', { count: result.count }));
            invalidateHistoryChart();
            drawHistoryChart();
        } else if (result && !result.canceled && result.error) {
            showToast(t('profile.importInvalid', { reason: result.error }));
        }
    });

    elems.clearLogsBtn?.addEventListener('click', () => {
        showConfirm(
            t('confirm.clearLogsTitle'),
            t('confirm.clearLogsText'),
            t('confirm.clearLogsOk'),
            async () => {
                const result = await window.api.clearLearningLogs?.();
                if (result?.success) {
                    showToast(t('toast.historyCleared'));
                    invalidateHistoryChart();
                    drawHistoryChart();
                } else {
                    showToast(t('toast.clearFailed'))
                }
            }
        );
    });

    [elems.menuContainer, elems.footerMenuContainer].forEach(c => {
        c.addEventListener('click', handleNavClick);
        c.addEventListener('keydown', handleNavKeydown);
    });

    (elems.mainContent || document).addEventListener('click', handleStepperClick);
    (elems.mainContent || document).addEventListener('click', handleCopyClick);

    const FEATURE_LABELS = {
        webcam: 'feat.webcam',
        screen: 'feat.screen',
        ambientLight: 'feat.ambientLight',
        cloud: 'feat.cloud',
        dayLight: 'feat.dayLight',
        timeSin: 'feat.timeOfDay',
        timeCos: 'feat.timeOfDay',
        faceCount: 'feat.faceCount',
        faceBrightness: 'feat.faceBrightness',
        faceProximity: 'feat.faceProximity',
        faceCenterDeviation: 'feat.facePosition',
        lightSourceCount: 'feat.lightSources',
        visualConfidence: 'feat.imageQuality',
        batteryLevel: 'feat.batteryLevel',
        app: 'feat.activeApp',
        lightDirection: 'feat.lightDirection',
        powerSource: 'feat.powerSource',
        nightLight: 'status.nightlight',
    };
    const featureLabel = (key) => {
        const k = FEATURE_LABELS[key];
        if (!k) return key;
        const translated = t(k);
        return translated === k ? key : translated;
    };

    let lastRenderedWeights = null;
    let lastRenderedWeightsLocale = null;
    function renderWeights(weights, interactionPair) {
        if (!elems.weightsList) return;
        const sig = JSON.stringify([weights, interactionPair, getLocale()]);
        if (sig === lastRenderedWeights) return;
        lastRenderedWeights = sig;

        const merged = { ...weights };
        if (typeof merged.timeSin === 'number' || typeof merged.timeCos === 'number') {
            merged.timeSin = Math.max(merged.timeSin ?? 0, merged.timeCos ?? 0);
            delete merged.timeCos;
        }

        const entries = Object.entries(merged)
            .filter(([, v]) => typeof v === 'number')
            .sort((a, b) => b[1] - a[1]);
        const max = entries.length ? entries[0][1] : 0;

        elems.weightsList.textContent = '';
        for (const [key, value] of entries) {
            const li = document.createElement('li');

            const name = document.createElement('span');
            name.className = 'weight-name';
            name.textContent = featureLabel(key);
            li.appendChild(name);

            const bar = document.createElement('span');
            bar.className = 'weight-bar';
            const fill = document.createElement('span');
            fill.className = 'weight-fill';
            fill.style.width = max > 0 ? `${Math.max(2, (value / max) * 100)}%` : '0%';
            bar.appendChild(fill);
            li.appendChild(bar);

            const val = document.createElement('span');
            val.className = 'weight-value';
            val.textContent = value.toFixed(2);
            li.appendChild(val);

            elems.weightsList.appendChild(li);
        }

        if (elems.weightsNote) {
            const isTimePair = (k) => k === 'timeSin' || k === 'timeCos';
            let pairText = '';
            if (interactionPair) {
                const a = featureLabel(interactionPair[0]);
                const b = featureLabel(interactionPair[1]);
                pairText = a === b || (isTimePair(interactionPair[0]) && isTimePair(interactionPair[1]))
                    ? t('weights.strongestSingle', { a }) + ' '
                    : t('weights.strongestPair', { a, b }) + ' ';
            }
            elems.weightsNote.textContent = pairText + t('weights.note');
        }
    }

    let historyRangeHours = 24;
    let historyRefreshTimer = null;

    let lastChartPoints = null;
    let lastChartGeom = null;
    let lastChartRange = null;
    let lastChartFetchAt = 0;
    const CHART_CACHE_TTL_MS = 60000;

    function invalidateHistoryChart() {
        chartStaticCanvas = null;
        lastChartPoints = null;
        lastChartGeom = null;
        lastChartRange = null;
        lastChartFetchAt = 0;
    }

    function drawHistoryChart(hoverX = null) {
        const canvas = elems.historyCanvas;
        if (!canvas || !window.api?.getBrightnessHistory) return;

        const pageVisible = document.getElementById('page-status')?.classList.contains('active');
        if (!pageVisible && hoverX === null) {
            chartStaticCanvas = null;
            lastChartGeom = null;
            return;
        }

        const render = (points) => {
            if (requestedRange !== historyRangeHours) {
                drawHistoryChart();
                return;
            }
            lastChartPoints = points;
            lastChartRange = historyRangeHours;
            lastChartFetchAt = Date.now();
            if (!points || points.length === 0) {
                elems.chartEmpty.hidden = false;
                if (elems.chartCaption) setText(elems.chartCaption, '');
                chartStaticCanvas = null;
                return;
            }
            elems.chartEmpty.hidden = true;

            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const cssW = canvas.clientWidth || 720;
            const cssH = 200;
            if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
                canvas.width = cssW * dpr;
                canvas.height = cssH * dpr;
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssW, cssH);

            const padL = 30, padR = 8, padT = 8, padB = 20;
            const w = cssW - padL - padR;
            const h = cssH - padT - padB;
            const styles = getComputedStyle(document.documentElement);
            const gridColor = styles.getPropertyValue('--color-border').trim() || '#e2e8f0';
            const lineColor = styles.getPropertyValue('--color-accent').trim() || '#3b82f6';
            const textColor = styles.getPropertyValue('--color-fg-muted').trim() || '#64748b';

            const span = historyRangeHours * 3600000;
            const now = Date.now();
            const x = (t) => padL + ((t - (now - span)) / span) * w;
            const y = (b) => padT + (1 - b / 100) * h;
            lastChartGeom = { padL, padR, w, h, span, now, x, y, cssH };

            ctx.strokeStyle = gridColor;
            ctx.lineWidth = 1;
            ctx.font = '10px Inter, sans-serif';
            ctx.fillStyle = textColor;
            ctx.textAlign = 'right';
            for (const pct of [0, 25, 50, 75, 100]) {
                ctx.beginPath();
                ctx.moveTo(padL, y(pct));
                ctx.lineTo(padL + w, y(pct));
                ctx.stroke();
                ctx.fillText(String(pct), padL - 5, y(pct) + 3);
            }

            const ticks = historyRangeHours <= 24 ? 4 : 7;
            ctx.textAlign = 'center';
            for (let i = 0; i <= ticks; i++) {
                const t = now - span + (span * i) / ticks;
                const d = new Date(t);
                const label = historyRangeHours <= 24
                    ? timeFormat.format(d)
                    : `${d.getDate()}.${d.getMonth() + 1}.`;
                ctx.fillText(label, x(t), cssH - 6);
            }

            if (points.length === 1) {
                ctx.fillStyle = lineColor;
                ctx.beginPath();
                ctx.arc(x(points[0].t), y(points[0].b), 3, 0, Math.PI * 2);
                ctx.fill();
            } else {
                const floorY = padT + h;
                const hexToRgba = (hex, alpha) => {
                    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
                    if (!m) return hex;
                    const n = parseInt(m[1], 16);
                    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
                };
                const fillGradient = ctx.createLinearGradient(0, padT, 0, floorY);
                fillGradient.addColorStop(0, hexToRgba(lineColor, 0.45));
                fillGradient.addColorStop(1, hexToRgba(lineColor, 0.08));
                ctx.fillStyle = fillGradient;
                ctx.beginPath();
                ctx.moveTo(x(points[0].t), floorY);
                ctx.lineTo(x(points[0].t), y(points[0].b));
                for (let i = 1; i < points.length; i++) ctx.lineTo(x(points[i].t), y(points[i].b));
                ctx.lineTo(x(points[points.length - 1].t), floorY);
                ctx.closePath();
                ctx.fill();

                ctx.strokeStyle = lineColor;
                ctx.lineWidth = 2;
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(x(points[0].t), y(points[0].b));
                for (let i = 1; i < points.length; i++) ctx.lineTo(x(points[i].t), y(points[i].b));
                ctx.stroke();

                const manualPts = points.filter((p) => p.type === 'manual');
                ctx.fillStyle = lineColor;
                for (const p of manualPts) {
                    ctx.beginPath();
                    ctx.arc(x(p.t), y(p.b), 2.5, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            chartStaticCanvas = document.createElement('canvas');
            chartStaticCanvas.width = canvas.width;
            chartStaticCanvas.height = canvas.height;
            chartStaticCanvas.getContext('2d').drawImage(canvas, 0, 0);

            if (hoverX !== null && hoverX >= padL && hoverX <= padL + w) {
                drawChartHoverLayer(ctx, points, hoverX, { padL, padR, w, h, x, y, styles, lineColor, gridColor, textColor, cssW });
                return;
            }

            if (elems.chartCaption) {
                const last = points[points.length - 1];
                setText(elems.chartCaption, t('chart.captionNewest', { n: points.length, b: last.b, time: timeFormat.format(new Date(last.t)) }));
            }
        };

        if (hoverX !== null && lastChartPoints && chartStaticCanvas) {
            if (ensureChartGeometry()) return;
            const ctx = canvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(chartStaticCanvas, 0, 0);
            const dpr = dprOf(canvas);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const g = lastChartGeom;
            const styles = getComputedStyle(document.documentElement);
            drawChartHoverLayer(ctx, lastChartPoints, hoverX, {
                padL: g.padL, padR: g.padR, w: g.w, h: g.h,
                x: g.x, y: g.y,
                styles,
                lineColor: styles.getPropertyValue('--color-accent').trim() || '#3b82f6',
                gridColor: styles.getPropertyValue('--color-border').trim() || '#e2e8f0',
                textColor: styles.getPropertyValue('--color-fg-muted').trim() || '#64748b',
                cssW: canvas.clientWidth || 720
            });
            return;
        }

        if (hoverX === null && lastChartPoints && chartStaticCanvas && lastChartGeom
            && lastChartRange === historyRangeHours
            && (Date.now() - lastChartFetchAt) < CHART_CACHE_TTL_MS) {
            const ctx = canvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(chartStaticCanvas, 0, 0);
            const g = lastChartGeom;
            if (elems.chartCaption) {
                const last = lastChartPoints[lastChartPoints.length - 1];
                setText(elems.chartCaption, t('chart.captionNewest', { n: lastChartPoints.length, b: last.b, time: timeFormat.format(new Date(last.t)) }));
            }
            return;
        }

        const requestedRange = historyRangeHours;
        window.api.getBrightnessHistory(historyRangeHours).then(render).catch(() => {});
    }

    function dprOf(canvas) {
        return canvas.width / (canvas.clientWidth || canvas.width) || 1;
    }

    function drawChartHoverLayer(ctx, points, hoverX, { padL, padR, w, h, x, y, styles, lineColor, gridColor, textColor, cssW }) {
        let leftIdx = 0;
        for (let i = 0; i < points.length; i++) {
            if (x(points[i].t) <= hoverX) leftIdx = i;
            else break;
        }
        const rightIdx = Math.min(leftIdx + 1, points.length - 1);
        const lx = x(points[leftIdx].t);
        const rx = x(points[rightIdx].t);
        const t = rx > lx ? Math.min(1, Math.max(0, (hoverX - lx) / (rx - lx))) : 0;
        const crossY = y(points[leftIdx].b + (points[rightIdx].b - points[leftIdx].b) * t);
        const crossX = hoverX;

        let nearest = points[0];
        let bestDist = Infinity;
        for (const p of points) {
            const d = Math.abs(x(p.t) - hoverX);
            if (d < bestDist) { bestDist = d; nearest = p; }
        }

        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(crossX, 8);
        ctx.lineTo(crossX, 8 + h);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = lineColor;
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.arc(x(nearest.t), y(nearest.b), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        const label = `${nearest.b}%  ${timeFormat.format(new Date(nearest.t))}`;
        ctx.font = '600 11px Inter, sans-serif';
        const tw = ctx.measureText(label).width;
        const bx = Math.min(Math.max(crossX - tw / 2 - 6, padL), padL + w - tw - 12);
        const by = Math.max(Math.min(crossY, y(nearest.b)) - 26, 2);
        ctx.fillStyle = styles.getPropertyValue('--color-fg').trim() || '#0f172a';
        ctx.beginPath();
        ctx.roundRect(bx, by, tw + 12, 18, 4);
        ctx.fill();
        ctx.fillStyle = styles.getPropertyValue('--color-bg').trim() || '#f8fafc';
        ctx.textAlign = 'left';
        ctx.fillText(label, bx + 6, by + 13);

        if (elems.chartCaption) {
            setText(elems.chartCaption, t('chart.captionHover', { n: points.length, b: nearest.b, time: timeFormat.format(new Date(nearest.t)) }));
        }
    }

    function scheduleChartHover(clientX) {
        const canvas = elems.historyCanvas;
        if (!canvas || !lastChartGeom || !lastChartPoints?.length || !chartStaticCanvas) return;
        chartHoverTargetX = clientX - canvas.getBoundingClientRect().left;
        if (chartHoverRaf) return;
        chartHoverRaf = requestAnimationFrame(() => {
            chartHoverRaf = 0;
            if (chartHoverTargetX !== null) drawHistoryChart(chartHoverTargetX);
        });
    }

    elems.historyCanvas?.addEventListener('mousemove', (e) => scheduleChartHover(e.clientX));
    elems.historyCanvas?.addEventListener('pointerdown', (e) => scheduleChartHover(e.clientX));
    elems.historyCanvas?.addEventListener('pointerleave', () => {
        if (chartHoverRaf) { cancelAnimationFrame(chartHoverRaf); chartHoverRaf = 0; }
        chartHoverTargetX = null;
        drawHistoryChart();
    });

    document.querySelectorAll('.range-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.range-btn').forEach((b) => {
                b.classList.toggle('active', b === btn);
                b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
            });
            historyRangeHours = Number(btn.dataset.range) || 24;
            chartHoverTargetX = null;
            drawHistoryChart();
        });
    });

    let activityPollTimer = null;
    let lastActivityLabel = null;
    let activityPauseRow = null;
    const startActivityPoll = () => {
        if (activityPollTimer) return;
        const tick = async () => {
            const res = await window.api.checkActivityWindow?.();
            if (!res) return;
            if (res.label !== lastActivityLabel) {
                lastActivityLabel = res.label;
                requestUIUpdate(() => {
                    const statusPage = document.getElementById('page-status');
                    if (!statusPage) return;
                    if (res.label) {
                        if (!activityPauseRow) {
                            activityPauseRow = document.createElement('div');
                            activityPauseRow.className = 'pause-row activity-paused-row';
                            const statusCard = statusPage.querySelector('.status-card .card-body');
                            statusCard?.appendChild(activityPauseRow);
                        }
                        activityPauseRow.textContent = t('activities.pausedBy', { activity: res.label });
                        activityPauseRow.hidden = false;
                    } else if (activityPauseRow) {
                        activityPauseRow.hidden = true;
                    }
                });
            }
        };
        tick();
        activityPollTimer = setInterval(tick, 10000);
    };

    const startHistoryRefresh = () => {
        if (historyRefreshTimer) return;
        drawHistoryChart();
        historyRefreshTimer = setInterval(() => {
            if (document.getElementById('page-status')?.classList.contains('active')) drawHistoryChart();
        }, 60000);
    };
    const ensureChartGeometry = () => {
        const canvas = elems.historyCanvas;
        if (!canvas || !lastChartPoints?.length) return false;
        const expectedW = Math.round((canvas.clientWidth || 720) * (window.devicePixelRatio || 1));
        if (canvas.width !== expectedW || !chartStaticCanvas || chartStaticCanvas.width !== canvas.width) {
            drawHistoryChart();
            return true;
        }
        return false;
    };

    let resizeRedraw = null;
    {
        let resizePending = false;
        resizeRedraw = () => {
            if (!document.getElementById('page-status')?.classList.contains('active')) return;
            if (resizePending) return;
            resizePending = true;
            requestAnimationFrame(() => {
                resizePending = false;
                drawHistoryChart();
            });
        };
    }
    window.addEventListener('resize', resizeRedraw);

    Object.values(elems.inputs).forEach(input => input && input.addEventListener('input', debouncedSave));
    $('cameraDeviceSelect')?.addEventListener('change', handleSettingsChange);
    $('targetDisplaySelect')?.addEventListener('change', handleSettingsChange);
    elems.inputs.adjustDuringLearning?.addEventListener('change', () => {
        const checked = elems.inputs.adjustDuringLearning.checked;
        setText($('adjustDuringLearningState'), checked ? t('settings.on') : t('settings.off'));
        lastKnownLearningState.adjustDuringLearning = checked;
        handleSettingsChange();
    });

    if (window.api) {
        window.api.onWeatherUpdate?.(updateLocationUI);
        window.api.onDynamicStatusUpdate?.(updateStatusUI);
        window.api.onLogUpdate?.(updateLogsUI);
        window.api.onUpdateAvailable?.(showUpdateBanner);
        window.api.onOsSupportUpdate?.(renderOsSupport);
        window.api.onSettingsUpdated?.(({ settings, learningConfig }) => {
            applyConfig(settings, { skipIfCurrent: true });
            updateProfileUI(settings, learningConfig);
        });

        (async () => {
            try {
                const [username, savedSettings, learningConfig] = await Promise.all([
                    window.api.getUsername(),
                    window.api.loadSettings(),
                    window.api.loadLearningConfig(),
                ]);
                if (learningConfig && typeof learningConfig.learningMode === 'boolean') {
                    lastKnownLearningState.learningComplete = !learningConfig.learningMode;
                }
                applyConfig(savedSettings);
                applyAppLanguage(savedSettings?.language || savedLocale);
                setText(elems.profile.username, username || t('profile.userFallback'));
                updateProfileUI(savedSettings, learningConfig);
                startPowerRefresh();
                startActivityPoll();
                startHistoryRefresh();
                populateDeviceSelects();
                elems.logsList.innerHTML = `<li><span>--:--</span> ${t('status.ready')}</li>`;
                setTimeout(() => {
                    window.api.getOsSupport?.().then((osSupport) => {
                        if (osSupport) renderOsSupport(osSupport);
                    }).catch(() => {});
                    populateDeviceSelects();
                }, 2500);
            } catch (err) {
                console.warn('Init incomplete:', err);
                setText(elems.profile.username, t('profile.userFallback'));
                updateUIVisibility();
            }
        })();
    }
});