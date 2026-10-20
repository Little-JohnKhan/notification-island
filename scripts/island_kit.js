/**
 * island_kit.js —— 灵动岛业务层（配置 / 状态 / 执行）
 * ------------------------------------------------------------------
 * UI 全部来自 ./UI扩展.js（已合并 UI模块.js 的能力），这里只做业务。
 * 依赖：/storage/emulated/0/脚本/常用模块/UI扩展.js
 * ------------------------------------------------------------------
 */
module.exports = (function () {

    const BASE = "/storage/emulated/0/脚本/常用模块/";
    const U = require(BASE + "UI扩展.js");
    const UI = require(BASE + "UI模块.js");
    try { UI.setContext(context); } catch (e) {}

    const DIR = "/storage/emulated/0/脚本/日常/灵动岛";
    const SCRIPT_ROOT = "/storage/emulated/0/脚本";
    const PATHS = {
        dir:  DIR,
        cfg:  DIR + "/island_rules.json",
        hb:   DIR + "/daemon.hb",
        main: "/storage/emulated/0/脚本/日常/main.js",   // ← 指向你的 main.js
    };
    const DAILY_STORE = "Daily tasks";
    const STATE_STORE = "island_state";
    const SWITCH_KEY  = "islandswitch";   // 岛上「切换」键的保留 key

    function ctx() { try { return context; } catch (e) { return null; } }

    /* ================= 目录 ================= */

    function ensureDir() {
        const d = new java.io.File(DIR);
        if (!d.exists()) d.mkdirs();
    }

    /** 扫描 脚本/ 及其 日常/ 下各子目录，返回最近修改过的 island_daemon.js */
    function findDaemonPath() {
        const roots = [DIR, SCRIPT_ROOT, SCRIPT_ROOT + "/日常"];
        let best = null, bestMt = -1;

        roots.forEach(function (root) {
            try {
                files.listDir(root).forEach(function (n) {
                    try {
                        const p = root + "/" + n;
                        if (!files.isDir(p)) return;
                        const f = new java.io.File(p + "/island_daemon.js");
                        if (f.exists()) {
                            const mt = f.lastModified();
                            if (mt > bestMt) { bestMt = mt; best = p + "/island_daemon.js"; }
                        }
                    } catch (e) {}
                });
            } catch (e) {}
        });

        if (!best) {
            const p = DIR + "/island_daemon.js";
            if (new java.io.File(p).exists()) best = p;
        }
        return best;
    }

    /* ================= 配置 ================= */

    function defaultCfg() {
        return {
            version: 3,
            events: ["WINDOW_STATE_CHANGED"],
            ignore: [
                "com.android.systemui",
                "com.miui.home", "com.huawei.android.launcher",
                "com.android.launcher", "com.oppo.launcher", "com.vivo.launcher",
                "com.google.android.inputmethod.latin",
            ],
            safety: { debounceMs: 250, heartbeatMs: 5000, onlyWhenScreenOn: true, hideWhenScreenOff: true, noRuleDelayMs: 350, desktopDelayMs: 800 },
            lifecycle: { onNoRule: "default", manualMuteMin: 10, hideOnDaemonExit: true, keepMaxMin: 5 },
            island: { default: { title: "就绪", content: "未匹配到规则", short: "空闲" } },
            rules: [],
            schedules: [],
            notifies: [],
        };
    }

    function readCfg() {
        try {
            const c = JSON.parse(files.read(PATHS.cfg));
            c.rules     = c.rules || [];
            c.schedules = c.schedules || [];
            c.notifies  = c.notifies || [];
            c.ignore    = c.ignore || [];
            c.safety    = c.safety || {};
            c.lifecycle = c.lifecycle || {};
            c.island    = c.island || {};
            c.events    = (c.events && c.events.length) ? c.events : ["WINDOW_STATE_CHANGED"];
            if (!c.island.default) c.island.default = { title: "就绪", content: "", short: "空闲" };
            if (!c.lifecycle.onNoRule) c.lifecycle.onNoRule = "default";
            if (c.lifecycle.manualMuteMin == null) c.lifecycle.manualMuteMin = 10;
            if (c.lifecycle.hideOnDaemonExit == null) c.lifecycle.hideOnDaemonExit = true;
            if (c.safety.debounceMs == null) c.safety.debounceMs = 250;
            if (c.safety.heartbeatMs == null) c.safety.heartbeatMs = 5000;
            if (c.safety.noRuleDelayMs == null) c.safety.noRuleDelayMs = 350;
            if (c.safety.desktopDelayMs == null) c.safety.desktopDelayMs = 800;
            if (c.safety.hideWhenScreenOff == null) c.safety.hideWhenScreenOff = true;
            if (c.lifecycle.keepMaxMin == null) c.lifecycle.keepMaxMin = 5;
            return c;
        } catch (e) {
            // 读不到只返回默认值，绝不在这里建目录/写盘，
            // 否则旧进程发现文件被删会反复重建
            return defaultCfg();
        }
    }

    function writeCfg(cfg) {
        ensureDir();
        files.write(PATHS.cfg, JSON.stringify(cfg, null, 2));
    }

    /* ================= 状态 / 命令 ================= */

    function stateStore() { return storages.create(STATE_STORE); }

    function readState() {
        try { return stateStore().get("state", {}) || {}; } catch (e) { return {}; }
    }

    function writeState(s) {
        try { stateStore().put("state", s || {}); } catch (e) {}
    }

    /** 配置页 / 外部脚本 → 守护：{ action, 其余字段 } */
    function sendCmd(action, extra) {
        try {
            var c = { action: String(action), at: Date.now() };
            if (extra) {
                for (var k in extra) {
                    if (k !== "action" && k !== "at") c[k] = extra[k];
                }
            }
            stateStore().put("cmd", c);
        } catch (e) {}
    }

    function daemonAlive(maxAgeMs) {
        try {
            const f = new java.io.File(PATHS.hb);
            if (!f.exists()) return false;
            return Date.now() - f.lastModified() < (maxAgeMs || 45000);
        } catch (e) { return false; }
    }

    /* ================= 执行 ================= */

    function launchTask(name, path, force) {
        if (!path) return false;
        try {
            if (!new java.io.File(PATHS.main).exists()) { toast("未找到 main.js（任务调度器），请改用脚本型按钮"); return false; }
            const store = storages.create(DAILY_STORE);
            store.put("RunQueue", [{ name: name || "岛任务", path: path }]);
            store.put("RunForce", force !== false);
            engines.execScriptFile(PATHS.main);
            return true;
        } catch (e) {
            toast("启动 main.js 失败：" + e);
            return false;
        }
    }

    function launchScript(path) {
        if (!path) return false;
        try { engines.execScriptFile(path); return true; }
        catch (e) { toast("启动脚本失败：" + e); return false; }
    }

    function openConfig() {
        try {
            engines.execScriptFile(DIR + "/island_config.js");
            return true;
        } catch (e) {
            toast("打开配置页失败：" + e);
            return false;
        }
    }

    /* ================= 与上岛 App 直接通信 ================= */

    function islandModule() {
        return require(BASE + "上岛模块.js");
    }

    /** 不经过任何规则，直接发一次上岛，用于排查链路 */
    function testShow() {
        try {
            const t = new Date();
            const hhmm = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2)
                + ":" + ("0" + t.getSeconds()).slice(-2);
            islandModule().show({ title: "测试上岛", text: "来自脚本 " + hhmm, short: "测试", actions: [] });
            return true;
        } catch (e) {
            log("测试上岛失败: " + e);
            toast("测试失败：" + e);
            return false;
        }
    }

    /** 直接发 STOP 广播下岛（不依赖 daemon 是否在运行） */
    function hideIslandNow() {
        try { islandModule().hide(); return true; }
        catch (e) { log("直接下岛失败: " + e); return false; }
    }

    /* ================= 输入法 / 通知权限 ================= */

    let _imeCache = { at: 0, set: {} };
    function isImePackage(pkg) {
        if (!pkg) return false;
        const now = Date.now();
        if (now - _imeCache.at > 60000) {
            const set = {};
            try {
                const imm = ctx().getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
                const list = imm.getInputMethodList();
                for (let i = 0; i < list.size(); i++) {
                    set[String(list.get(i).getPackageName())] = true;
                }
            } catch (e) { log("枚举输入法失败: " + e); }
            _imeCache = { at: now, set: set };
        }
        return !!_imeCache.set[pkg];
    }

    function notifyPermissionOk() {
        try {
            const s = android.provider.Settings.Secure.getString(
                ctx().getContentResolver(), "enabled_notification_listeners");
            return String(s || "").indexOf(ctx().getPackageName()) !== -1;
        } catch (e) { return false; }
    }

    function openNotifySettings() {
        try {
            app.startActivity({ action: "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS" });
            return true;
        } catch (e) {
            toast("请手动到 系统设置 → 通知 → 通知使用权 开启");
            return false;
        }
    }

    /* ================= 事件探测 ================= */

    function probeEvents(names, ms, done) {
        const hits = {}, regs = [];
        names.forEach(function (n) {
            try {
                const cb = function () { hits[n] = (hits[n] || 0) + 1; };
                auto.registerEvent(n, cb);
                regs.push({ n: n, cb: cb });
            } catch (e) {}
        });
        setTimeout(function () {
            regs.forEach(function (x) { try { auto.removeEvent(x.n); } catch (e) {} });
            if (done) done(hits);
        }, ms || 10000);
    }

    /* ================= 导出：UI 全量透传 + 业务 ================= */

    const api = {};
    for (let k in U) { try { api[k] = U[k]; } catch (e) {} }

    api.UI = UI;
    api.U = U;
    api.T = function () { return U.theme(); };   // 兼容旧调用 kit.T()
    api.PATHS = PATHS;
    api.SWITCH_KEY = SWITCH_KEY;

    api.defaultCfg = defaultCfg;
    api.readCfg = readCfg;
    api.writeCfg = writeCfg;
    api.findDaemonPath = findDaemonPath;

    api.readState = readState;
    api.writeState = writeState;
    api.sendCmd = sendCmd;
    api.daemonAlive = daemonAlive;

    api.launchTask = launchTask;
    api.launchScript = launchScript;
    api.openConfig = openConfig;
    api.testShow = testShow;
    api.hideIslandNow = hideIslandNow;

    /** 收起当前的定时岛 / 通知岛，回到应用岛或默认态（不影响应用岛本身） */
    function hideTimerIsland() {
        sendCmd("hideTimer");
        return true;
    }

    api.hideTimerIsland = hideTimerIsland;

    /* ================= 岛内容变量 ================= */
    /**
     * 自定义变量：岛内容里写 {name} 即可引用。
     * kit.setVar("water", 3)  →  内容 "今天第 {water} 杯" 显示 "今天第 3 杯"
     *
     * 第三个参数：
     *   true                  → 静默写入，不立刻重绘
     *   { daily: true }       → 按天变量，跨天后自动视为 0
     *   { daily: true, silent: true } → 两者都要
     */
    function setVar(name, value, opt) {
        try {
            var store = storages.create("island_vars");
            var silent = false;
            var daily = false;
            if (typeof opt === "boolean") {
                silent = opt;
            } else if (opt && typeof opt === "object") {
                silent = !!opt.silent;
                daily = !!opt.daily;
            }
            store.put(String(name), value);
            if (daily) store.put(String(name) + "__day", new Date().toDateString());
            if (!silent) sendCmd("reload");
            return true;
        } catch (e) { return false; }
    }

    function getVar(name, def) {
        try {
            var store = storages.create("island_vars");
            var n = String(name);
            // 按天变量：跨天视为没有值
            if (store.contains(n + "__day")) {
                if (String(store.get(n + "__day", "")) !== new Date().toDateString()) return def;
            }
            return store.get(n, def);
        } catch (e) { return def; }
    }

    function clearVar(name) {
        try {
            storages.create("island_vars").remove(String(name));
            sendCmd("reload");
            return true;
        } catch (e) { return false; }
    }

    api.setVar = setVar;
    api.getVar = getVar;
    api.clearVar = clearVar;

    api.isImePackage = isImePackage;
    api.notifyPermissionOk = notifyPermissionOk;
    api.openNotifySettings = openNotifySettings;
    api.probeEvents = probeEvents;

    return api;
})();
