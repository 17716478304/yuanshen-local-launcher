// Exercise the actual launch/recovery program through Node filesystem/process adapters.
// This performs a real game launch, but reaching the login screen requires visual confirmation.
import fs from "node:fs/promises";
import { spawn, exec as execute, execFile } from "node:child_process";
import path from "node:path";
const root = process.env.DATA_ROOT;
if (!root || !process.env.LAUNCHER_ACCEPTANCE_LOCK)
  throw Error("Use launch-acceptance.py to hold the instance lock");
const service = process.env.LAUNCHER_ACCEPTANCE_SERVICE_URL;
async function serviceRequest(route: string, method = "GET") {
  const response = await fetch(service + route, { method, headers: {
    Authorization: "Bearer " + process.env.LAUNCHER_ACCEPTANCE_SERVICE_TOKEN,
  } });
  if (!response.ok) throw Error(`Acceptance service: ${response.status}`);
  return response.json();
}
const handlers = new Set<(event: unknown) => void>();
let nextId = 0;
const emit = (id: number, action: string, data: unknown) => {
  for (const handler of handlers) handler({ detail: { id, action, data } });
};
(globalThis as any).window = { NL_PATH: root, NL_CWD: "" };
(globalThis as any).Neutralino = {
  debug: { log: async (message: string) => console.log(message) },
  filesystem: {
    getStats: async (file: string) => {
      const stat = await fs.stat(file);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
      };
    },
    readFile: (file: string) => fs.readFile(file, "utf8"),
    writeFile: (file: string, value: string) => fs.writeFile(file, value),
    writeBinaryFile: (file: string, value: ArrayBuffer) =>
      fs.writeFile(file, new Uint8Array(value)),
    removeFile: (file: string) => fs.unlink(file),
  },
  storage: {
    getData: (key: string) =>
      fs.readFile(path.join(root, ".storage", key + ".neustorage"), "utf8"),
    setData: async (key: string, value: string | null) => {
      const file = path.join(root, ".storage", key + ".neustorage");
      if (value === null)
        await fs.unlink(file).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
      else await fs.writeFile(file, value);
    },
  },
  events: {
    on: async (_: string, handler: (event: unknown) => void) =>
      handlers.add(handler),
    off: async (_: string, handler: (event: unknown) => void) =>
      handlers.delete(handler),
  },
  os: {
    execCommand: (command: string) =>
      new Promise(resolve => {
        const child = execute(
          command,
          { cwd: root, shell: "/bin/bash", maxBuffer: 16 * 1024 * 1024 },
          (error, stdOut, stdErr) =>
            resolve({
              pid: child.pid,
              exitCode: error ? (error as any).code || 1 : 0,
              stdOut,
              stdErr,
            })
        );
      }),
    spawnProcess: async (command: string) => {
      const id = ++nextId;
      const child = spawn("/bin/bash", ["-c", command], { cwd: root });
      child.stdout.on("data", value => emit(id, "stdOut", value.toString()));
      child.stderr.on("data", value => emit(id, "stdErr", value.toString()));
      child.on("error", error => {
        emit(id, "stdErr", String(error));
        emit(id, "exit", 1);
      });
      child.on("close", code => emit(id, "exit", code ?? 1));
      return { id, pid: child.pid };
    },
  },
};
const { createWine } = await import("../src/wine/wine");
const { getWineDistributions } = await import("../src/wine/distro");
const { SERVER_DEFINITION } = await import("../src/clients/hk4ecn-server");
const { launchGameProgram } = await import(
  "../src/clients/mhy/hk4e/program-launch-game"
);
const { patchRevertProgram } = await import("../src/clients/mhy/patch");
const distro = (await getWineDistributions()).find(
  value => value.id === "11.0-1-crossover-signed-experimental"
)!;
const wine = await createWine({
  prefix: path.join(root, "wineprefix"),
  distro,
});
const launchStarted = Date.now() / 1000;
const config = {
  retina: false,
  leftCmd: false,
  fpsUnlock: "default",
  reshade: false,
  metalHud: false,
  proxyEnabled: false,
  proxyHost: "",
  wineDistro: distro.id,
  patchOff: false,
  workaround3: false,
  steamPatch: true,
  blockNet: false,
  hk4eEnableHDR: false,
  resolutionCustom: true,
  resolutionWidth: "1600",
  resolutionHeight: "900",
  timeoutFix: true,
} as const;
await wine.waitUntilServerOff();
for await (const command of patchRevertProgram(
  path.join(root, "game"),
  wine,
  SERVER_DEFINITION,
  config
))
  console.log(command);
if (process.env.LAUNCHER_ACCEPTANCE_RECOVER_ONLY === "1") {
  await wine.stop();
  console.log("Recovery completed; no game launched");
  process.exit(0);
}
let previousWindowState: boolean | undefined;
if (service) await serviceRequest("/api/launch/begin", "POST");
for await (const command of launchGameProgram({
  gameDir: path.join(root, "game"),
  gameExecutable: "YuanShen.exe",
  wine,
  config,
  server: SERVER_DEFINITION,
  wasAutomaticallyStopped: service ? async () => (await serviceRequest("/api/launch/window-state")).auto_cleanup === true : undefined,
  hasGameWindow: service ? undefined : () => new Promise<boolean | undefined>(resolve => {
    execFile(process.env.LAUNCHER_ACCEPTANCE_PYTHON!, ["-c",
      "import sys,json;from pathlib import Path;from game_process import window_state;print(json.dumps(window_state(Path(sys.argv[1]),float(sys.argv[2]))))",
      root, String(launchStarted)], { cwd: path.join(process.cwd(), "sophon_server"), timeout: 3500 }, (error, output) => {
        if (error) return resolve(undefined);
        try { const state = JSON.parse(output).has_window; if (state !== previousWindowState) { console.log("game window:", state); previousWindowState = state; } resolve(typeof state === "boolean" ? state : undefined); }
        catch { resolve(undefined); }
      });
  }),
}))
  console.log(command);
if (service) await serviceRequest("/api/launch/end", "POST");
console.log(
  "Launch program exited and restored files; visual login confirmation is still required"
);
