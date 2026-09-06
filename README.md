# LuxLearn

A cross-platform Electron desktop app that automatically adjusts your screen
brightness. Instead of a fixed day/night curve, it blends several signals —
an ambient light sensor (if your device has one), your webcam, the average
brightness of your screen content, and time of day / sunrise-sunset — and
*learns* from every manual brightness change you make, so it gradually leans
on your own habits instead of a generic estimate.

## Features

- Ambient light sensor support (Windows `Windows.Devices.Sensors.LightSensor`,
  Linux `/sys/bus/iio`, macOS `AppleALSSensorValue`), with webcam / screen
  content analysis as a fallback signal.
- Face detection (OpenCV.js + Haar cascade) to weight brightness toward faces
  in frame rather than the whole scene.
- Sunrise/sunset aware time-of-day estimate, either from your location
  (via IP geolocation + WeatherAPI) or custom hours you set yourself.
- Online learning: every manual brightness change you make is confirmed
  stable (to avoid mistaking transient writes from other apps for your
  intent), logged, and used to refine future predictions (see
  `BrightnessManager.js`), with a confidence score shown in the UI.
- Lightweight in-app update notifications (checks GitHub Releases; see
  [Updates](#updates) below).
- System tray icon with a quick on/off toggle.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- **Windows**: brightness control uses WMI (`WmiMonitorBrightness` via
  `Get-WmiObject`, with a `Get-CimInstance` fallback for PowerShell 7+
  systems), which only works on laptop-style internal displays — external
  monitors usually aren't supported by Windows' own brightness API.
- **macOS**: requires the [`brightness`](https://github.com/nriley/brightness)
  CLI for built-in displays: `brew install brightness`. For external
  displays on Apple Silicon, also install [`m1ddc`](https://github.com/waydabber/m1ddc):
  `brew install m1ddc` (either tool is sufficient; whichever is found first
  is used).
  - **Permissions**: macOS requires Screen Recording permission for screen
    sampling and Camera permission for webcam sampling. The app detects
    missing permissions and shows a "System Warnings" section on the Status
    page with a shortcut to the right System Settings pane.
  - The app is tray-only: the Dock icon is hidden and the app lives in the
    menu bar.
- **Linux**: requires one of `brightnessctl` (recommended — hardware
  backlight, works on both X11 and Wayland), `light`, `ddcutil` (for
  external/DDC-CI monitors), or `xrandr` (X11-only software fallback — does
  *not* work on Wayland). Missing tools are reported on the Status page.
  - **Start with system**: Electron's `setLoginItemSettings` is a no-op on
    Linux, so the app writes an XDG autostart entry
    (`~/.config/autostart/luxlearn.desktop`) instead.
- A working camera + `fswebcam` (Linux) / `imagesnap` (macOS, via
  `brew install imagesnap`) / bundled `CommandCam.exe` (Windows, via
  `node-webcam`) if you want webcam-based brightness sampling. The app
  degrades gracefully if no camera is available, and reports the missing
  tool on the Status page.

### Cross-platform notes

- **Low-power mode (automatic)**: on weak hardware (≤2 CPU cores, top core
  < 2 GHz, or ≤4 GB RAM) — or whenever adjustment cycles are consistently
  slower than 60% of the adjustment interval — the app throttles itself:
  face detection runs every 5th cycle (last result reused in between), and
  power/night-light reads are cached for 10 minutes. The Status page shows
  a "Low-power Mode" row when active. The manual-change poll loop is
  additionally floored at 3 s on every device, so a very low poll interval
  can't spawn a PowerShell process every second.
- **Night Light awareness**: the app detects the OS blue-light filter
  (Windows Night Light, macOS Night Shift via the `nightlight` CLI if
  installed, Linux GNOME Night Light / redshift / gammastep) and stores it
  with every log as a learning feature, so it can learn how your preferred
  brightness differs when the screen is warmed. The current state is shown
  on the Status page.
- **Power signal**: the app learns whether you prefer a different brightness
  on AC power vs battery, and the fallback estimate assumes ~10% dimmer on
  battery. Both signals are shown on the Status page.
- **macOS packaging** additionally needs an `.icns` icon
  (`app/images/icon.icns`); generate one from a 1024px PNG once with e.g.
  `npx icon-gen` before running `npm run package:mac`. A
  `app/images/icon.png` (used for the tray on macOS/Linux) is included.

## Getting started

**Just want to use LuxLearn?** Download the installer for your OS from the
[Releases page](https://github.com/shahk70/luxlearn/releases) and run it —
no Node.js, no cloning, no terminal required:

- **Windows**: `LuxLearn-<version>-Setup.exe` — a standard installer
  (desktop + Start Menu shortcuts, optional start-with-Windows).
- **macOS**: `LuxLearn-<version>.dmg` — open it and drag LuxLearn to
  Applications. The app is unsigned, so on first launch right-click →
  **Open** (or allow it under System Settings → Privacy & Security).
- **Linux**: `LuxLearn-<version>.AppImage` — `chmod +x` it and run, or
  install the `.deb` with your package manager.

After installing, grant permissions if prompted: on macOS the app asks for
Screen Recording (screen sampling) and Camera access; on Windows/Linux
nothing extra is needed. Webcam-based sensing is optional — the app works
without a camera and tells you on the Status page if a capture tool is
missing.

### Running from source (developers)

```bash
git clone https://github.com/shahk70/luxlearn.git
cd luxlearn
npm install          # also compiles app/style.scss -> app/style.css
cp .env.example .env # optional, see "Configuration" below
npm start
```

`npm run dev` is equivalent to `npm start` for local development.

### Configuration

The app ships with bundled WeatherAPI keys, so location-based sunrise/sunset
and cloud-cover data work out of the box — no configuration needed. If you
want to add your own keys (free at <https://www.weatherapi.com/>), copy
`.env.example` to `.env` and set `WEATHERAPI_PRIVATE_KEYS` (tried first, in
order) or `WEATHERAPI_KEYS` (joined with the bundled pool). One key is picked
per request and a rejected key (invalid, out of quota, or blocked)
automatically retries with a different one. **`.env` is git-ignored on
purpose; never commit real API keys.**

### Building a distributable

```bash
npm run dist:win     # -> LuxLearn-<version>-Setup.exe (NSIS installer)
npm run dist:mac     # -> LuxLearn-<version>.dmg
npm run dist:linux   # -> LuxLearn-<version>.AppImage + .deb
```

These use `electron-builder`. macOS packaging additionally needs
`app/images/icon.icns` (see [Assets](#assets)).

### Downloading a published release (no build needed)

Every `v*` tag pushed to this repo triggers `.github/workflows/release.yml`,
which builds all three OS packages on GitHub's servers and attaches them to
a GitHub Release. To ship a new version — including your very first
installer:

```bash
npm version 1.2.3        # bumps package.json + package-lock.json, creates the tag
git push origin main --tags
```

Then wait ~10–20 minutes on the [Actions tab](https://github.com/shahk70/luxlearn/actions),
and the files appear under [Releases](https://github.com/shahk70/luxlearn/releases),
ready to download. Nothing is built on your machine — your PC stays clean.

## Updates

The update checker (inlined in `app/app.js`) polls the GitHub Releases API
once a day for a newer tag than the running app's `package.json` version,
and shows a dismissible banner in-app with a link to the release — it does
**not** auto-download or auto-install anything. It is pre-configured for
`shahk70/luxlearn` (`REPO_OWNER` / `REPO_NAME` at the top of `app/app.js`).

If you'd rather have real auto-install updates, swap this module for
[`electron-updater`](https://www.electron.build/auto-update) +
`electron-builder`; that requires setting up code signing and a configured
publish target, which is why it isn't the default here.

To make the update checker actually have something to find, push a `v*` tag
as shown in [Downloading a published release](#downloading-a-published-release-no-build-needed)
— `.github/workflows/release.yml` then builds and publishes the GitHub
Release automatically.

## Assets

All UI assets (`app/images/icon.ico`, `icon.png`, `donate.jpg`) are included.
For macOS packaging you additionally need `app/images/icon.icns` — generate
one from a 1024px PNG once with e.g. `npx icon-gen` before running
`npm run dist:mac`.

## Project structure

```
index.js                 entry point, loads .env then starts app/app.js
core.js                  shared foundation: paths, settings schema, JSON
                         persistence, PowerShell/exec helpers
signals.js               per-OS interfacing: brightness get/set, ambient
                         light sensor, power/battery, night light, device
                         profile, active window, screen sampling
app/
  app.js                 Electron main process (windows, tray, IPC, update
                         checker, macOS permissions)
  preload.js             contextBridge API exposed to the renderer
  i18n.js                merged translation catalog + runtime helpers
  index.html / renderer.js / style.scss   UI
BrightnessManager.js      learning algorithm + adjustment loop
webcam.js / webcamAnalysis_worker.js   webcam capture + OpenCV analysis
weather.js                geolocation + sunrise/sunset/cloud data
```

## Privacy

Ambient-light/webcam/screen samples and the logs derived from them are
stored locally only (Electron's `userData` folder, via `core.js`) and are
never uploaded anywhere. The only outbound network calls are:
IP geolocation (`ipapi.co`), sunrise/sunset + cloud cover
(`api.weatherapi.com`, only if you set a key), and the update check
(`api.github.com`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) — in particular, if you're forking a copy of
this project that previously had real API keys committed to `.env` or
`weather.js`, **rotate those keys immediately**; anything ever pushed to a
public git history should be considered compromised.

## License

[MIT](LICENSE).

## Third-party notices

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), in particular for the
bundled Haar cascade model's Intel/OpenCV license.
