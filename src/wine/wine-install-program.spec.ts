import { beforeEach, expect, it, vi } from "vitest";
import { installWineEnvironment } from "./wine-install-program";

const calls: string[] = [];
let patched = "NOTFOUND";
vi.mock("@utils", () => ({
  resolve: (path: string) => path,
  getKeyOrDefault: async () => patched,
  fileOrDirExists: async () => true,
  rmrf_dangerously: async () => calls.push("delete"),
}));
vi.mock("./wine", () => ({
  createWine: async () => ({
    waitUntilServerOff: async () => calls.push("wait"),
  }),
}));
vi.mock("../runtime-integrity", () => ({
  verifyRuntimeDownload: async () => { throw new Error("bad checksum"); },
}));
vi.mock("./cert", () => ({}));
vi.mock("./mf", () => ({}));
vi.mock("@common-update-ui", () => ({}));

const options = {
  wineAbsPrefix: "/data/wineprefix",
  wineDistro: { remoteUrl: "https://official.example/wine.xz" },
  aria2: { async *doStreamingDownload() { /* A cached completed download. */ } },
} as unknown as Parameters<typeof installWineEnvironment>[0];

beforeEach(() => { calls.length = 0; patched = "NOTFOUND"; });
it("rejects unrecovered patches before replacing runtime", async () => {
  patched = "1";
  await expect(installWineEnvironment(options).next()).rejects.toThrow("恢复游戏文件");
  expect(calls).toEqual([]);
});
it("waits for old Wine and preserves it on failed download verification", async () => {
  const program = installWineEnvironment(options);
  await program.next();
  await expect(program.next()).rejects.toThrow("bad checksum");
  expect(calls).toEqual(["wait"]);
});
