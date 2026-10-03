// Rebuild the CN frontend and the modified Sophon sidecar; no upstream app binary substitution.
const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const { IconIcns } = require('@shockpkg/icon-encoder');
(async () => {
  if (process.env.YAAGL_CHANNEL_CLIENT !== 'hk4ecn') throw new Error('CN build only');
  await execa('pnpm', ['exec', 'tsc'], { stdio: 'inherit' });
  await fs.ensureDir('.build-cache');
  await fs.ensureDir('sidecar/mac-icons/Resources');
  await execa('/usr/bin/clang', ['-arch', 'arm64', '-framework', 'AppKit',
    'scripts/icon-mask.m', '-o', '.build-cache/icon-mask'], { stdio: 'inherit' });
  await execa('.build-cache/icon-mask', ['sidecar/mac-icons/Resources/app-icon-roundrect-mask.png']);
  await execa('pnpm', ['exec', 'vite', 'build'], { stdio: 'inherit' });
  await fs.copy('neutralino.js', 'dist/neutralino.js');
  await fs.copy('src/icons/LocalLauncher.png', 'dist/LocalLauncher.png');
  await fs.ensureDir('dist/src/icons');
  await fs.copy('src/icons/LocalLauncher.png', 'dist/src/icons/LocalLauncher.png');
  await execa('pnpm', ['exec', 'neu', 'build'], { stdio: 'inherit' });
  const app = path.resolve('dist/原神本地启动器.app');
  await fs.remove(app);
  await fs.ensureDir(path.join(app, 'Contents/MacOS'));
  await fs.ensureDir(path.join(app, 'Contents/Resources/sidecar'));
  const resources = path.join(app, 'Contents/Resources');
  await fs.copy('bin/neutralino-mac_x64', path.join(app, 'Contents/MacOS/GenshinLocalLauncher'));
  await fs.copy('dist/GenshinLocalLauncher/resources.neu', path.join(resources, 'resources.neu'));
  await fs.copy('neutralino.config.json', path.join(resources, 'neutralino.config.json'));
  await fs.copy('sidecar', path.join(resources, 'sidecar'), { preserveTimestamps: true });
  await fs.copy('sophon_server/build/server.dist', path.join(resources, 'sidecar/sophon_server'));
  await fs.copy('LICENSE', path.join(resources, 'sidecar/licenses/YAAGL-MIT.txt'));
  await fs.copy('docs/THIRD-PARTY-NOTICES.md', path.join(resources, 'sidecar/licenses/THIRD-PARTY-NOTICES.md'));
  const icon = new IconIcns();
  for (const [pixels, types] of [
    [16, ['icp4']], [32, ['icp5', 'ic11']], [64, ['icp6', 'ic12']],
    [128, ['ic07']], [256, ['ic08', 'ic13']], [512, ['ic09', 'ic14']], [1024, ['ic10']],
  ]) {
    const resized = path.resolve('.build-cache', `launcher-icon-${pixels}.png`);
    await execa('/usr/bin/sips', ['-z', String(pixels), String(pixels),
      'src/icons/LocalLauncher.png', '--out', resized]);
    icon.addFromPng(await fs.readFile(resized), types, true);
  }
  await fs.writeFile(path.join(resources, 'icon.icns'), icon.encode());
  await fs.writeFile(path.join(app, 'Contents/MacOS/parameterized'), `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
exec "$APP_DIR/Contents/Resources/sidecar/sophon_server/sophon-server" --bootstrap "$APP_DIR"
`);
  for (const name of ['parameterized', 'GenshinLocalLauncher']) await fs.chmod(path.join(app, 'Contents/MacOS', name), 0o755);
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>parameterized</string>
<key>CFBundleIdentifier</key><string>local.genshin.launcher</string>
<key>CFBundleName</key><string>原神本地启动器</string>
<key>CFBundleDisplayName</key><string>原神本地启动器</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMinimumSystemVersion</key><string>15.0</string>
</dict></plist>`);
  await execa('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(app);
})().catch(error => { console.error(error); process.exitCode = 1; });
