import { WebSocket as RPC } from "libaria2-ts";
import { log, sha256_16, wait, timeout } from "./utils";

export async function createAria2({
  host,
  port,
  secret,
}: {
  host: string;
  port: number;
  secret?: string;
}) {
  await wait(500); // FIXME:
  const rpc = new RPC.Client({
    host,
    port,
    auth: { secret },
  });
  const version = await Promise.race([rpc.getVersion(), timeout(3000)]);

  function shutdown() {
    return rpc.shutdown();
  }

  async function* doStreaming(gid: string) {
    while (true) {
      const status = await rpc.tellStatus(gid);
      if (status.status == "complete") {
        break;
      }
      if (status.status == "error" || status.status == "removed")
        throw new Error(`下载失败：${status.errorMessage || status.status}`);
      if (status.totalLength == BigInt(0)) {
        await wait(100);
        continue;
      }
      yield status;
      await wait(100);
    }
  }

  async function* doStreamingDownload(options: {
    uri: string;
    absDst: string;
  }) {
    const gid = await sha256_16(`${options.uri}:${options.absDst}`);
    let add = false;
    try {
      const status = await rpc.tellStatus(gid);
      if (status.status === "paused") await rpc.unpause(gid);
      else if (status.status === "complete") {
        try {
          await Neutralino.filesystem.getStats(options.absDst);
          return;
        } catch {
          await rpc.removeDownloadResult(gid);
          add = true;
        }
      } else if (status.status === "error" || status.status === "removed") {
        await rpc.removeDownloadResult(gid);
        add = true;
      } else if (status.status !== "active" && status.status !== "waiting") {
        throw new Error(`无法恢复下载状态：${status.status}`);
      }
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      )
        add = true;
      else throw error;
    }
    if (add)
      await rpc.addUri(options.uri, {
        gid,
        "max-connection-per-server": 16,
        out: options.absDst,
        continue: true,
        "allow-overwrite": true,
        "auto-file-renaming": false,
      });
    return yield* doStreaming(gid);
  }

  return {
    version,
    shutdown,
    doStreamingDownload,
  };
}

export type Aria2 = ReturnType<typeof createAria2> extends Promise<infer T>
  ? T
  : never;

export async function createAria2Retry({
  host,
  port,
  secret,
}: {
  host: string;
  port: number;
  secret?: string;
}): Promise<Aria2> {
  for (let i = 0; i < 30; i++) {
    try {
      return await createAria2({ host, port, secret });
    } catch (e) {
      await log("Fail to create aria2 rpc, retrying... " + e);
    }
  }
  throw new Error("Fail to create aria2 rpc");
}
