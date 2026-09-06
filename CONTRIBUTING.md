# Contributing

Thanks for considering a contribution to LuxLearn!

## Setup

```bash
git clone https://github.com/shahk70/luxlearn.git
cd luxlearn
npm install
cp .env.example .env
npm run dev
```

## Before opening a PR

- Keep platform-specific code isolated behind the existing `PLATFORM`
  switches (`core.js`) rather than sprinkling `process.platform`
  checks around.
- If you touch `app/style.scss`, run `npm run build:css` (or
  `npm run watch:css` while iterating) so `app/style.css` stays in sync —
  it's git-ignored and regenerated, so don't hand-edit `style.css` directly.
- Don't commit real API keys, tokens, or personal file paths. `.env` is
  git-ignored; use `.env.example` to document new variables.
- Keep new dependencies minimal — this is a small desktop app with several
  native/platform-specific dependencies already (`sharp`, `@techstark/opencv-js`,
  `node-webcam`, `active-win`).
- Describe what you tested and on which OS in the PR description, since a
  lot of this app's logic (brightness control, ambient light, webcam
  capture) is genuinely platform-dependent and hard to fully cover in CI.

## Reporting bugs

Please include: OS + version, Node/Electron version (`npm ls electron`),
whether you have an ambient light sensor, and the relevant lines from the
in-app "Status" log if applicable.

## Reporting security issues

Please see [SECURITY.md](SECURITY.md) instead of opening a public issue.
