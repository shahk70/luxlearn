# Changelog

## [1.2.4] - 2026-09-06

### Added
- **In-app updates**: a new version is detected automatically once a day and
  on every manual check — no GitHub visit needed. The banner gains an
  "Update now" button that downloads the new installer inside the app with a
  live progress percentage, then offers "Restart & install". Users can still
  open the GitHub release page from the banner. Falls back to the notify-only
  link if the updater can't reach the release feed.
- **Bundled weather keys**: six public WeatherAPI.com keys ship with the app,
  so sunrise/sunset and cloud-cover work out of the box with no `.env` setup.
  Your own keys (optional, in local `.env`) always take priority and are
  never shared.

### Fixed
- Learning phase lifecycle: resetting settings now restarts the learning
  phase from day 0; importing a backup restores its learning-phase state;
  changing the learning duration re-bases the phase timer so the profile
  counter matches the new expectation.
- Status page fields no longer stick at "--": the Auto Brightness row id was
  fixed, and push events that arrive before the UI finishes loading are now
  buffered and replayed instead of dropped.
- Weather API key selection: keys are never reused within one retry cycle
  (up to 3 distinct keys tried per request).

## [1.2.3] - 2026-09-06

### Added
- **Public WeatherAPI keys bundled** (intermediate release superseded by
  1.2.4's in-app updater work): fresh installs get live weather data with
  zero configuration.

## [1.2.2] - 2026-09-06

### Added
- **Device support expansion**: chained camera backends (CommandCam → ffmpeg
  DirectShow on Windows; imagesnap → ffmpeg on macOS; fswebcam → ffmpeg on
  Linux) with automatic fallback and user-selectable cameras and displays in
  Settings.
- **DDC/CI brightness control** for external monitors on Windows; macOS gains
  `ddcctl` support for Intel Macs with external displays; Linux xrandr now
  adjusts every connected output instead of only the first.
- **Broader ambient-light sensing**: more Linux IIO channel variants
  (`in_illuminance0_*`, `in_illuminance_mean*`), re-probing instead of
  permanent caching, webcam-exposure fallback when no light sensor exists.
- **Rename to LuxLearn**: new product identity, icons, and GitHub home
  (shahk70/luxlearn); GitHub Releases now build Windows/macOS/Linux
  installers automatically on every `v*` tag.

### Fixed
- Status warnings for external-display DDC/CI and Wayland xrandr
  limitations, in all 8 interface languages.

## [1.2.0] - 2026-09-02 (history continues — entries below unchanged)

- **Activities page**: automatic pausing of brightness adjustments while an
  activity is running. Built-in Gaming (fullscreen + known game
  processes/titles) and Watching Video (known player apps) triggers, plus
  user-specified activities matched by process name or window title.
  Custom activities can be added, enabled/disabled, and deleted; the engine
  pauses when a match is detected and resumes when it ends.
- **About page**: app version display, GitHub repository link, and a
  Check for Updates button with inline result.
- **Export / Import full data**: one-click backup of all settings,
  learning history, and activities to a JSON file; import validates the
  file (format, version, shapes) and reports precise errors.

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.1.3] - 2026-08-31

### Added
- **Custom frameless titlebar** coordinated with the app design: drag
  region with the app logo/title, Minimize / Maximize / Hide-to-tray
  buttons styled like the rest of the UI (window is borderless now).
- **"Adjust during learning phase" option** (sub-card under the auto
  brightness switch, visible while learning is active): when off, the
  engine keeps logging and learning but never changes brightness until
  learning completes.
- **Adaptive webcam capture**: the camera's settle time (auto-exposure
  convergence, focus) is learned per device instead of using a fixed delay
  for all webcams. Frames taken while the camera is still adjusting are
  detected and recaptured; the learned warmup is persisted and probing is
  limited to twice a day.
- **Brightness History chart** on the Status page: a canvas line chart of
  logged brightness over the last 24 hours or 7 days (toggle in the card
  header), with area fill, gridlines, time axis, and dots marking manual
  changes. Hover shows a crosshair with the exact value and time. No new
  dependencies. Refreshes every minute and redraws on window resize.
- **Pause adjustments**: new tray-menu entry with "1 hour / 4 hours / until
  tomorrow 8:00 AM", plus Pause/Resume buttons on the Status page. While
  paused, the tray shows "Resume (until HH:MM)" and "Next Adjustment" in
  the UI shows the resume time.
- **"What the Engine Learns" panel** on the Status page: horizontal bars
  for every feature's learned importance weight (longest = strongest
  influence), with a note naming the current feature interaction pair.
- **Export Logs (CSV)** and **Clear Learning History** buttons on the User
  Profile page. Export writes all logs (timestamp, brightness, signals)
  to a CSV file via a save dialog; Clear wipes the learning log, resets
  feature statistics and restarts the learning phase (with confirmation).
- **Theme selector** in the sidebar: Light / System / Dark, overriding the
  OS preference; choice persists across restarts (localStorage).
- Sidebar navigation is now keyboard accessible (focusable, Enter/Space to
  activate, ARIA tab semantics, visible focus ring), and the window has
  minimum dimensions (720×520).
- Advanced settings ("Learning Phase & Intervals") remain visible while
  auto-brightness is off — dimmed and non-interactive — so they can be
  preconfigured before enabling.
- **Adjustable adjustment threshold** in the Learning Phase & Intervals
  settings ("Adjustment Threshold (%)", 0–25, default 2). This is the
  hysteresis floor previously hardcoded at 2% for brightening / 2.5% for
  dimming: the brighten threshold equals the set value and dimming uses
  1.25× it, preserving the old 2%/2.5% behavior at the default. The
  confidence multiplier (up to 2.5× at low confidence) still applies on
  top, so values in the log like "below threshold 3.0%" scale with the
  setting. Set 0 to react to every cycle's prediction.

### Fixed
- The webcam learning feature now carries the camera's measured light
  **exposure** (face brightness when a face is detected, whole-frame mean
  otherwise, 0–255 linear) instead of the image-quality score. The old
  score saturated at 0 in dark scenes (40% of real-world samples) and mixed
  quality penalties (backlight, blur, color tint) into what the engine
  treated as a light signal, destroying its correlation with chosen
  brightness. The quality score is still used for image confidence.
- The fallback estimate's visual signal is now decoded back to a 0–100
  percent correctly (old formula misread the log-scaled 0–255 exposure).
- Theme toggle now shows an icon for all three states (sun = light,
  moon = dark, target image = follow system) and lives inside the sidebar
  header next to the app title.
- "What the Engine Learns" merges the two halves of the circular
  time-of-day encoding (sin + cos) into a single "Time of day (cycle)"
  row instead of showing two identical labels.
- The update banner was always visible with its default "A new version is
  available." text and dead buttons: the stylesheet's `display: flex` on
  `.update-banner` overrode the `hidden` attribute, and the button handlers
  were only attached when a real update arrived. The banner now toggles the
  `hidden` attribute (with a global `[hidden] { display: none !important }`
  utility rule), so it stays hidden until an actual update notification, and
  "View release" / "Dismiss" work.
- Windows Night Light was reported as Off while it was on: the CloudStore
  state byte's low nibble (e.g. `0x12` with the modern schedule) wasn't
  recognized as "on" — only the older `0x15`/`0x1F` values were. Any set bit
  in the low nibble now means the filter is active.
- The "Low-power Mode" row on the Status page could show as a bare label with
  an empty value: the `dt` element's flex display defeated the `hidden`
  attribute while the paired `dd` stayed hidden. Covered by the same
  `[hidden]` fix; when a weak device hasn't tripped throttling the row now
  reads "Standby" instead of the confusing "Not needed".

## [1.1.2] - 2026-08-31

### Added
- **Automatic low-power mode** for weak devices: when the machine has ≤2
  CPU cores, a sub-2 GHz top core, or ≤4 GB RAM — or when adjustment cycles
  are consistently slower than 60% of the adjustment interval — the app
  throttles expensive signal sampling. Face detection (the heaviest stage,
  ~50% of webcam analysis time) runs every 5th cycle with the last result
  reused in between; power and night-light reads are cached for 10 minutes.
  Transitions are logged and shown as a "Low-power Mode" row on the Status
  page.
- The manual-change poll interval now has an effective 3-second floor on
  all devices (also enforced for saved settings below 3 s), preventing
  near-continuous PowerShell process churn that a 1-second poll caused on
  Windows.

## [1.1.1] - 2026-08-31

### Removed
- The fullscreen media pause introduced in 1.1.0: pausing adjustments during
  fullscreen playback backfired in a common scenario — watching a dark
  video fullscreen at high brightness, then exiting fullscreen leaves a
  suddenly bright screen that needs an immediate dim, which the pause
  blocked. Adjustments now always run (hysteresis and confidence blending
  remain in place to avoid flicker).

### Added
- **Night Light awareness** (learning feature): the OS blue-light filter
  state (Windows Night Light, macOS Night Shift via the `nightlight` CLI if
  installed, Linux GNOME Night Light / redshift / gammastep) is detected,
  stored with every log as the `nightLight` categorical feature, and shown
  on the Status page — so the engine can learn that warmer/dimmer screens
  change the preferred brightness.

## [1.1.0] - 2026-08-31

### Added
- **Power signal**: the learning engine now also uses power source (AC vs
  battery) and battery level as features; the fallback estimate assumes
  ~10% dimmer on battery. Power state is shown on the Status page.
- **System Warnings** section on the Status page: missing brightness
  backends, missing webcam capture tools, and (macOS) denied TCC
  permissions, with a shortcut to the relevant System Settings pane.
- **macOS**: tray-only operation (Dock icon hidden), template-image tray
  icon, camera permission prompt when undetermined, and `m1ddc` support for
  external displays on Apple Silicon.
- **Linux**: XDG autostart entry (`.desktop` file) is written/removed for
  start-with-system, since Electron's `setLoginItemSettings` is a no-op on
  Linux.
- Windows brightness get/set now falls back to `Get-CimInstance`/
  `Invoke-CimMethod` when the legacy `Get-WmiObject` cmdlets are unavailable
  (PowerShell 7-only systems).
- `app/images/icon.png` is now included and used for the tray icon on
  macOS/Linux (the `.ico` remains Windows-only).

### Fixed
- "Start with system" and the auto-brightness toggle no longer control each
  other: `openAtLogin` now follows only the `startWithSystem` setting (and
  is applied in dev mode too).

## [1.0.1] - 2026-08-31

### Fixed
- `weather.js` never read the configured WeatherAPI keys (`.env` used a
  misspelled variable the code didn't look for), so live weather/cloud data
  silently degraded to cached/fallback values. Keys are now read from
  `WEATHERAPI_KEYS` (comma-separated) or the legacy single `WEATHERAPI_KEY`.
- WeatherAPI astro sunrise/sunset times ("hh:mm AM/PM") are now parsed
  explicitly instead of relying on engine-specific `Date` string parsing.
- Predictions blended from the learned model and the fallback estimate are
  now clamped to the valid 0–100 brightness range before hysteresis/step
  limiting is applied.
- The nearest-log fallback is no longer used unconditionally: it is skipped
  when the nearest log is too far from current conditions (absolute distance
  cap plus the same dynamic band used for relevant-log selection), so a
  stale neighbor can't hijack the fallback while confidence is low.
- Features with too few observations (fewer than 5 samples) are now excluded
  from log-distance computation instead of being scored against immature
  statistics, which made early rankings noisy.
- Manual brightness changes are now confirmed stable (re-read after ~1.5 s)
  before being logged as user intent, so transient writes from other apps
  (Night Light, games, other tools) no longer pollute the learning log.

### Changed
- Brightness hysteresis raised from 1% to 2% (brighten) / 2.5% (dim) and the
  minimum automatic write from 1% to 2%, reducing frequent sub-2% adjustments
  on every cycle.
- The recency boost window is now a fixed 30 minutes instead of a multiple of
  the unrelated auto-adjustment interval.

## [1.0.0] - Unreleased

### Added
- Public release preparation: README, LICENSE (MIT), CONTRIBUTING,
  SECURITY, THIRD_PARTY_NOTICES, `.gitignore`, `.env.example`.
- Lightweight in-app update notifier (`updateChecker.js`) that checks
  GitHub Releases and shows a dismissible in-app banner.
- GitHub Actions workflows: CI build check on push/PR, and a release
  workflow that packages the app for Windows/macOS/Linux on tag push.
- `dotenv` is now actually loaded (`index.js`), so `.env` values take
  effect.

### Fixed
- Removed a hardcoded fallback WeatherAPI key from `weather.js`; the key
  must now be supplied via the `WEATHERAPI_KEY` environment variable
  (see `SECURITY.md`).
- Removed a maintainer-specific local file path from a code comment in
  `app/app.js`.
- Removed the unused `node-cache` dependency from `package.json`.

### Changed
- `app/style.css` is now a generated build artifact (`npm run build:css`,
  wired into `postinstall`/`start`/`dev`) instead of being hand-edited; the
  source of truth is `app/style.scss`.
