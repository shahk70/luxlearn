# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public GitHub
issue — use GitHub's "Report a vulnerability" button under this repo's
Security tab, or email the maintainer directly. Include reproduction steps
and, if relevant, which OS/Electron version you tested on.

## WeatherAPI keys

`weather.js` bundles a small pool of free-tier WeatherAPI keys
(`BUNDLED_PUBLIC_KEYS`) so the app works out of the box without any
configuration. They are low-privilege, quota-limited keys — no billing is
exposed. The app tries every configured key and falls back to Open-Meteo
(keyless) and cached suncalc if all keys are rejected, so losing a key
doesn't break the feature. Note the pool is shared by every install: heavy
use burns the shared quota and previously got keys revoked (HTTP 401 code
2006), so a private key via `.env` is recommended for reliable service.

Priority order for keys: `WEATHERAPI_PRIVATE_KEYS` (`.env`) → `WEATHERAPI_KEYS`
(`.env`) → single `WEATHERAPI_KEY` (`.env`) → bundled public pool → keyless
fallbacks. If you need higher quota or private access, set your own key(s)
in a local `.env` file (see `.env.example`) — private keys are never
committed (`.env` is git-ignored). Open-Meteo and the cached/default
sunrise-sunset calculation run without any key at all.

> ⚠️  The bundled pool lives inside the packaged `app.asar`. Anyone who
> inspects that archive can read these keys and share them — do not store
> paid/billing-enabled keys in the bundled pool. Rotate or replace any key
> you consider sensitive at weatherapi.com.

## Known-fixed issue: leaked WeatherAPI key (historical)

An earlier internal copy of this project stored several live keys under a
misspelled variable (`WHEATHER_API_KEYS` instead of `WEATHERAPI_KEY`) that
was never actually loaded into `process.env` (no `dotenv` call existed),
and `weather.js` had a single hardcoded default. Both problems are fixed in
this repo:

- Key loading is documented in the section above.
- The entry point (`index.js`) and `app/app.js` both call
  `require('dotenv').config()` so a local `.env` is actually loaded.
- `.env` is git-ignored; `.env.example` documents the variables.

**If you have a clone of this project (or its git history) that still
contains real keys in `.env` or in `weather.js`, treat those keys as
compromised and rotate them at weatherapi.com immediately** — anything ever
pushed to git, even briefly, should be assumed public.

## Scope / general posture

- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
  and `sandbox: true` (see `app/app.js`), and only exposes a small,
  explicit API via `app/preload.js`.
- `index.html` sets a restrictive Content-Security-Policy
  (`default-src 'self'`, no inline scripts, no remote script sources).
- The `open-external` IPC handler only allows `http(s)://` URLs to be handed
  to the OS shell, to avoid the renderer triggering `file://` or custom
  protocol handlers.
- Outbound network calls are limited to IP geolocation, WeatherAPI (only if
  configured), and the GitHub Releases API for update checks — see the
  README's "Privacy" section.
