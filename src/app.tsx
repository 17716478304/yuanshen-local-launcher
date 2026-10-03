import { createSignal, onMount, Show } from "solid-js";
import { createAria2Retry } from "./aria2";
import { createSophonRetry, SophonOnlineGameInfo } from "./sophon";
import { createLocale } from "./locale";

import { checkWine, createWine, installWineEnvironment } from "./wine";
import { SERVER_DEFINITION } from "./clients/hk4ecn-server";
import { Config } from "./config";
import { CommonUpdateProgram } from "./common-update-ui";
import { downloadAndInstallGameProgram } from "./clients/mhy/hk4e/program-install-game";
import { checkIntegrityProgram } from "./clients/mhy/hk4e/program-check-integrity";
import { launchGameProgram } from "./clients/mhy/hk4e/program-launch-game";
import { patchRevertProgram } from "./clients/mhy/patch";
import { checkAndDownloadDXMT } from "./downloadable-resource";
import {
  exec,
  spawn,
  resolve,
  setKey,
  openDir,
  env,
  mkdirp,
  addTerminationHook,
  GLOBAL_onClose,
  _safeRelaunch,
  humanFileSize,
  log,
  fileOrDirExists,
} from "./utils";
import { loadLauncherArtwork } from "./launcher-artwork";
import genshinIcon from "./icons/GenshinOriginal.png";
import "./local-launcher.css";

const launchConfig: Config = {
  retina: false,
  leftCmd: false,
  fpsUnlock: "default",
  reshade: false,
  metalHud: false,
  proxyEnabled: false,
  proxyHost: "",
  wineDistro: "11.0-1-crossover-signed-experimental",
  patchOff: false,
  workaround3: false,
  steamPatch: true,
  blockNet: false,
  hk4eEnableHDR: false,
  resolutionCustom: true,
  resolutionWidth: "1600",
  resolutionHeight: "900",
  timeoutFix: true,
};

interface StorageState {
  root: string;
  game_dir: string;
  version: string;
  installed: boolean;
  free_bytes: number;
  previous_root?: string;
  launch_verified?: boolean;
  restart_required?: boolean;
}

function sessionToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), x =>
    x.toString(16).padStart(2, "0")
  ).join("");
}

export async function createApp() {
  await setKey("config_uiLocale", "zh_cn");
  const locale = await createLocale();
  const wineStatus = await checkWine();
  const token = sessionToken();
  const ariaToken = sessionToken();
  const sophonPort = 40000 + Math.floor(Math.random() * 10000);
  const ariaPort = 50000 + Math.floor(Math.random() * 10000);
  const parentPid = String(
    (await exec(["/bin/echo", { _rawString_: "$PPID" }])).stdOut.trim()
  );
  const sophonProcess = await spawn(["./sidecar/sophon_server/sophon-server"], {
    SOPHON_TOKEN: token,
    SOPHON_PORT: String(sophonPort),
    SOPHON_ORIGIN: location.origin,
    DATA_ROOT: resolve("./"),
    TERMINATE_WITH_PID: parentPid,
  });
  const sophon = await createSophonRetry("127.0.0.1", sophonPort, token);
  const { proxy } = await sophon.request("/api/network/proxy");
  const ariaProcess = await spawn([
    "./sidecar/aria2/aria2c",
    "--no-conf",
    "--enable-rpc",
    `--rpc-listen-port=${ariaPort}`,
    "--rpc-listen-all=false",
    `--rpc-secret=${ariaToken}`,
    "--stop-with-process",
    parentPid,
    "--check-certificate=true",
    ...(proxy ? [`--all-proxy=${proxy}`] : []),
  ]);
  addTerminationHook(async () => {
    for (const process of [sophonProcess, ariaProcess]) {
      try {
        await Neutralino.os.updateSpawnedProcess(process.id, "exit");
      } catch {
        /* Already exited. */
      }
    }
    return true;
  });
  const aria = await createAria2Retry({
    host: "127.0.0.1",
    port: ariaPort,
    secret: ariaToken,
  });
  await log("本地下载服务已就绪");
  const wine = wineStatus.wineReady
    ? await createWine({
        prefix: resolve("./wineprefix"),
        distro: wineStatus.wineDistribution,
      })
    : undefined;
  const recoveryWine =
    wine ??
    ((await fileOrDirExists(resolve("./wine/bin/wine"))) ||
    (await fileOrDirExists(resolve("./wine/bin/wine64")))
      ? await createWine({
          prefix: resolve("./wineprefix"),
          distro: wineStatus.wineDistribution,
        })
      : undefined);
  let busy = false;
  let launchAttempted = false;
  let closing = false;
  await Neutralino.events.on("windowClose", async () => {
    if (closing) return;
    if (busy) {
      await Neutralino.os.showMessageBox(
        "任务正在进行",
        "请先等待任务完成或取消下载。游戏运行时可点击“结束游戏 / 清理残留”，等待文件恢复。",
        "OK"
      );
      return;
    }
    closing = true;
    if (await GLOBAL_onClose(false)) await Neutralino.app.exit(0);
  });

  return function Launcher() {
    const [artwork, setArtwork] = createSignal("");
    let artworkUpdating = false;
    async function refreshArtwork() {
      if (artworkUpdating) return;
      artworkUpdating = true;
      try {
        setArtwork(await loadLauncherArtwork(locale, SERVER_DEFINITION));
      } catch (error) {
        await log(`插画更新暂不可用，保留当前背景：${String(error)}`);
      } finally {
        artworkUpdating = false;
      }
    }
    const [state, setState] = createSignal<StorageState>();
    const [online, setOnline] = createSignal<SophonOnlineGameInfo>();
    const [working, setWorking] = createSignal(false);
    const [message, setMessage] = createSignal("正在读取国服资源清单…");
    const [failure, setFailure] = createSignal("");
    const [progress, setProgress] = createSignal(0);
    const [ready, setReady] = createSignal(false);
    const [canConfirm, setCanConfirm] = createSignal(false);
    const [gameControl, setGameControl] = createSignal<
      "running" | "recovery"
    >();
    const [stopping, setStopping] = createSignal(false);
    const [recoveryRequired, setRecoveryRequired] = createSignal(false);
    let gameAbort: AbortController | undefined;
    async function refresh() {
      setState(await sophon.request("/api/storage/state"));
    }
    async function consume(program: CommonUpdateProgram) {
      for await (const command of program) {
        if (command[0] === "setProgress") setProgress(command[1]);
        else if (command[0] === "setStateText") {
          setMessage(locale.format(command[1], command.slice(2)));
          if (command[1] === "GAME_RUNNING") setGameControl("running");
          if (command[1] === "REVERT_PATCHING") setGameControl(undefined);
        } else setProgress(0);
      }
    }
    async function run(action: () => Promise<void>) {
      if (busy) return;
      busy = true;
      setWorking(true);
      setFailure("");
      setProgress(0);
      try {
        await action();
        await refresh();
      } catch (error) {
        setFailure(String(error));
        await log(String(error));
      } finally {
        busy = false;
        setWorking(false);
        setGameControl(recoveryRequired() ? "recovery" : undefined);
        if (recoveryRequired()) setReady(false);
        setStopping(false);
        gameAbort = undefined;
      }
    }
    async function metadata() {
      void refreshArtwork();
      await run(async () => {
        await log("正在读取存储状态和国服清单");
        await refresh();
        if (recoveryWine) {
          setMessage("等待原有游戏进程退出并恢复运行文件…");
          await sophon.request("/api/launch/begin", "POST");
          try {
            setGameControl("recovery");
            await recoveryWine.waitUntilServerOff();
            setGameControl(undefined);
            await consume(
              patchRevertProgram(
                state()!.game_dir,
                recoveryWine,
                SERVER_DEFINITION,
                launchConfig
              )
            );
          } finally {
            await sophon.request("/api/launch/failed", "POST").catch(error => {
              setRecoveryRequired(true);
              throw error;
            });
          }
        }
        const info = await sophon.getLatestOnlineGameInfo("cn", "hk4e");
        if (!info.version || info.error)
          throw new Error(info.error || "资源清单无版本");
        setOnline(info);
        setReady(true);
        setMessage("准备就绪");
        await log("国服资源清单已就绪");
      });
    }
    onMount(metadata);
    async function primary() {
      await run(async () => {
        if (!wine) {
          await consume(
            installWineEnvironment({
              aria2: aria,
              wineAbsPrefix: resolve("./wineprefix"),
              wineDistro: wineStatus.wineDistribution,
              locale,
            })
          );
          await _safeRelaunch();
          return;
        }
        const current = state()!;
        const info = online()!;
        if (!current.installed) {
          await consume(
            downloadAndInstallGameProgram({
              sophonClient: sophon,
              gameDir: current.game_dir,
              installReltype: "cn",
            })
          );
          setMessage("安装完成，可以启动游戏");
        } else if (current.version !== info.version) {
          await consume(
            checkIntegrityProgram({ sophon, gameDir: current.game_dir })
          );
          setMessage("更新完成");
        } else {
          await sophon.request("/api/launch/begin", "POST");
          try {
            await consume(checkAndDownloadDXMT(aria));
            gameAbort = new AbortController();
            await consume(
              launchGameProgram({
                gameDir: current.game_dir,
                gameExecutable: "YuanShen.exe",
                wine,
                config: launchConfig,
                server: SERVER_DEFINITION,
                signal: gameAbort.signal,
                wasAutomaticallyStopped: async () => {
                  const timeout = new AbortController();
                  const timer = setTimeout(() => timeout.abort(), 20000);
                  try {
                    const snapshot = await sophon.request("/api/launch/window-state", "GET", undefined, timeout.signal);
                    return snapshot.auto_cleanup === true && !snapshot.cleanup_error;
                  } finally {
                    clearTimeout(timer);
                  }
                },
              })
            );
            await sophon.request("/api/launch/end", "POST");
            launchAttempted = !gameAbort.signal.aborted;
            setCanConfirm(launchAttempted);
            setMessage("游戏已退出");
          } catch (error) {
            await sophon
              .request("/api/launch/failed", "POST")
              .catch(cleanupError => {
                setRecoveryRequired(true);
                throw new Error(
                  `${String(error)}\n恢复未完成，请重试清理残留。${String(
                    cleanupError
                  )}`
                );
              });
            throw error;
          }
        }
      });
    }
    async function stopGame() {
      if (stopping() || !gameControl()) return;
      setStopping(true);
      setMessage("正在结束本启动器的游戏进程并恢复运行文件…");
      try {
        if (gameControl() === "running") gameAbort?.abort();
        else if (working()) await recoveryWine?.stop();
        else
          await run(async () => {
            if (!recoveryWine) throw new Error("缺少原 Wine，无法安全恢复文件");
            await recoveryWine.stop();
            await consume(
              patchRevertProgram(
                state()!.game_dir,
                recoveryWine,
                SERVER_DEFINITION,
                launchConfig
              )
            );
            await sophon.request("/api/launch/failed", "POST");
            setRecoveryRequired(false);
            setGameControl(undefined);
            setMessage("残留已清理，运行文件已恢复。请刷新资源清单。");
          });
      } catch (error) {
        setFailure(String(error));
        setStopping(false);
      }
    }
    async function storageJob(kind: "migrate" | "import") {
      const destination = await openDir(
        kind === "migrate" ? "选择 APFS 磁盘中的目标目录" : "选择国服原神目录"
      );
      if (!destination) return;
      await run(async () => {
        setMessage(
          kind === "migrate"
            ? "正在复制并校验数据，原副本保留…"
            : "正在导入并校验游戏…"
        );
        const task = await sophon.request(`/api/storage/${kind}`, "POST", {
          destination,
        });
        for await (const event of sophon.streamOperationProgress(
          task.task_id
        )) {
          if (event.overall_progress?.overall_percent)
            setProgress(event.overall_progress.overall_percent);
        }
        setMessage(
          kind === "migrate"
            ? "迁移完成，请重启；新目录验证前保留旧副本。"
            : "导入完成"
        );
      });
    }
    return (
      <main class="launcher">
        <nav class="sidebar" aria-label="启动器导航">
          <div class="sidebar-mark" aria-hidden="true">
            ✦
          </div>
          <a
            class="game-tab"
            href="#launcher-main"
            aria-label="原神主页"
            aria-current="page"
            title="原神主页"
          >
            <img src={genshinIcon} alt="原神" />
          </a>
          <button
            class="sidebar-button"
            title="打开数据目录"
            aria-label="打开数据目录"
            disabled={!state() || working() || recoveryRequired()}
            onClick={() => exec(["/usr/bin/open", state()!.root])}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 7V5h7l2 2h9v12H3Z" />
            </svg>
          </button>
          <button
            class="sidebar-button sidebar-bottom"
            title="查看日志"
            aria-label="查看日志"
            onClick={async () => {
              await mkdirp(resolve("./logs"));
              await exec(["/usr/bin/open", resolve("./logs")]);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 3h9l3 3v15H6Z M9 10h6 M9 14h6 M9 18h4" />
            </svg>
          </button>
        </nav>
        <div
          class="launcher-scene"
          id="launcher-main"
          style={{
            "--launcher-artwork": artwork() ? `url("${artwork()}")` : undefined,
          }}
        >
          <header>
            <div class="brand">
              <span class="brand-star" aria-hidden="true">
                ✧
              </span>{" "}
              本地启动器
            </div>
            <div class="badge">米哈游国服 · Windows PC</div>
          </header>
          <div class="hero" aria-hidden="true" />
          <div class="dashboard">
            <div class="panel-heading">
              <span>冒险准备</span>
              <span>国服 · PC</span>
            </div>
            <section class="details">
              <div>
                <label>游戏版本</label>
                <strong>{state()?.version || "尚未安装"}</strong>
                <small>最新：{online()?.version || "读取中"}</small>
              </div>
              <div>
                <label>清单安装容量</label>
                <strong>
                  {online() ? humanFileSize(online()!.install_size) : "—"}
                </strong>
                <small>
                  下载 {online() ? humanFileSize(online()!.download_size) : "—"}{" "}
                  · 临时{" "}
                  {online() ? humanFileSize(online()!.temporary_size) : "—"}
                </small>
              </div>
              <div>
                <label>磁盘可用空间</label>
                <strong>
                  {state() ? humanFileSize(state()!.free_bytes) : "—"}
                </strong>
                <small>
                  {wine
                    ? "Crossover Wine 11.0-1 已准备"
                    : "首次操作将准备 Wine"}
                </small>
              </div>
            </section>
            <details class="storage">
              <summary>游戏与存储位置</summary>
              <div class="storage-content">
                <div>
                  <label>数据位置</label>
                  <code>{state()?.root || resolve("./")}</code>
                  <small>游戏：{state()?.game_dir || "—"}</small>
                </div>
                <button
                  disabled={!state() || working() || recoveryRequired()}
                  onClick={() => exec(["/usr/bin/open", state()!.root])}
                >
                  打开目录
                </button>
              </div>
            </details>
            <section class="status" aria-live="polite">
              <strong>{message()}</strong>
              <Show when={working()}>
                <progress max="100" value={progress()} />
                <small>
                  {progress() > 0 ? `${progress().toFixed(1)}%` : "正在处理…"}
                </small>
              </Show>
              <Show when={failure()}>
                <pre role="alert">{failure()}</pre>
              </Show>
            </section>
            <footer>
              <div class="tools">
                <button
                  disabled={working() || recoveryRequired()}
                  onClick={metadata}
                >
                  刷新 / 重试
                </button>
                <button
                  disabled={
                    !ready() ||
                    working() ||
                    recoveryRequired() ||
                    state()?.restart_required
                  }
                  onClick={() => storageJob("import")}
                >
                  导入游戏
                </button>
                <button
                  disabled={
                    !state()?.installed ||
                    working() ||
                    recoveryRequired() ||
                    state()?.restart_required
                  }
                  onClick={() =>
                    run(async () => {
                      await consume(
                        checkIntegrityProgram({
                          sophon,
                          gameDir: state()!.game_dir,
                        })
                      );
                      setMessage("文件校验与修复完成");
                    })
                  }
                >
                  校验 / 修复
                </button>
                <button
                  disabled={
                    working() || recoveryRequired() || state()?.restart_required
                  }
                  onClick={() => storageJob("migrate")}
                >
                  迁移数据
                </button>
                <button
                  onClick={async () => {
                    await mkdirp(resolve("./logs"));
                    await exec(["/usr/bin/open", resolve("./logs")]);
                  }}
                >
                  查看日志
                </button>
              </div>
              <button
                class="primary"
                disabled={
                  !ready() ||
                  working() ||
                  recoveryRequired() ||
                  state()?.restart_required
                }
                onClick={primary}
              >
                <span class="play-icon" aria-hidden="true">
                  ▷
                </span>
                {!wine
                  ? "准备运行环境"
                  : !state()?.installed
                  ? "安装 / 恢复下载"
                  : state()?.version !== online()?.version
                  ? "更新游戏"
                  : "启动游戏"}
              </button>
            </footer>
            <Show when={gameControl()}>
              <button disabled={stopping()} onClick={stopGame}>
                {stopping() ? "正在结束并恢复…" : "结束游戏 / 清理残留"}
              </button>
              <small>
                会结束本启动器的原神进程。请先在游戏内退出，避免丢失未保存的设置。
              </small>
            </Show>
            <Show when={working() && !gameControl()}>
              <button
                onClick={() =>
                  sophon
                    .cancelActiveOperation()
                    .catch(error => setFailure(String(error)))
                }
              >
                取消当前下载或迁移
              </button>
            </Show>
            <Show when={state()?.restart_required}>
              <button
                class="primary"
                disabled={working() || recoveryRequired()}
                onClick={_safeRelaunch}
              >
                重启并使用新位置
              </button>
            </Show>
            <Show when={state()?.previous_root}>
              <section class="migration">
                <p>旧副本：{state()?.previous_root}</p>
                <button
                  disabled={working() || recoveryRequired()}
                  onClick={() =>
                    run(async () => {
                      await sophon.request("/api/storage/rollback", "POST");
                      await _safeRelaunch();
                    })
                  }
                >
                  回滚至旧位置
                </button>
                <button
                  disabled={working() || !canConfirm() || !launchAttempted}
                  onClick={() =>
                    run(async () => {
                      await sophon.request("/api/launch/confirm", "POST");
                      setMessage("新位置已确认，可以清理旧副本");
                    })
                  }
                >
                  确认本次到达登录界面
                </button>
                <button
                  disabled={working() || !state()?.launch_verified}
                  onClick={async () => {
                    const answer = await Neutralino.os.showMessageBox(
                      "清理旧副本",
                      "确认永久删除旧位置的游戏、Wine 和缓存？",
                      "YES_NO"
                    );
                    if (answer === "YES")
                      await run(async () => {
                        const task = await sophon.request(
                          "/api/storage/cleanup",
                          "POST"
                        );
                        for await (const event of sophon.streamOperationProgress(
                          task.task_id
                        )) {
                          void event;
                        }
                        setMessage("旧副本已清理");
                      });
                  }}
                >
                  清理旧副本
                </button>
              </section>
            </Show>
          </div>
          <p class="notice">
            非官方 macOS 兼容环境，仍需 Rosetta。账号仅在游戏内登录。基于 YAAGL
            0.3.20 ·{" "}
            <button
              onClick={() =>
                exec(["/usr/bin/open", resolve("./sidecar/licenses")])
              }
            >
              开源许可证
            </button>
          </p>
        </div>
      </main>
    );
  };
}
