import { render } from "solid-js/web";
import { createApp } from "./app";
import { fatal, log } from "./utils";

if (typeof Neutralino === "undefined") {
  console.log("此应用需要在 macOS 启动器中运行。");
} else {
  Neutralino.init();
  if (import.meta.env.PROD)
    document.addEventListener("contextmenu", event => event.preventDefault());
  createApp()
    .then(async UI => {
      render(UI, document.getElementById("root") as HTMLElement);
      await log("主界面已渲染");
      await Neutralino.window.show();
      await Neutralino.window.focus();
    })
    .catch(fatal);
}
