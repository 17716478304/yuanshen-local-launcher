import { beforeEach, expect, it, vi, afterEach } from "vitest";
import { createWine } from "./wine";
import { DEFAULT_WINE_DISTRO_TAG } from "../clients/hk4ecn-server";

let maskExists = true;
const execute = vi.fn();
vi.mock("@utils", () => ({
  resolve: (path: string) => "/data/" + path.replace(/^\.\//, ""),
  stats: async () => { throw new Error("wine64 absent"); },
  fileOrDirExists: async () => maskExists,
  getKey: async () => "DESKTOP-TEST",
  exec2: (...args: unknown[]) => execute(...args),
}));
beforeEach(() => { maskExists = true; execute.mockReset(); });

async function wait(id = DEFAULT_WINE_DISTRO_TAG) {
  const wine = await createWine({
    prefix: "/data/wineprefix",
    distro: { id, displayName: "Wine", remoteUrl: "https://official.example", attributes: {} },
  });
  await wine.waitUntilServerOff();
}
it("passes bundled native Dock resources to the fixed Crossover runtime", async () => {
  await wait();
  expect(execute.mock.calls[0][1]).toMatchObject({
    WINEPREFIX: "/data/wineprefix",
    CX_ROOT: "/data/sidecar/mac-icons/SharedSupport/CrossOver",
  });
});
it("leaves older or incomplete runtimes unaffected", async () => {
  maskExists = false;
  await wait();
  expect(execute.mock.calls[0][1]).not.toHaveProperty("CX_ROOT");
  execute.mockReset(); maskExists = true;
  await wait("old-wine");
  expect(execute.mock.calls[0][1]).not.toHaveProperty("CX_ROOT");
});

it("stops only its own prefix before waiting for termination", async () => {
  const wine = await createWine({
    prefix: "/data/wineprefix",
    distro: { id: DEFAULT_WINE_DISTRO_TAG, displayName: "Wine", remoteUrl: "https://official.example", attributes: {} },
  });
  await wine.stop();
  expect(execute.mock.calls.map(call => call[0])).toEqual([
    ["/data/wine/bin/wineserver", "-k"],
    ["/data/wine/bin/wineserver", "-w"],
  ]);
  for (const call of execute.mock.calls) expect(call[1].WINEPREFIX).toBe("/data/wineprefix");
  expect(execute.mock.calls[0][4]).toEqual([0, 1]);
  expect(execute.mock.calls[1][4]).toBeUndefined();
});

afterEach(() => { vi.useRealTimers(); });
it("repeats scoped kill when a late client keeps wineserver wait open", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let kills = 0;
  execute.mockImplementation(async (args: string[]) => {
    if (args[1] === "-w") return new Promise<void>(resolve => { finish = resolve; });
    if (++kills === 2) finish();
  });
  const wine = await createWine({
    prefix: "/data/wineprefix",
    distro: { id: DEFAULT_WINE_DISTRO_TAG, displayName: "Wine", remoteUrl: "https://official.example", attributes: {} },
  });
  const stopped = wine.stop();
  await vi.advanceTimersByTimeAsync(500);
  await stopped;
  expect(kills).toBe(2);
  for (const call of execute.mock.calls) expect(call[1].WINEPREFIX).toBe("/data/wineprefix");
});

it("does not declare stopped if wineserver wait fails", async () => {
  const error = new Error("cannot verify termination");
  execute.mockImplementation(async (args: string[]) => { if (args[1] === "-w") throw error; });
  const wine = await createWine({
    prefix: "/data/wineprefix",
    distro: { id: DEFAULT_WINE_DISTRO_TAG, displayName: "Wine", remoteUrl: "https://official.example", attributes: {} },
  });
  await expect(wine.stop()).rejects.toBe(error);
});
