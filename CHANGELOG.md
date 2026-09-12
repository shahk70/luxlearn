# Changelog

## [1.4.1] - 2026-09-12

### Fixed
- **Start-with-Windows no longer duplicates itself**: the app registered
  its startup entry under a different internal name than the installer
  used, so a second entry appeared (and came back after every update).
  Both now agree on one entry, and any leftover duplicates from older
  installs are cleaned up automatically on the next start and the next
  install.
- **"Pin to taskbar" checkbox now does something**: it previously
  called a Windows function that modern Windows silently ignores, so
  nothing ever happened. There is no supported way for an installer to
  pin silently — checking the box now makes the app show a one-time
  note on next start explaining how to pin it yourself (right-click the
  running icon → Pin to taskbar).
- **Learning panel labels**: "Ambient light sensor" is now just
  "Ambient light" — on machines without a hardware light sensor that
  reading has always been a camera estimate, and the label implied
  hardware you don't have. The new light-color reading also has a
  proper name in all languages.

## [1.4.0] - 2026-09-11

### Added
- **Raw camera support**: if your camera can stream unprocessed sensor
  data (Bayer raw), LuxLearn now captures and analyzes it directly —
  no auto-exposure or color processing in between. Room light is read
  from the sensor's own green channel, which doesn't hunt or drift the
  way the old estimate could, and every reading also records the light
  color (color temperature) — warm lamp vs. cool daylight become
  distinguishable signals the app learns from. Cameras that can't do
  raw work exactly as before; nothing changes unless your camera
  offers it.

### Fixed
- **Steadier battery readings**: on some Windows machines the battery
  percentage flickered between 1% and full charge from one reading to
  the next, which polluted learning. A reading now has to repeat
  before it counts.
- **Smoother room-light readings when you move in and out of frame**:
  the estimate no longer jumps when face detection flickers; it glides
  over a short window instead.
- **Weather data now refreshes reliably**: the previous weather
  provider stopped accepting the bundled keys, so readings went stale.
  A free keyless provider is now tried automatically, so cloud cover
  and sunrise/sunset stay current again.
- **Time-of-day signals no longer freeze**: a noise filter was
  occasionally smoothing away real clock movement, leaving
  day-progress hints stuck. Time signals now always advance.

## [1.3.4] - 2026-09-10

### Fixed
- **Linux brightness read no longer crashes**: a missing internal cache
  variable made the brightness reading on Linux throw when the display's
  current value couldn't be parsed, breaking adjustment cycles on xrandr
  systems. It now falls back to the last set value (or 100%) as intended.
- **Updater events no longer race app startup**: two internal constants
  used by the update checker were declared after the code that uses them,
  so an update notification arriving in the first moments after launch
  could crash the update handlers. The constants now live at the top of
  the module where they belong.
- **Linux display-name safety**: display names read from xrandr are now
  validated before being passed to shell commands, and the parser no
  longer accepts malformed names (e.g. "connectedVPN").

## Changed
- Internal code cleanups: duplicate distance-threshold math folded into
  one shared method, dead code removed. No behavior changes beyond the
  fixes above.

## [1.3.3] - 2026-09-09

### Fixed
- **Light direction finally points at the light**: the old math compared the
  brightness of whole frame halves, so even an obvious window blob read as
  "Top" most of the time. The direction now comes from where the actual
  bright regions sit in the frame (verified on controlled test images: top,
  left, right, bottom and centered blobs all report correctly), with a
  strength value so weak/imprecise readings can be told apart from strong
  ones.
- **Clearer "where did this reading come from" data**: the room-light value
  now records whether it was read from your face or from the whole scene,
  making logs and troubleshooting easier to interpret.

## [1.3.2] - 2026-09-09

### Fixed
- **Webcam room-light estimate now accounts for whether you're in frame**:
  when you're visible, the camera exposes for your face and the room-light
  estimate comes from the face reading; when you step away, the camera
  re-meters the whole scene, so the estimate switches to the full-frame
  exposure reading (with the value clamped into the range the estimate was
  calibrated for). Live-tested: in-frame estimates stay in a tight band
  while out-of-frame monitor-in-view scenes no longer drag them around.

## [1.3.1] - 2026-09-09

### Changed
- **Smarter ambient-light reading from the camera**: pixels are now converted
  to linear light before averaging (previously the camera's gamma-compressed
  values were averaged directly, understating how much the room actually
  changed), and the room-light estimate now uses the median of an 8×6 grid
  over the frame — a bright lamp or a dark corner in view no longer drags
  the reading away from the light you actually work in.
- **More robust captures on macOS/Linux**: the native capture tools now
  save lossless PNG instead of JPEG, and the analysis worker accepts any
  image format the capture backends can produce (BMP, PNG, JPEG), so a
  format mismatch can no longer break webcam readings.

## [1.3.0] - 2026-09-09

### Changed
- **Full-resolution webcam analysis**: frames are no longer shrunk to 320×240
  before analysis or 640px for face detection. Every check (face detection,
  light estimation, blur, color balance) now runs on the camera's native
  pixels, so faces are found more reliably and readings are sharper — with
  no measurable cost: a full 1280×720 analysis takes about 0.3 s on modest
  hardware.
- **Resolution-independent face features**: how close you sit and how far
  off-center you are now adapt to your camera's resolution, so logs stay
  comparable when the capture size differs between devices.

## [1.2.9] - 2026-09-09

### Fixed
- **Webcam barely reacted to real light changes**: three separate problems
  stacked up. (1) When a lamp or poster triggered a second "face" detection,
  all detections were averaged together — a bright lamp dragged the face
  reading down and could invert the dim-vs-bright ordering. The face signal
  now comes from the center-most detection (the user sits in front of the
  laptop). (2) Without an ambient-light sensor, room light was estimated
  with a flat log curve that mapped the camera's compressed readings onto an
  even narrower band; it now applies an inverted-gamma correction that
  recovers real light ratios (verified ~4x across a 4x lighting change,
  versus ~1.2x before). (3) The frame-quality confidence score was buried
  under camera sensor noise and read ~30 in every scene; it now uses the
  worker's quality score, which tracked 33 (dim) → 58 (room light) → 81
  (bright) in live testing.

## [1.2.8] - 2026-09-09

### Fixed
- **Webcam frames tinted cold/blue**: `bmp-js` 0.1.0 decodes 24-bit BMPs as
  `[0, B, G, R]` per pixel (misread as 32-bit ABGR), so the zero byte landed
  in the blue channel of the analysis Mat — frames read "Too Cold/Blue" and
  one channel was effectively dead. The worker now reorders to proper RGBA
  with alpha=255 before analysis.
- **`clippedWhitesPct` was a dead cue**: the clip threshold sat at 250, but
  this sensor's histogram tops out at ~224-233 (p99) even with the monitor
  in frame. Recalibrated to 230 so real highlight content registers.
- **Webcam-as-lux fallback ignored faces**: when no ambient-light sensor is
  available, the webcam now estimates room light from the face-patch mean
  instead of the frame mean — auto-exposure pins the global mean flat
  (identical values for hours across a 4x light swing) while face means
  tracked 46-84 over the same conditions. Falls back to the global mean
  when no face is in frame.

### Added
- **p50 / p90 / p95 webcam stats** exported as AE-invariant light
  diagnostics (visible in webcam logs) — auto-exposure keeps the mean
  pinned, so the histogram median and bright-tail percentiles carry the
  real room-light variance.

### Verified
- A same-frame audit (one BMP fed to both the analysis worker and an
  independent sharp+JS reference) confirms every exported camera signal:
  exposure/face ROI mean, face brightness, percentiles, clip/crush %,
  noise, color diagnosis, light direction, and light-source count all
  match the reference on the identical buffer.

## [1.2.7] - 2026-09-07

### Fixed
- **"Restart & install" finally performs the install**: the installer launch
  was aborted by the app's hide-to-tray close handler (quit never completed),
  so the update only applied later on a manual quit — requiring a second
  manual launch. The install path now marks the quit as final first, and the
  shutdown round-trip no longer races the detached installer.

## [1.2.6] - 2026-09-07

### Fixed
- **"Restart & install" did nothing**: the banner tracked the downloaded
  update under a differently-formatted version string ("v1.2.5" vs "1.2.5"),
  so the click never reached the install step. Versions are now normalized
  everywhere, and a failed install attempt resets the banner to the download
  step instead of hanging.
- **Update metadata missing from releases** (fixed during 1.2.5 but worth
  noting): releases now publish `latest.yml` and `.blockmap`, which
  electron-updater needs to download installers.

## [1.2.5] - 2026-09-07

### Changed
- **Battery influence reshaped to scarcity**: battery levels of 50% or more
  all map to the same feature value, so everyday charge drift (100 → 80,
  or sitting at any healthy charge) no longer shifts predictions. Only
  genuinely low battery (below 50%) pulls the feature down, linearly to 0
  at empty. Existing logs with raw percentages migrate automatically.

### Fixed
- **Webcam score variance** (from 1.2.4 investigation, now shipped): camera
  auto-exposure pins the frame mean, which made the learned webcam signal
  repeat identical values for hours. The signal now blends in AE-invariant
  crushed-black/clipped-white tail fractions, so dark and bright rooms score
  distinctly despite auto-exposure compensation.

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
