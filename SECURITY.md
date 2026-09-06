# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public GitHub
issue — use GitHub's "Report a vulnerability" button under this repo's
Security tab, or email the maintainer directly. Include reproduction steps
and, if relevant, which OS/Electron version you tested on.

## Known-fixed issue: leaked WeatherAPI key

An earlier internal copy of this project had a live-looking WeatherAPI.com
key hardcoded as a fallback default in `weather.js`, and a `.env` file with
several more keys under a misspelled/mismatched variable name
(`WHEATHER_API_KEYS` instead of `WEATHERAPI_KEY`) that was never actually
loaded into `process.env` (no `dotenv` call existed). Both problems are
fixed in this repo:

- `weather.js` no longer has any hardcoded key — it reads
  `process.env.WEATHERAPI_KEY` only, and falls back to cached/default
  sunrise-sunset data if it's unset.
- `app/app.js` (the entry point) now calls `require('dotenv').config()` so a local `.env` is
  actually loaded.
- `.env` is git-ignored; `.env.example` documents the one variable it needs.

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
