# 图标适配

日期：2026-10-02。

- 用户选择使用原神现有图标，不采用新的独立标志。
- 源图取自本机官方国服 7.1.0 `YuanShen.exe` 的最大 ICON 资源，使用上游随附 7zz 只读提取、sips 转为 PNG；原图保存于 `src/icons/GenshinOriginal.png`。
- 最终 `src/icons/LocalLauncher.png` 使用当前 Crossover Wine `WineIconUtils` 原生格式化例程，保持官方图案并添加圆角、约 10% 外侧留白。所有权声明见 THIRD-PARTY-NOTICES.md。
- 使用 imagegen 内置工具探索过门户图标及原神图标留白适配。适配提示为“保留原神六周年图案、人物、徽标和文字，仅添加 macOS 圆角与透明留白”。为保证与游戏图标一致，最终选用 Wine 原生格式化输出，未采用生成模型重绘版本。
- 构建脚本生成 16/32/64/128/256/512/1024 PNG 表示并编码 ICNS，覆盖标准与 Retina 尺寸。
- `scripts/icon-mask.m` 生成技术性透明圆角遮罩。游戏启动时 `CX_ROOT` 指向附带资源位置，当前固定 Crossover 版本从 `CX_ROOT/../../Resources/app-icon-roundrect-mask.png` 加载。
- `scripts/check-wine-icon.m` 使用当前运行时库的相同方法验证输出；仅在独立检查进程加载库，不向游戏注入或改写游戏二进制。

原生方法输出已经检查。实际 Dock 显示、1080p 窗口大小及降温效果需在用户结束当前资源下载并重新启动后确认。
