# Third-Party Notices

LuxLearn itself is proprietary software (see [LICENSE](LICENSE)) and depends
on the following third-party software, each of which remains under its own
license.

## Bundled in this repository

- **`haarcascade_frontalface_default.xml`** — a stump-based 24x24 frontal
  face Haar cascade created by Rainer Lienhart, distributed under the Intel
  License Agreement for Open Source Computer Vision Library (a permissive,
  BSD-style license). The full license text is included as a comment at the
  top of that file itself and must stay there if you redistribute it.

## npm dependencies

| Package | Purpose | License |
|---|---|---|
| [electron](https://www.npmjs.com/package/electron) | Desktop app runtime | MIT |
| [electron-packager](https://www.npmjs.com/package/electron-packager) | Build distributables | BSD-2-Clause |
| [sass](https://www.npmjs.com/package/sass) | Compiles `app/style.scss` | MIT |
| [dotenv](https://www.npmjs.com/package/dotenv) | Loads `.env` | BSD-2-Clause |
| [@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js) | Face detection (webcam worker) | Apache-2.0 |
| [sharp](https://www.npmjs.com/package/sharp) | Image resizing/decoding | Apache-2.0 |
| [active-win](https://www.npmjs.com/package/active-win) | Foreground window detection | MIT |
| [node-webcam](https://www.npmjs.com/package/node-webcam) | Webcam capture | MIT |
| [bmp-js](https://www.npmjs.com/package/bmp-js) | BMP decoding (Windows webcam captures) | MIT |
| [suncalc](https://www.npmjs.com/package/suncalc) | Sunrise/sunset calculation | BSD-2-Clause |

Run `npm ls` / check each package's own repository for the exact version and
license text in use, since versions (and occasionally licenses) can change
over time — this table reflects what's declared in `package.json` at the
time this file was written.

## External services called at runtime

- [ipapi.co](https://ipapi.co/) — IP-based geolocation fallback.
- [WeatherAPI.com](https://www.weatherapi.com/) — sunrise/sunset + cloud
  cover, only if you configure `WEATHERAPI_KEY`.
- [GitHub REST API](https://docs.github.com/en/rest) — used only to check
  the latest release tag for the in-app update notice.

None of these require you to bundle their license text, but you're
responsible for complying with their own terms of service if you deploy
this app at scale.
