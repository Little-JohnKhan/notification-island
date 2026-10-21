"auto";
/* ============================================================
 *  island_watchdog.js  —  daemon 存活看护
 *  由 AutoJs6 定时任务「每分钟一次」触发，无常驻、无轮询。
 *  逻辑：读 daemon.hb，超过 3 分钟没更新就拉起 daemon。
 *  构建: v1 / 2026-10-21
 * ========================================================== */

const DIR     = "/storage/emulated/0/脚本/日常/灵动岛";
const HB      = DIR + "/daemon.hb";
const DAEMON  = DIR + "/island_daemon.js";
const LOG     = DIR + "/watchdog.log";
const STORE   = "island_watchdog";

const TIMEOUT    = 3 * 60 * 1000;   // 心跳超过 3 分钟未更新判定为死
const COOLDOWN   = 5 * 60 * 1000;   // 两次拉起至少间隔 5 分钟，避免崩溃循环
const LOG_MAX    = 200;             // 日志最多保留 200 行

function hhmmss() {
    const d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function appendLog(text) {
    try {
        let old = "";
        try { old = files.read(LOG) || ""; } catch (e) {}
        let lines = old ? old.split("\n") : [];
        lines.push("[" + hhmmss() + "] " + text);
        if (lines.length > LOG_MAX) lines = lines.slice(lines.length - LOG_MAX);
        files.write(LOG, lines.join("\n"));
    } catch (e) {}
}

function pull(reason) {
    appendLog(reason + " → 拉起 daemon");
    try {
        engines.execScriptFile(DAEMON);
    } catch (e) {
        appendLog("拉起失败: " + e);
    }
}

/* ---- 主流程 ---- */
let last = 0;
try { last = parseInt(files.read(HB), 10) || 0; } catch (e) {}

// 从没跑过 → 直接拉起
if (!last) {
    pull("心跳文件缺失");
    exit();
}

const gap = Date.now() - last;

// 心跳正常，静默退出（不写日志，避免每分钟刷屏）
if (gap <= TIMEOUT) exit();

// 冷却期内不重复拉起
const store = storages.create(STORE);
const lastPull = Number(store.get("lastPull", 0)) || 0;
if (lastPull && Date.now() - lastPull < COOLDOWN) {
    appendLog("心跳停在 " + Math.round(gap / 1000) + " 秒前，但冷却中（上次拉起 " +
              Math.round((Date.now() - lastPull) / 1000) + " 秒前），跳过");
    exit();
}

store.put("lastPull", Date.now());
pull("心跳停在 " + Math.round(gap / 1000) + " 秒前");
