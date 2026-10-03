import { join } from "path-browserify";
import { CommonUpdateProgram } from "../../../common-update-ui";
import { Server } from "../../../constants";
import {
  mkdirp,
  removeFile,
  writeFile,
  resolve,
  log,
  readFile,
  exec,
  utf16le,
  writeBinary,
  getKeyOrDefault,
} from "../../../utils";
import { Wine } from "../../../wine";
import { Config } from "@config";
import { putLocal, patchProgram, patchRevertProgram } from "../patch";
import { CN_BLOCK_URL, OS_BLOCK_URL } from "../../secret";
import hk4eHDRGlobalReg from "../../../constants/hk4e_hdr_os.reg?raw";
import hk4eHDRCnReg from "../../../constants/hk4e_hdr_cn.reg?raw";
import { gt } from "semver";

const HDR_REGISTRY_FILES = {
  hk4e_global: hk4eHDRGlobalReg,
  hk4e_cn: hk4eHDRCnReg,
} as const;

async function applyHDRRegistry({
  wine,
  server,
}: {
  wine: Wine;
  server: Server;
}) {
  const regContent =
    HDR_REGISTRY_FILES[server.id as keyof typeof HDR_REGISTRY_FILES];
  if (!regContent) return;

  const regPath = resolve("./hk4e_enable_hdr.reg");
  await writeFile(regPath, regContent);
  try {
    await wine.exec("regedit", [wine.toWinePath(regPath)], {}, "/dev/null");
  } finally {
    await removeFile(regPath);
  }
}

async function applyResolutionRegistry(
  wine: Wine,
  server: Server,
  config: Config
) {
  let key = "HKEY_CURRENT_USER\\Software\\\x6d\x69\x48\x6f\x59\x6f\\";
  if (server.id === "hk4e_cn") {
    key += "\u539f\u795e";
  } else if (server.id === "hk4e_global") {
    key += "\x47\x65\x6e\x73\x68\x69\x6e\x20\x49\x6d\x70\x61\x63\x74";
  } else {
    return;
  }

  const width = Number(config.resolutionWidth);
  const height = Number(config.resolutionHeight);
  if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
    return;
  }

  const lines = [
    `Windows Registry Editor Version 5.00`,
    ``,
    `[${key}]`,
    `"Screenmanager Is Fullscreen mode_h3981298716"=dword:00000000`,
    `"Screenmanager Resolution Width_h182942802"=dword:${width
      .toString(16)
      .padStart(8, "0")}`,
    `"Screenmanager Resolution Height_h2627697771"=dword:${height
      .toString(16)
      .padStart(8, "0")}`,
  ];

  const path = resolve("./hk4e_resolution.reg");
  await writeBinary(path, utf16le(lines.join("\r\n")));
  try {
    await wine.exec("regedit", [wine.toWinePath(path)], {}, "/dev/null");
  } finally {
    await removeFile(path);
  }
}

export async function* launchGameProgram({
  gameDir,
  gameExecutable,
  wine,
  config,
  server,
  signal,
  hasGameWindow,
  wasAutomaticallyStopped,
}: {
  gameDir: string;
  gameExecutable: string;
  wine: Wine;
  config: Config;
  server: Server;
  signal?: AbortSignal;
  hasGameWindow?: () => Promise<boolean | undefined>;
  wasAutomaticallyStopped?: () => Promise<boolean>;
}): CommonUpdateProgram {
  yield ["setUndeterminedProgress"];
  yield ["setStateText", "PATCHING"];

  await wine.setProps(config);
  if (config.hk4eEnableHDR) {
    await applyHDRRegistry({ wine, server });
  }

  if (config.resolutionCustom) {
    await applyResolutionRegistry(wine, server, config);
  }
  await wine.waitUntilServerOff();

  const cmd = `@echo off
cd "%~dp0"
copy "${wine.toWinePath(
    join(gameDir, atob("SG9Zb0tQcm90ZWN0LnN5cw=="))
  )}" "%WINDIR%\\system32\\"
cd /d "${wine.toWinePath(gameDir)}"
"${wine.toWinePath(
    join(gameDir, gameExecutable)
  )}" -platform_type CLOUD_THIRD_PARTY_PC -is_cloud 1`;
  await writeFile(resolve("config.bat"), cmd);
  try {
    yield* patchProgram(gameDir, wine, server, config);
    await mkdirp(resolve("./logs"));
    const yaaglDir = resolve("./");
    const logfile = resolve(`./logs/game_${Date.now()}.log`);
    try {
      yield ["setStateText", "GAME_RUNNING"];

      if (config.blockNet) {
        const tmpScriptPath = "/tmp/yaagl_network_block_script.sh";
        const blockUrl =
          server.id == "hk4e_global" ? OS_BLOCK_URL : CN_BLOCK_URL;

        const commands = [
          `#!/bin/sh`,

          `HOSTS_FILE="/etc/hosts"`,
          `ENTRY="0.0.0.0 ${blockUrl}"`,
          `PAD_START="# Temporarily Added by Yaagl"`,
          `PAD_END="# End of section"`,

          `if ! grep -qF "$ENTRY" "$HOSTS_FILE"; then`,
          `sudo bash -c "echo -e '$PAD_START\n$ENTRY\n$PAD_END' >> '/etc/hosts'"`,
          `fi`,
          `sleep 10`,
          `sudo sed -i.bak "/$PAD_START/,/$PAD_END/d" "$HOSTS_FILE"`,

          `rm ${tmpScriptPath}`,
        ];

        await writeFile(tmpScriptPath, commands.join("\n"));
        await exec(
          [
            "osascript",
            "-e",
            `do shell script "source ${tmpScriptPath} > /dev/null 2>&1 &" with administrator privileges`,
          ],
          {},
          false
        );
      }

      await waitForGameExit(wine, () => wine.exec2(
        config.steamPatch ? "C:\\windows\\system32\\steam.exe" : "cmd",
        config.steamPatch
          ? [wine.toWinePath(join(gameDir, gameExecutable))]
          : ["/c", wine.toWinePath(resolve("./config.bat"))],
        {
          MTL_HUD_ENABLED: config.metalHud ? "1" : "",
          WINEDLLOVERRIDES: "",
          WINE_ENABLE_TIMEOUT_FIX: config.timeoutFix ? "1" : "0",
          ...(wine.attributes.renderBackend == "dxmt"
            ? {
                WINEESYNC: "1",
                DXMT_LOG_PATH: yaaglDir,
                DXMT_CONFIG: "d3d11.preferredMaxFrameRate=60;",
                DXMT_CONFIG_FILE: join(yaaglDir, "dxmt.conf"),
                GST_PLUGIN_FEATURE_RANK: "atdec:MAX,avdec_h264:MAX",
              }
            : {
                WINEESYNC: "1",
              }),
          ...(config.proxyEnabled
            ? {
                HTTP_PROXY: config.proxyHost,
                HTTPS_PROXY: config.proxyHost,
              }
            : {}),
        },
        logfile
      ), signal, hasGameWindow, wasAutomaticallyStopped);
      await wine.stop();
      if (config.hk4eEnableHDR) {
        await revertHDRRegistry({ wine, server });
      }
    } catch (e: unknown) {
      await log(String(e));
      throw describeLaunchFailure(
        e,
        await readFile(logfile).catch(() => ""),
        logfile
      );
    }
  } finally {
    // Never restore DLLs while this prefix still has live processes.
    await wine.stop();
    // await removeFile(resolve("bWh5cHJvdDJfcnVubmluZy5yZWcK.reg"));
    await removeFile(resolve("config.bat"));
    yield ["setStateText", "REVERT_PATCHING"];
    yield* patchRevertProgram(gameDir, wine, server, config);
  }
}

// A closed window is actionable only after a real game window was observed.
// Unknown snapshots reset the grace period; hidden/minimized windows stay open.
export async function waitForGameExit(
  wine: Pick<Wine, "stop">,
  launch: () => Promise<unknown>,
  signal?: AbortSignal,
  hasGameWindow?: () => Promise<boolean | undefined>,
  wasAutomaticallyStopped?: () => Promise<boolean>
) {
  if (signal?.aborted) return;
  let finished = false;
  let seenWindow = false;
  let missingSamples = 0;
  let nextWindowCheck = 0;
  let automaticStop = false;
  const execution = Promise.resolve().then(launch).then(
    () => ({ ok: true as const }),
    error => ({ ok: false as const, error })
  ).then(result => { finished = true; return result; });
  while (!finished) {
    if (hasGameWindow && !automaticStop && !signal?.aborted && Date.now() >= nextWindowCheck) {
      let interrupt!: () => void;
      const interrupted = new Promise<undefined>(resolve => { interrupt = () => resolve(undefined); });
      const timer = setTimeout(interrupt, 4000);
      signal?.addEventListener("abort", interrupt, { once: true });
      let open: boolean | undefined;
      try {
        open = await Promise.race([
          hasGameWindow().catch(() => undefined),
          execution.then(() => undefined),
          interrupted,
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", interrupt);
      }
      nextWindowCheck = Date.now() + 2000;
      if (open === true) seenWindow = true;
      if (open !== false) missingSamples = 0;
      else if (seenWindow) missingSamples++;
      automaticStop ||= missingSamples >= 6;
    }
    if (signal?.aborted || automaticStop) await wine.stop();
    await Promise.race([execution, new Promise(resolve => setTimeout(resolve, 250))]);
  }
  const result = await execution;
  if (!result.ok && !signal?.aborted && !automaticStop &&
      !(await wasAutomaticallyStopped?.().catch(() => false))) throw result.error;
}

export function describeLaunchFailure(
  error: unknown,
  contents: string,
  logfile: string
) {
  if (contents.includes("WDFLDR.SYS") && contents.includes("HoYoKProtect.sys"))
    return new Error(
      `国服兼容运行失败：HoYoProtect 驱动初始化失败，缺少 WDFLDR.SYS。日志：${logfile}\n${String(
        error
      )}`
    );
  return error;
}

async function revertHDRRegistry({
  wine,
  server,
}: {
  wine: Wine;
  server: Server;
}) {
  let key = "HKEY_CURRENT_USER\\Software\\\x6d\x69\x48\x6f\x59\x6f\\";
  if (server.id === "hk4e_cn") {
    key += "\u539f\u795e";
  } else if (server.id === "hk4e_global") {
    key += "\x47\x65\x6e\x73\x68\x69\x6e\x20\x49\x6d\x70\x61\x63\x74";
  } else {
    return;
  }

  const reg = [
    `Windows Registry Editor Version 5.00`,
    ``,
    `[${key}]`,
    `"WINDOWS_HDR_ON_h3132281285"=-`,
  ];

  const path = resolve("./hk4e_revert_hdr.reg");
  await writeBinary(path, utf16le(reg.join("\r\n")));
  try {
    await wine.exec("regedit", [wine.toWinePath(path)], {}, "/dev/null");
  } catch (e) {
    // ignore
  } finally {
    await removeFile(path);
  }
}
