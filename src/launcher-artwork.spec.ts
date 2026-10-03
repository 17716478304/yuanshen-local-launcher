import { beforeEach, expect, it, vi } from "vitest";
import { loadLauncherArtwork } from "./launcher-artwork";
import { getLatestAdvInfo } from "./clients/mhy/hyp-connect";
import { exec, removeFileIfExists, waitImageReady } from "./utils";
import type { Locale } from "./locale";
import type { Server } from "./constants";

vi.mock("./clients/mhy/hyp-connect", () => ({ getLatestAdvInfo: vi.fn() }));
vi.mock("./utils", () => ({
  exec: vi.fn(),
  mkdirp: vi.fn(),
  removeFileIfExists: vi.fn(),
  resolve: (path: string) => path,
  waitImageReady: vi.fn(),
}));
const locale = {} as Locale;
const server = {} as Server;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLatestAdvInfo).mockResolvedValue({
    background: {
      url: "https://launcher-webstatic.mihoyo.com/launcher-public/current.webp",
    },
  } as Awaited<ReturnType<typeof getLatestAdvInfo>>);
  vi.mocked(exec).mockResolvedValue({ stdOut: "aGVs\nbG8=\n" } as Awaited<
    ReturnType<typeof exec>
  >);
  vi.mocked(waitImageReady).mockResolvedValue(undefined);
});
it("loads and validates the official image before returning it, then removes the download", async () => {
  expect(await loadLauncherArtwork(locale, server)).toBe(
    "data:image/webp;base64,aGVsbG8="
  );
  expect(waitImageReady).toHaveBeenCalledWith(
    "data:image/webp;base64,aGVsbG8="
  );
  expect(vi.mocked(exec).mock.calls[0][0]).toContain("--max-time");
  expect(removeFileIfExists).toHaveBeenCalledOnce();
});
it("rejects a nonofficial image URL without downloading", async () => {
  vi.mocked(getLatestAdvInfo).mockResolvedValue({
    background: { url: "https://example.com/a.webp" },
  } as Awaited<ReturnType<typeof getLatestAdvInfo>>);
  await expect(loadLauncherArtwork(locale, server)).rejects.toThrow(
    "官方插画地址无效"
  );
  expect(exec).not.toHaveBeenCalled();
});
it("keeps update failures recoverable and cleans partial downloads", async () => {
  vi.mocked(exec).mockRejectedValueOnce(new Error("offline"));
  await expect(loadLauncherArtwork(locale, server)).rejects.toThrow("offline");
  expect(waitImageReady).not.toHaveBeenCalled();
  expect(removeFileIfExists).toHaveBeenCalledOnce();
});
it("never returns a corrupt image", async () => {
  vi.mocked(waitImageReady).mockRejectedValueOnce(new Error("invalid image"));
  await expect(loadLauncherArtwork(locale, server)).rejects.toThrow(
    "invalid image"
  );
  expect(removeFileIfExists).toHaveBeenCalledOnce();
});
