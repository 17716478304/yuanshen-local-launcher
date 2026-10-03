import s from "../assets/Nahida.cr.png";
import { createHK4EChannelClient } from "./mhy/hk4e";
import type { CreateClientOptions } from "./shared";
import { SERVER_DEFINITION } from "./hk4ecn-server";
export {
  DEFAULT_WINE_DISTRO_URL,
  DEFAULT_WINE_DISTRO_TAG,
  SERVER_DEFINITION,
} from "./hk4ecn-server";

export function createClient(options: CreateClientOptions) {
  return createHK4EChannelClient({
    server: SERVER_DEFINITION,
    releaseType: "cn",
    ...options,
  });
}

export const UPDATE_UI_IMAGE = s;
