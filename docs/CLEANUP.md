# 残留清理记录

日期：2026-10-02。仅清理本次开发生成、可重新下载或构建的文件。

| 项目 | 删除前占用 |
| --- | --- |
| `.build-cache/original-wine-11` | 2.583 GiB |
| `.build-cache/wine-11.0.tar.xz` | 0.416 GiB |
| `.build-cache/wine-crossover-11.0-1.tar.xz` | 0.425 GiB |
| `.build-cache/dxmt.zip` | 0.030 GiB |
| `sophon_server/build/server.build` | 0.280 GiB |
| `.build-cache/migration-test-wide.sparseimage` | 0.014 GiB |
| `dist/GenshinLocalLauncher` | 0.015 GiB |
| `.build-cache/migration-test.dmg` | 0.250 GiB |

合计移除文件的实测分配空间：**4.01 GiB（4.31 GB）**。
磁盘可用量同时受当前游戏资源下载影响，不能用清理前后可用空间差值衡量此次清理。

保留当前游戏、Crossover Wine、Wine prefix、Sophon 下载缓存、源码、依赖、应用包和验收日志。
旧失败 Wine prefix 未登录且未发现 miHoYo 游戏注册记录；仅旧测试环境被清理。
不涉及系统数据、用户文档、账号数据或其他软件缓存。原先 APFS 测试映像已卸载并清理；检查结果保留。
后续重建会重新生成编译中间文件，固定运行环境可从官方发布资源重新下载。

## 退出清理修复后的追加清理

已检查目标目录没有被运行进程命令或打开文件使用，再删除旧 uv 临时构建环境、旧 cryptography 临时展开目录、`sophon_server/build/server.build` 和 `dist/GenshinLocalLauncher` 中间包。

本轮删除文件分配量 **663,724,032 字节（663.7 MB）**；磁盘可用量即时增加 **328,269,824 字节（328.3 MB）**。硬链接、APFS共享及同期写入使这两个数值不同，不能将删除分配量直接当作释放容量。
原始记录：`.build-cache/cleanup-exit-record.json`。

## 后台退出修复后的构建缓存清理

2026-10-02 新版编译、打包和真实暂停前端验收完成后，移除重新生成的 `sophon_server/build/server.build` 与 `dist/GenshinLocalLauncher` 中间输出。确认没有进程使用这些目标；源码、最终应用、运行环境及验收日志保留。

本轮删除分配量322,445,312字节，可用空间即时增加322,760,704字节（约323 MB）。这是本次重建生成的缓存，不与此前释放量重复合计。原始记录：`.build-cache/native-exit-cleanup.json`。

全局 `uv cache prune` 检测缓存正在使用，已取消；未使用force，也未删除正在使用的软件缓存。当前游戏、Wine、prefix、约211MiB游戏下载缓存、源码和验收日志保留。
最后复查重新构建产生的同类编译中间文件会在签名验证后再次移除，不重复累计为新增释放量。

## 用户授权的重建缓存清理

2026-10-02，确认没有 uv、Rust 或 Nuitka 构建进程，且 lsof 未发现目标目录被打开后，删除 `~/Library/Caches/puccinialin`、`~/.cache/uv` 和 `sophon_server/build/server.build`。删除前目录分配量约 8.29 GB；磁盘可用空间即时增加 **5,584,011,264 字节（5.58 GB）**，不将硬链接和 APFS 共享块重复计为释放容量。记录见 `.build-cache/rebuild-cache-cleanup.json`。

保留游戏及语音、Wine、prefix、DXMT、游戏 .tmp 下载缓存、Python 运行时、源码、依赖和最终应用包。只读检查基础 StreamingAssets/AudioAssets 的 PCK 语言表发现 chinese 条目；这证明中文资源存在，但不证明所有中文语音已完整安装，仍需游戏内切换中文确认。
