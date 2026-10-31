# 通知上岛 · Notification Island

用 **AutoJs6 脚本 + 一个极小的中转 App**，在 Android 16 上把任意通知送进状态栏胶囊（Live Updates / 灵动岛）。

本项目是完整方案的源码分享：脚本负责「什么时候上岛」，App 负责「真的把通知提升为系统级 Live Update」。

<p align="center">
  <img src="docs/screenshots/02-notify.jpg" width="45%">
  <img src="docs/screenshots/04-foreground.jpg" width="45%">
</p>
<p align="center">
  <img src="docs/screenshots/01-config.jpg" width="45%">
  <img src="docs/screenshots/03-lockscreen.jpg" width="45%">
</p>

<p align="center">
  <sub>通知岛（胶囊 + 卡片）· 应用岛（卡片按钮）· 规则配置 · 锁屏展示</sub>
</p>

## 为什么需要中转 App

AutoJs6 生成的 `AndroidManifest.xml` 无法声明 `POST_PROMOTED_NOTIFICATIONS` 权限，因此脚本自身发出的通知**永远无法被系统提升**。这是硬性限制，无法绕过。

解法是让一个声明了该权限的极简 App 来持有通知，脚本只通过广播驱动它：

```
AutoJs6 脚本 (island_daemon)
        │
        │  UPDATE 广播
        v
中转 App (前台服务, 声明 POST_PROMOTED_NOTIFICATIONS)
        │
        │  setRequestPromotedOngoing(true)
        v
系统 Live Update（状态栏胶囊 / 锁屏 / 流体云）
        │
        │  按钮点击 → FROM_APP 广播
        v
AutoJs6 脚本
```

## 目录结构

```
.
├── app/                     # 中转 App（Kotlin，纯原生，无第三方 UI 库）
│   └── src/main/java/com/example/liveupdateverify/
│       ├── MainActivity.kt          # 配置页 / 诊断
│       ├── LiveUpdateService.kt     # 前台服务，持有通知
│       ├── NotificationFactory.kt   # 唯一的通知构建入口
│       ├── UpdateReceiver.kt        # 接收脚本广播
│       ├── BootReceiver.kt          # 开机自启
│       └── UiLog.kt                 # 界面日志
├── scripts/                 # AutoJs6 脚本
│   ├── island_kit.js        # 公共工具函数
│   ├── island_daemon.js     # 常驻守护：事件监听 / 双岛栈 / 倒计时
│   ├── island_watchdog.js   # 守护看护：心跳超时自动拉起 daemon
│   ├── island_config.js     # 自绘配置面板
│   ├── island_rules.json    # 规则模板（已清空为通用默认值）
│   ├── 上岛模块.js          # 发广播驱动 App
│   ├── UI模块.js            # 界面依赖
│   ├── UI扩展.js            # 界面依赖
│   └── 使用说明.md          # 脚本侧说明
└── docs/screenshots/        # 效果截图
```

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | **Android 16（API 36）**，低于此版本无 Live Updates 能力 |
| 脚本环境 | [AutoJs6](https://github.com/SuperMonster003/AutoJs6)（最新正式版） |
| 权限 | 通知使用权、无障碍服务、后台运行白名单、电池优化白名单 |
| 编译环境 | GitHub Actions，或本地 JDK 17 + Android SDK 36 |

## 编译

仓库不含安装包，请自行编译：

```bash
./gradlew assembleDebug
```

或使用 GitHub Actions（`.github/workflows/build.yml`），推送到 `main` 自动执行编译自检。

固定参数，请勿随意改动：

| 参数 | 值 | 说明 |
|---|---|---|
| compileSdk / targetSdk | 36 | Live Updates API 起点 |
| minSdk | 29 | |
| `androidx.core:core-ktx` | **1.17.0** | 1.19.x 要求 compileSdk 37，会导致构建失败 |
| 通知渠道 importance | `IMPORTANCE_LOW` | 严禁 `IMPORTANCE_MIN`，否则无法提升 |
| 通知 ID | 1001 | 待命态与显示态共用 |

## 广播接口

包名：`com.example.liveupdateverify`

| 方向 | Action |
|---|---|
| 脚本 → App（更新上岛） | `com.liveupdate.verify.UPDATE` |
| 脚本 → App（下岛） | `com.liveupdate.verify.STOP` |
| App → 脚本（按钮点击） | `com.liveupdate.verify.FROM_APP` |

`UPDATE` 支持的 extras：`title` / `text` / `short`（≤4 个中文字，超出截断）/ `action1~3Title` / `action1~3Key` / `action1~3Icon`。按钮最多 3 个，空的跳过。

完整字段表见 [使用说明.md](scripts/使用说明.md)。

### STOP 的语义：下岛 ≠ 停服务

早期版本收到 `STOP` 会 `stopSelf()`，App 随即从「前台服务」掉到 cached，被系统冻结后再也响应不了后续的 `UPDATE`（Android 12+ 禁止后台 `startForegroundService`），表现为「岛彻底不再出现，直到手动点开 App」。

现在 `STOP` 只做一件事：把通知换成**不申请 promoted 的静默待命通知**。岛消失，前台服务与后台优先级都保留。

待命态同样不申请 promoted —— 所以「打开 App」「进程被系统重启（`START_STICKY` + `intent == null`）」都不会在岛上冒出 App 原生通知。**只有真正带内容的 `UPDATE` 才会上岛。**

## 脚本部署

脚本内的 `BASE` / `DIR` 常量是**绝对路径**，需要与你的存储结构一致：

```
/storage/emulated/0/脚本/日常/灵动岛/
/storage/emulated/0/脚本/常用模块/
```

部署后需要授予 AutoJs6 存储访问权限，并开启无障碍服务与通知使用权。

首次运行请先清空 `island_rules.json` 中的规则，再按自己的使用习惯添加。

### 关于「任务型按钮」

按钮支持两种执行方式：

| 类型 | 行为 | 依赖 |
|---|---|---|
| `script` | 直接 `engines.execScriptFile(path)` 运行指定脚本 | 无 |
| `task` | 写入 `Daily tasks` 的 `RunQueue`，由 `main.js` 调度执行 | **需要 `main.js`** |

`main.js` 是作者个人的任务调度系统，**未包含在本仓库中**。当前代码已做保护：当 `main.js` 不存在时，任务型按钮会直接提示并返回，不会写入无效的队列数据。

如果你没有自己的调度脚本，请把按钮类型设为 `script`。

## 三种岛与两层栈

岛上只有 **两个槽位**：

```
上层：timerRule   ← 定时岛 和 通知岛 共用
下层：fgRule      ← 应用岛（跟随当前前台应用）
```

| 类型 | 触发条件 | 占哪一层 |
|---|---|---|
| 应用岛 | 前台应用命中规则 | 下层 |
| 定时岛 | 每天 / 每周 / 每 N 分钟 | 上层 |
| 通知岛 | 收到指定通知 | 上层 |

上层「谁后到谁占」：定时岛显示中来通知，通知盖上去；通知岛显示中到点，定时岛盖上去。触发时立即置顶，不会出现「响了但被下层挡住看不见」的情况。

上层压着下层时，岛上自动多一个「切回」按钮。该按钮**只在另一层真正可用时出现**，被屏蔽的那一层不会留下空按钮。

## 动作语义：下岛 与 临时屏蔽

这两个动作经常被混淆，行为完全不同：

| 动作 | 语义 | 何时重新出现 |
|---|---|---|
| **下岛** | 撤掉，本次不再回来 | 定时/通知：下次触发<br>应用：离开并重新进入该应用 |
| **临时屏蔽** | 撤掉，N 分钟后自动回来 | 计时结束，或来了新触发 |

**临时屏蔽只作用于你正在看的那一层**，两层各有独立计时：

- 屏蔽定时岛时，若下层有应用岛，应用岛会立刻浮现，定时岛照常计时
- 屏蔽期间切换应用，不会连带放行另一层
- 屏蔽期间计时**暂停**（结束时间顺延），恢复后继续走完剩余时长，不会一回来就过期

## 变量与代码按钮

岛内容支持 `{变量名}` 模板，完整列表见 `使用说明.md`。常用的两个：

| 变量 | 含义 |
|---|---|
| `{time}` | 当前时间 `HH:MM` |
| `{left}` | 上层定时岛的剩余分钟数，无定时岛时为 0 |

倒计时不再自动附加，用 `{left}` 自己写：

```
剩余{left}分钟     →  剩余 15 分钟
```

`code` 类型的按钮里**预置了两个函数**，不需要 require：

```js
mute(10)   // 临时屏蔽 10 分钟
hide()     // 下岛
```

## 稳定性：三层防护

脚本是常驻进程，长期运行会遇到两类问题：**判断失真**和**进程消失**。分别对应下面三层。

### 第一层：控件树兜底判断

`currentPackage()` 返回的是「最近一次窗口事件的前台缓存」，不是实时查询。系统降级时不一定会返回 launcher，可能顶替成任意普通应用（实测见过 `com.coloros.smartsidebar`、`com.xinshuru.inputmethod`），从而躲过静态的「桌面 / 输入法」名单，导致误撤岛。

守护因此接入控件树，但走的是**两级路径**：

| 路径 | 触发条件 | 成本 |
|---|---|---|
| 快速路径 | `auto.rootInActiveWindow` **根节点**的包名不是系统包 | 1 次 IPC |
| 兜底遍历 | 根节点属于 launcher / systemui / settings / 输入法 | 最多 600 节点，按包名节点数投票 |

绝大多数时候——也就是正常在某个应用里——走的是快速路径。只有「在桌面」「系统浮层」「输入法弹出」这几种根节点与子节点包名不一致的场景，才需要遍历整棵树。

扫描是自适应的：

| 当前状态 | 扫描间隔 |
|---|---|
| 岛在显示 | 5 秒 |
| 无岛 | 30 秒 |
| 息屏 | 不扫 |

有岛时扫得勤，因为此时判断错了会立刻造成错误撤岛；无岛时只是找「该不该上岛」，慢一点没关系。内部还有 800ms 节流，连续事件不会反复扫树。

### 第二层：心跳与定期重发

守护每 5 秒写一次 `daemon.hb` 时间戳，同一个定时器顺带完成四件事：

- 无障碍事件静默超过 90 秒 → 重新注册回调（AutoJs6 偶发丢回调）
- 心跳间隔异常增大（> 90 秒）→ 说明进程被系统冻结过，立即用控件树重新同步前台，不等事件、不等静默判定
- 单实例锁自查 → 锁被新实例接管则自己退出（见第三层）
- **每 60 秒无条件重发一次当前岛内容**

最后一条是兜底：Live Update 久不更新会被系统判定不活跃并降级，而应用岛在内容不变时永远不会自己重发。它同时兼任「App 侧状态丢失」的恢复通道——App 进程重启后通知会被重置成待命态，最迟 60 秒能被重新推上去。

### 第三层：watchdog

**进程被杀后，脚本不会自己回来。** 这是需要自己兜底的部分。

前台服务通知还在、脚本列表可能还显示运行中，但 `setInterval` 已经完全停摆——判断存活的可靠信号是 `daemon.hb` 的毫秒时间戳。

两层配置：

| 脚本 | AutoJs6 定时任务 | 作用 |
|---|---|---|
| `island_daemon.js` | **AutoJs6 启动时** | 进程重启后自动恢复守护 |
| `island_watchdog.js` | **每分钟一次** | 判断 daemon 是否需要重建 |

watchdog 每次只读一两个文件就退出，不常驻、不占资源。判据分三档：

| 条件 | 处理 |
|---|---|
| 息屏 | 直接退出。定时器本来就该停，心跳断档是预期行为 |
| 引擎还在（`engines.all()` 能看到 daemon） | 心跳停超 **30 分钟**才当卡死重建 |
| 引擎不在 | 心跳停超 **90 秒**就拉起 |

早期版本只看心跳、阈值 3 分钟，在会休眠的设备上几乎每次锁屏都会被误判成僵死，一天重建十几次。加入熄屏保护与引擎判据后降到每天 0~2 次。

日志写在 `watchdog.log`，带日期，保留最近 200 条。

daemon 侧配了单实例锁：启动时把自己的引擎 id 写进 `daemon.lock`，每个实例在心跳里自查，发现锁已易主就自己 `exit()`。

之所以不依赖 `forceStop()`，是因为它是**协作式中断**——daemon 全是 `setInterval` / `events` 回调、没有主循环，中断标志可能长时间没人检查，会出现「日志说已强制终止，实际两个实例都在跑」的情况。

## 日志

| 文件 | 内容 | 滚动 |
|---|---|---|
| `diag.log` | 关键决策：定时触发、补发、守护启动、调度停摆、锁接管 | 700 行封顶，超出裁到 500 |
| `watchdog.log` | watchdog 的拉起记录 | 200 行 |
| `probe_compact.log` | 探针输出（可选） | — |

`diag.log` 只记「发生了什么」，不记「为什么跳过」——后者每次 tick 都会产生，一天能刷几百条，会把真正的异常淹没。排查定时岛问题时，把 `island_daemon.js` 里的 `DIAG_VERBOSE` 改成 `true` 即可恢复完整细节。

## 已知限制

1. 胶囊短文字最多约 4 个中文字，超出会被截断。
2. **胶囊上不显示按钮**，按钮只在下拉通知卡片中，最多 3 个。第三方 ROM 上「按钮是否可见」还取决于系统对 Live Update 的展开策略。
3. 服务被系统杀死后，广播触发 `startForegroundService` 可能被 Android 12+ 拒绝（代码内已静默 try-catch）。
4. 开机自启只提高成功率，各厂商 ROM 仍可能拦截。
5. 部分 OEM（OPPO / 一加 ColorOS 等）会在权限之外追加自己的策略，代码层面无法完全控制。
6. 无 root / Shizuku 时，前台包名只能来自无障碍事件缓存，长时间静置后系统会降级它，靠控件树兜底纠偏。`FLAG_SECURE` 界面（银行、支付）与全屏视频可能取不到窗口内容，这期间判断会失效。

## 声明

- 本仓库**仅分享源码与技术实现，不提供 APK 安装包**。如需使用请自行编译。
- 本项目依赖 Android 16 的 Live Updates（promoted ongoing notification）能力，在低版本系统上无实际效果。
- 代码按「现状」提供，不保证在所有机型上生效。因使用本代码产生的任何后果由使用者自行承担。

## 致谢

- **[AutoJs6](https://github.com/SuperMonster003/AutoJs6)**（MPL-2.0）— 本项目的全部脚本运行在 AutoJs6 上。`currentPackage()`、`auto.rootInActiveWindow`、`events` 等无障碍 API 是整套前台感知方案的基础，`engines` 与「启动时运行 / 定时任务」则支撑了守护的存活与重启逻辑。
- **[Auto.js](https://github.com/hyb1996/Auto.js)** — AutoJs6 的上游项目，2017 年由 hyb1996 创建，2020 年停止维护后由 SuperMonster003 接手继续开发。
- **[Termux](https://termux.dev)** — 移动端完成编译、打包与推送的工具链。

本项目与上述项目没有隶属关系，仅作为使用者致谢。

## License

MIT
