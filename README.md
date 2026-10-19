# 上岛验证 App（Live Updates / 提升通知）

验证 Android 16（API 36）上，自带前台服务且声明 `POST_PROMOTED_NOTIFICATIONS` 的独立应用能否把常驻通知
提升为 Live Updates（ColorOS / 一加：状态栏胶囊 + 锁屏流体云）。

本版 **1.4**：新像素熊猫桌面图标、**通知图标统一为单色熊猫**、**按钮扩展到 3 个**。

---

## 0. 已验证、请勿改动的部分

- Kotlin，纯原生；`compileSdk=36`、`targetSdk=36`、`minSdk=29`
- `androidx.core:core-ktx:1.17.0`（**不要升 1.19.x**，它要求 compileSdk 37）
- 前台 Service，`foregroundServiceType="specialUse"`
- 通知渠道 `IMPORTANCE_LOW`（严禁 `IMPORTANCE_MIN`），**渠道 ID 未改**
- `setOngoing(true)`
- 提升双保险：`setRequestPromotedOngoing(true)` + `extras["android.requestPromotedOngoing"]=true`
- 禁止：RemoteViews、`setColorized(true)`、`setGroupSummary`
- 固定通知 ID `1001`
- applicationId / 包名：**`com.example.liveupdateverify`（未改）**
- 广播 action 名与 extras 字段名未改
- 后台生效逻辑未改（Receiver 内直接重建 + `startForeground` 更新）

---

## 1. 本版（1.4）改动点

### 1.1 桌面图标换成像素风熊猫
- `mipmap-mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi/ic_launcher.png`（48/72/96/144/192）
- 同密度 `ic_launcher_round.png`
- 自适应图标：`background = #FFFFFF`，`foreground = 熊猫图形`（`drawable-xxxhdpi/ic_launcher_fg.png`，整图居中，不再放大/裁切）
- 旧 mipmap 图标与旧自适应图层已**全部删除**
- Manifest 的 `android:icon` / `android:roundIcon` 指向 `@mipmap/ic_launcher` / `@mipmap/ic_launcher_round`

### 1.2 通知图标统一为单色熊猫
- 通知构建只有**一个**入口：`NotificationFactory.buildNotification(...)`
- 全工程只有这一处 `NotificationCompat.Builder(...)`
- `setSmallIcon(R.drawable.ic_stat_panda)` **写死**，待命态 / 刷新诊断 / UPDATE 广播 / 按钮点击后刷新全部一致
- **不设置 `largeIcon`**，所以不会再出现彩色 App 图标
- 广播里的 `smallIcon` 字段仍可传（兼容保留），但实际不改变图标

### 1.3 按钮扩展到 3 个
- 新增 extras：`action3Title` / `action3Key` / `action3Icon`
- 按 1 → 2 → 3 顺序添加，**最多 3 个**（Android 系统上限，超出忽略）
- 每个按钮独立 requestCode + `FLAG_IMMUTABLE or FLAG_UPDATE_CURRENT`

---

## 2. 编译与安装

```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

工程含完整 Gradle Wrapper（Gradle 8.14.3）、AGP 8.13.2、Kotlin 2.2.21。

---

## 3. 使用

1. 打开 App → 允许通知权限 → 自动进入待命态（`上岛服务待命 / 等待脚本指令 / 待命中`）。
2. 脚本发 `UPDATE` → 通知立即切换（App 在后台也生效）。
3. 点通知卡片上的按钮 → 脚本收到 `FROM_APP` 广播。
4. 点 **停止** 或脚本发 `STOP` → 移除通知（下岛）。
5. **刷新诊断** 查看 `canPostPromotedNotifications()` 等状态。

---

## 4. 脚本对接（AutoJs6）

### 4.1 基本信息

| 项 | 值 |
|---|---|
| packageName | `com.example.liveupdateverify` |
| 更新通知 | `com.liveupdate.verify.UPDATE` |
| 停止/下岛 | `com.liveupdate.verify.STOP` |
| App→脚本 | `com.liveupdate.verify.FROM_APP` |

### 4.2 `UPDATE` 的 extras

| key | 类型 | 含义 | 默认/兜底 |
|---|---|---|---|
| `title` | String | 通知标题 | 空则用「上岛服务待命」 |
| `text` | String | 通知正文 | 空串 |
| `short` | String | 胶囊短文字，**≤4 个中文字**，超出自动截断 | 空串 |
| `smallIcon` | String | 兼容字段（**实际统一用单色熊猫**，不改变图标） | — |
| `action1Title` | String | 第 1 个按钮文字 | 空则不显示 |
| `action1Key` | String | 第 1 个按钮标识 | — |
| `action1Icon` | String | 第 1 个按钮图标名 | `ic_action_done` |
| `action2Title` | String | 第 2 个按钮文字（可选） | 空则不显示 |
| `action2Key` | String | 第 2 个按钮标识（可选） | — |
| `action2Icon` | String | 第 2 个按钮图标名（可选） | `ic_action_done` |
| `action3Title` | String | 第 3 个按钮文字（可选） | 空则不显示 |
| `action3Key` | String | 第 3 个按钮标识（可选） | — |
| `action3Icon` | String | 第 3 个按钮图标名（可选） | `ic_action_done` |

> **按钮最多 3 个**（Android 通知卡片上限）；按 action1 → action2 → action3 顺序添加，空的跳过。

**图标名解析**
- 短名自动补前缀：`bear` → `ic_action_bear`
- 也支持完整名：`ic_action_bear`
- 解析失败或为空 → `ic_action_done`（不崩溃）

### 4.3 `FROM_APP` 的 extras（按钮点击）

| key | 类型 | 含义 |
|---|---|---|
| `event` | String | 固定 `action_clicked` |
| `key` | String | 被点击按钮的 `actionNKey` |
| `title` | String | 当前通知 title |
| `short` | String | 当前通知 short |

### 4.4 发广播（显式广播，3 按钮示例）

```js
var i = new Intent("com.liveupdate.verify.UPDATE");
i.setPackage("com.example.liveupdateverify");
i.putExtra("title", "下载中");
i.putExtra("text", "正在下载 42%");
i.putExtra("short", "下载中");
i.putExtra("action1Title", "暂停");
i.putExtra("action1Key", "pause");
i.putExtra("action1Icon", "bear");
i.putExtra("action2Title", "继续");
i.putExtra("action2Key", "resume");
i.putExtra("action2Icon", "rabbit");
i.putExtra("action3Title", "取消");
i.putExtra("action3Key", "cancel");
i.putExtra("action3Icon", "cat");
context.sendBroadcast(i);
```

### 4.5 收广播（App → 脚本）

```js
var receiver = new JavaAdapter(android.content.BroadcastReceiver, {
    onReceive: function (ctx, intent) {
        toast("按钮: " + intent.getStringExtra("key")
              + " / " + intent.getStringExtra("title"));
    }
});
var filter = new IntentFilter("com.liveupdate.verify.FROM_APP");
// 若 AutoJs6 自身 targetSdk >= 34，需显式指定 RECEIVER_EXPORTED(=2)：
// context.registerReceiver(receiver, filter, 2);
context.registerReceiver(receiver, filter);
```

### 4.6 三类图标各司其职

| 资源 | 用途 |
|---|---|
| `mipmap-*/ic_launcher.png` | 桌面 / 启动器图标（像素熊猫） |
| `ic_stat_panda.png` | **通知 smallIcon**（状态栏/胶囊左侧，单色熊猫） |
| `ic_action_dog / bear / rabbit / cat / done` | **通知卡片按钮图标** |

> 通知**不设置 largeIcon**，因此卡片右侧不会出现彩色 App 图标。

---

## 5. 诊断日志判读

| 字段 | 含义 |
|---|---|
| `canPostPromotedNotifications()` | **决定性**：false ⇒ 卡权限/系统开关 |
| `渠道级别 importance` | 必须 ≥ `LOW(2)` |
| `FLAG_ONGOING_EVENT` | 是否 ongoing |
| `hasPromotableCharacteristics()` | 通知结构是否合格 |
| `FLAG_PROMOTED_ONGOING` | 系统是否真的提升了它 |

前两项都 true 但仍不上岛 → 卡 **OEM(OPPO/一加) 系统策略**，非代码问题。

---

## 6. ColorOS / 一加 特有设置

1. 设置 → 通知 → 本 App → **实时更新**：打开
2. **允许后台运行 / 自启动**
3. **电池 → 省电 / 应用速冻 白名单**
4. 通知渠道「实时更新验证」不要降到最低

---

## 7. 限制说明（如实）

1. 胶囊短文字**最多约 4 个中文字**，超出截断。
2. **胶囊不支持按钮**——按钮只在下拉通知卡片上；卡片最多 3 个按钮。
3. 服务被杀后，广播触发 `startForegroundService` 可能被 Android 12+ 拒绝（已静默 try-catch）。
4. 开机自启只提高概率，ColorOS 可能拦截。
5. 上岛需前台服务 + 提升标记 + `IMPORTANCE_LOW`；OEM 可加额外条件。
6. 需授予 `POST_NOTIFICATIONS`。

---

## 8. 变更记录

**1.4**
- 新像素熊猫桌面图标（各密度 + 圆形 + 自适应：白底 + 熊猫前景），删除全部旧 mipmap 图标
- 通知构建收敛为唯一 `buildNotification()`，smallIcon 固定单色熊猫，去掉 largeIcon
- 新增 `action3Title/Key/Icon`，按钮最多 3 个
- 保持：按钮图标与回退逻辑、short ≤4 截断、action 名、extras 名、上岛设置、后台更新逻辑

**1.3**：广播在 `onReceive` 内自建+更新通知；`UiLog` 后台日志；`ic_stat_panda` + 动物按钮图标
**1.2**：待命/显示两态、动态按钮、STOP、开机自启、edge-to-edge
**1.1**：enableEdgeToEdge + insets、启动自动起服务

---

## 9. 与原始提示词的偏差（已核对 SDK）

1. `setShortCriticalText` 在 API 36 平台已存在，仅 `setRequestPromotedOngoing` 是 36.1；两者都走 `NotificationCompat`。
2. `Settings.ACTION_MANAGE_APP_PROMOTED_NOTIFICATIONS` 在 SDK 中不存在 → 字符串字面量 + 兜底。
3. `core-ktx` 必须 1.17.0（1.19.x 要求 compileSdk 37）。
4. 按钮素材 `ic_action_smile` 实际提供的是小狗，故命名为 `ic_action_dog`；解析器把 `smile` 当 `dog` 兼容。
