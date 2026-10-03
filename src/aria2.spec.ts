import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAria2 } from "./aria2";
const rpc = {
  getVersion: vi.fn(),
  shutdown: vi.fn(),
  tellStatus: vi.fn(),
  unpause: vi.fn(),
  removeDownloadResult: vi.fn(),
  addUri: vi.fn(),
};
vi.mock("libaria2-ts", () => ({
  WebSocket: {
    Client: class {
      constructor() {
        return rpc;
      }
    },
  },
}));
vi.mock("./utils", () => ({
  log: vi.fn(),
  sha256_16: async () => "fixed-gid",
  wait: async () => undefined,
  timeout: () => new Promise(() => undefined),
}));
const stats = vi.fn();
async function download() {
  const client = await createAria2({
    host: "127.0.0.1",
    port: 12345,
    secret: "session",
  });
  for await (const status of client.doStreamingDownload({
    uri: "https://official.example/runtime",
    absDst: "/tmp/runtime",
  })) {
    void status;
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Neutralino", { filesystem: { getStats: stats } });
  rpc.getVersion.mockResolvedValue({ version: "1.36.0" });
  rpc.addUri.mockResolvedValue("fixed-gid");
});
describe("runtime downloads retry in the same session", () => {
  it("re-adds failed downloads", async () => {
    rpc.tellStatus
      .mockResolvedValueOnce({ status: "error" })
      .mockResolvedValue({ status: "complete" });
    await download();
    expect(rpc.removeDownloadResult).toHaveBeenCalled();
    expect(rpc.addUri).toHaveBeenCalled();
  });
  it("re-downloads a deleted complete file", async () => {
    stats.mockRejectedValue(new Error("missing"));
    rpc.tellStatus.mockResolvedValue({ status: "complete" });
    await download();
    expect(rpc.addUri).toHaveBeenCalled();
  });
  it("keeps an existing complete file", async () => {
    stats.mockResolvedValue({ size: 123 });
    rpc.tellStatus.mockResolvedValue({ status: "complete" });
    await download();
    expect(rpc.addUri).not.toHaveBeenCalled();
  });
  it("propagates active download failures", async () => {
    rpc.tellStatus
      .mockResolvedValueOnce({ status: "active" })
      .mockResolvedValue({ status: "error", errorMessage: "TLS failure" });
    await expect(download()).rejects.toThrow("TLS failure");
  });
});
