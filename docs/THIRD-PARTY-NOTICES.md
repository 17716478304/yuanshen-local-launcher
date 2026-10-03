# Third-party notices

This local customization is based on YAAGL 0.3.20, commit e293c71ebd41fba74b7c792405d1df0a72e0ec1b, by 3Shain and contributors, under the MIT License. The original LICENSE is retained in source and in the app.

Sophon installer: Copyright (C) 2025 Krock <mk939@ymail.com>, MIT; source notices are retained. Neutralinojs and neutralino.js are MIT licensed; the custom shell comes from 3Shain/neutralinojs v4.11.0-1.

Bundled sidecar licenses remain adjacent to their binaries: aria2 (GPLv2 or later), 7-Zip, xdelta and HDiffPatch. Source repositories: https://github.com/aria2/aria2, https://github.com/ip7z/7zip, https://github.com/jmacd/xdelta, https://github.com/sisong/HDiffPatch. The sidecar binaries are unchanged from the pinned YAAGL source; original license texts are bundled. Build/runtime dependency licenses are copied to the app by scripts/licenses.py.

## Proton extras

Copyright (c) 2015, 2019, 2020, 2021, 2022 Valve Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Downloaded runtime

Wine is LGPL licensed; DXMT is MIT licensed. They are downloaded separately from https://github.com/yaagl/anime-game-wine and retain bundled notices. Game resources are proprietary miHoYo files downloaded from the official CN Sophon service; they are not part of the source or app distribution. This app is not affiliated with or endorsed by miHoYo.

At the user's request, the launcher icon uses the Genshin Impact artwork extracted from the locally installed official CN YuanShen.exe 7.1.0 (6th-anniversary icon). This artwork, the Genshin name and miHoYo logo belong to their respective rights holders and are not covered by the launcher's MIT license. This remains an unofficial launcher. The PNG is formatted using the installed Crossover Wine's existing macOS icon routine; game executables are not modified for icon changes. Unused upstream graphics retain their upstream provenance.

## Launcher background

`src/assets/genshin-background.webp` is original Genshin Impact promotional artwork from the official CN HoYoPlay API, retrieved on 2026-10-02. Source: https://launcher-webstatic.mihoyo.com/launcher-public/2026/09/07/32b1fd7141c5edfa12618e0e707c7825_6632435512147717888.webp . Copyright belongs to miHoYo and the respective rights holders; this artwork is not covered by the launcher's MIT license. It is bundled locally as an offline fallback for this user's launcher customization. On startup and manual refresh, the launcher checks the official CN HoYoPlay API and downloads its current static artwork through the native client. No game account is required; failed artwork updates preserve the currently displayed image.
