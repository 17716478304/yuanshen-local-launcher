import { describe, it, expect, vi, afterEach } from "vitest";
import { describeLaunchFailure, waitForGameExit } from "./program-launch-game";

describe("launch failure diagnosis", () => {
  it("includes the confirmed driver failure and log path", () => {
    const failure = describeLaunchFailure(
      new Error("exit 5"),
      "WDFLDR.SYS required by HoYoKProtect.sys",
      "/data/logs/game.log"
    );
    expect(String(failure)).toContain("HoYoProtect 驱动初始化失败");
    expect(String(failure)).toContain("/data/logs/game.log");
  });
  it("preserves other errors", () => {
    const original = new Error("network failed");
    expect(describeLaunchFailure(original, "", "/log")).toBe(original);
  });
});

afterEach(() => { vi.useRealTimers(); });
it("accepts a confirmed native cleanup while UI polling was suspended", async () => {
  const failure = new Error("terminated by native watchdog");
  const stopped = vi.fn(async () => true);
  await waitForGameExit({ stop: vi.fn() }, async () => { throw failure; }, undefined, undefined, stopped);
  expect(stopped).toHaveBeenCalledOnce();
  await expect(waitForGameExit({ stop: vi.fn() }, async () => { throw failure; }, undefined, undefined,
    async () => false)).rejects.toBe(failure);
  await expect(waitForGameExit({ stop: vi.fn() }, async () => { throw failure; }, undefined, undefined,
    async () => { throw new Error("unreadable"); })).rejects.toBe(failure);
});
it("does not start an already cancelled launch", async () => {
  const controller = new AbortController(); controller.abort();
  const launch = vi.fn(); const stop = vi.fn();
  await waitForGameExit({ stop }, launch, controller.signal);
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
});
it("retries user stop until the late connecting launch exits", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let rejectLaunch!: (error: Error) => void;
  const launch = vi.fn(() => new Promise((_, reject) => { rejectLaunch = reject; }));
  const stop = vi.fn(async () => { if (stop.mock.calls.length === 2) rejectLaunch(new Error("terminated")); });
  const result = waitForGameExit({ stop }, launch, controller.signal);
  await vi.advanceTimersByTimeAsync(250);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(stop).toHaveBeenCalledTimes(2);
});
it("cleans a vanished game window after consecutive observations", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const stop = vi.fn(async () => finish());
  let open = true;
  const result = waitForGameExit({ stop }, () => new Promise<void>(resolve => { finish = resolve; }), undefined, async () => open);
  await vi.advanceTimersByTimeAsync(250);
  open = false;
  await vi.advanceTimersByTimeAsync(11000);
  expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await result;
  expect(stop).toHaveBeenCalledTimes(1);
});
it("keeps live, never-observed and unreadable windows running", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const stop = vi.fn();
  let open: boolean | undefined = false;
  const result = waitForGameExit({ stop }, () => new Promise<void>(resolve => { finish = resolve; }), undefined, async () => open);
  await vi.advanceTimersByTimeAsync(30000);
  open = true; await vi.advanceTimersByTimeAsync(5000);
  open = false; await vi.advanceTimersByTimeAsync(8000);
  open = undefined; await vi.advanceTimersByTimeAsync(15000);
  open = true; await vi.advanceTimersByTimeAsync(30000);
  expect(stop).not.toHaveBeenCalled();
  finish(); await vi.advanceTimersByTimeAsync(250); await result;
});
it("propagates genuine launch and stop errors", async () => {
  const original = new Error("launch failed");
  await expect(waitForGameExit({ stop: vi.fn() }, async () => { throw original; })).rejects.toBe(original);
  const controller = new AbortController();
  const stopError = new Error("cannot stop");
  const result = waitForGameExit({ stop: async () => { throw stopError; } }, async () => { controller.abort(); return new Promise(() => { /* Simulate a stalled child or probe. */ }); }, controller.signal);
  await expect(result).rejects.toBe(stopError);
});

it("allows user stop even if the window probe never resolves", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let finish!: () => void;
  const stop = vi.fn(async () => finish());
  const result = waitForGameExit({ stop }, () => new Promise<void>(resolve => { finish = resolve; }), controller.signal, () => new Promise(() => { /* Simulate a stalled child or probe. */ }));
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await vi.advanceTimersByTimeAsync(250);
  await result;
  expect(stop).toHaveBeenCalledTimes(1);
});
it("latches automatic cleanup across a late client window", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let open = true;
  const stop = vi.fn(async () => { open = true; if (stop.mock.calls.length === 3) finish(); });
  const result = waitForGameExit({ stop }, () => new Promise<void>(resolve => { finish = resolve; }), undefined, async () => open);
  await vi.advanceTimersByTimeAsync(250);
  open = false;
  await vi.advanceTimersByTimeAsync(16000);
  await result;
  expect(stop).toHaveBeenCalledTimes(3);
});
