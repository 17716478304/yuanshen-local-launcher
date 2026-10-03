import type { Locale } from "./locale";
import type { Server } from "./constants";
import { getLatestAdvInfo } from "./clients/mhy/hyp-connect";
import {
  exec,
  mkdirp,
  removeFileIfExists,
  resolve,
  waitImageReady,
} from "./utils";

// Download through the native client so the page keeps its local-only CSP.
export async function loadLauncherArtwork(locale: Locale, server: Server) {
  const { background } = await getLatestAdvInfo(locale, server);
  const url = new URL(background.url);
  const extension = url.pathname
    .match(/\.(webp|png|jpe?g)$/i)?.[1]
    .toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.hostname !== "launcher-webstatic.mihoyo.com" ||
    url.username ||
    url.password ||
    !extension
  )
    throw new Error("官方插画地址无效");
  await mkdirp("./cache");
  const temporary = resolve(
    `./cache/launcher-artwork-${crypto.randomUUID()}.download`
  );
  try {
    await exec([
      "/usr/bin/curl",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "20",
      "--max-filesize",
      "12582912",
      "--output",
      temporary,
      url.href,
    ]);
    const { stdOut } = await exec(["/usr/bin/base64", "-i", temporary]);
    const mime = extension === "jpg" ? "jpeg" : extension;
    const image = `data:image/${mime};base64,${stdOut.replace(/\s/g, "")}`;
    await waitImageReady(image);
    return image;
  } finally {
    await removeFileIfExists(temporary);
  }
}
