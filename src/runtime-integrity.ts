import { exec } from "./utils";
const digests: Record<string, string> = {
  wine: "89fa7e90fb626523a90d5867a03c6be785d017176739c6320a3b86c7838c3a35",
  dxmt: "fbc0721fb72ebafd2bad0dbdd3d13a52056fd10c4a9a699cee2689363823255b",
};
export async function verifyRuntimeDownload(
  kind: "wine" | "dxmt",
  path: string
) {
  const actual = (
    await exec(["/usr/bin/shasum", "-a", "256", path])
  ).stdOut.split(/\s+/)[0];
  if (actual !== digests[kind]) {
    await Neutralino.filesystem.removeFile(path);
    throw new Error(`${kind} 下载校验失败，已清理错误缓存，请重试`);
  }
}
