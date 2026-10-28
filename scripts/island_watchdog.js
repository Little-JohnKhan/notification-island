"auto";
/* ============================================================
 *  island_watchdog.js  —  daemon 存活看护
 *  由 AutoJs6 定时任务「每分钟一次」触发。无常驻、无轮询。
 *
 *  v2 判据（v1 只看心跳，在会休眠的设备上会天天误判）：
 *    1) 息屏 → 直接退出。定时器本来就该停，心跳断档是正常的。
 *    2) 息屏判断后，用「引擎是否还在」为主判据：
 *         引擎在  → 脚本没死（只是被冻住），只有心跳停超 10 分钟才当卡死重建
 *         引擎不在 → 真崩溃，心跳停超 90 秒就拉起
 *    3) 冷却 5 分钟，避免崩溃循环
 *
 *  构建: v3 / 2026-10-28
 * ========================================================== */

const DIR     = "/storage/emulated/0/脚本/日常/灵动岛";
const HB      = DIR + "/daemon.hb";
const DAEMON  = DIR + "/island_daemon.js";
const LOG     = DIR + "/watchdog.log";
const STORE   = "island_watchdog";

const TIMEOUT    = 90 * 1000;       // 引擎不在时：心跳停这么久就拉起
const HARD       = 30 * 60 * 1000;  // 引擎在时：心跳停这么久才当卡死重建
                                    //（10 分钟会撞上隔夜休眠的正常断档，实测误判 1 次/天）
const COOLDOWN   = 5 * 60 * 1000;   // 两次拉起至少间隔 5 分钟
const LOG_MAX    = 200;

/** 带日期的日志时间戳：跨天也能分清是哪一条 */
function stamp() {
    const d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " "
        + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function appendLog(text) {
    try {
        let old = "";
        try { old = files.read(LOG) || ""; } catch (e) {}
        let lines = old ? old.split("\n").filter(function (x) { return x; }) : [];
        lines.push("[" + stamp() + "] " + text);
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

/** daemon 的引擎是否还在（跨进程时可能看不到，故只作辅助判据） */
function daemonEngineAlive() {
    try {
        const all = engines.all();
        for (let i = 0; i < all.length; i++) {
            try {
                if (String(all[i].getSource() || "").indexOf("island_daemon.js") !== -1) return true;
            } catch (e) {}
        }
    } catch (e) {}
    return false;
}

/* ---- 主流程 ---- */

// 息屏：定时器本就该停，心跳断档是预期行为，什么也不做
// 解锁后下一次触发自然会重新判断
try { if (!device.isScreenOn()) exit(); } catch (e) {}

let last = 0;
try { last = parseInt(files.read(HB), 10) || 0; } catch (e) {}

if (!last) {
    pull("心跳文件缺失");
    exit();
}

const gap = Date.now() - last;
const engineAlive = daemonEngineAlive();

// 引擎还在 → 脚本没死，等它自己恢复
if (engineAlive && gap <= HARD) exit();

// 引擎不在 → 真崩溃，心跳停 90 秒即可重建
if (!engineAlive && gap <= TIMEOUT) exit();

// 冷却期内不重复拉起
const store = storages.create(STORE);
const lastPull = Number(store.get("lastPull", 0)) || 0;
if (lastPull && Date.now() - lastPull < COOLDOWN) {
    appendLog((engineAlive ? "引擎仍在，" : "") + "心跳停在 " + Math.round(gap / 1000) +
              " 秒前，但冷却中（上次拉起 " +
              Math.round((Date.now() - lastPull) / 1000) + " 秒前），跳过");
    exit();
}

store.put("lastPull", Date.now());
pull((engineAlive ? "引擎仍在但心跳停 " : "心跳停在 ") + Math.round(gap / 1000) + " 秒前");
