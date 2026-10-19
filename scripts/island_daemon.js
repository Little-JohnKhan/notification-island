/**
 * island_daemon.js —— 前台感知 + 定时触发 + 双岛叠加（常驻后台，非 ui 模式）
 * ------------------------------------------------------------------
 * 依赖：
 *   /storage/emulated/0/脚本/常用模块/上岛模块.js
 *   /storage/emulated/0/脚本/灵动岛/island_kit.js
 * 配置：island_rules.json（配置页生成，支持热重载）
 *
 * 双岛模型：
 *   stack 最多两层 —— 定时层(timer) / 应用层(fg)，上层展示。
 *   定时触发 → 定时层置顶；点「切回 xx」→ 上下交换；定时到期 → 定时层出栈。
 * ------------------------------------------------------------------
 */
const MODULE_DIR = "/storage/emulated/0/脚本/常用模块/";
const island = require(MODULE_DIR + "上岛模块.js");
const kit = require("./island_kit.js");

const MAX_ACTIONS = 3;
const TICK_MS = 30000;      // 调度 + 倒计时
const CMD_MS = 1000;        // 命令轮询（配置页 → 守护）
const BUILD = "v40 / 2026-10-19 23:12";

/* ================== 运行时状态 ================== */
let cfg = null;
let cfgMtime = -1;
let registered = [];        // [{ name, cb }]

let fgPkg = "";
let fgRule = null;          // 当前前台命中的规则
let timerRule = null;       // 当前「上层」规则（定时岛或通知岛）
let timerEndAt = 0;         // 0 = 一直显示
let showTimer = false;      // 当前展示的是上层
let upperKind = "timer";    // 上层来源：timer | notify
let notifyCtx = { title: "", text: "", app: "" };   // 当前通知的模板变量
let muteUntil = 0;          // 手动下岛后的抑制截止时间
let lastRun = {};           // interval 类型上次执行时间
let fired = {};             // 去重：id@yyyy-MM-dd HH:mm
let lastSig = "";           // 上岛内容签名（避免重复广播）
let lastCurrent = {};       // 给配置页看的「当前岛」信息
let lastCmdAt = 0;
let pendingTimer = null;
let lastEventAt = 0;        // 最近一次收到无障碍事件的时间
let lastRenderAt = 0;       // 最近一次真正推送岛内容的时间
let lastReregisterAt = 0;   // 最近一次自愈重注册的时间（带冷却）
let noRuleTimer = null;     // 未命中规则的延迟判定
let keepSince = 0;          // 进入「保持不动」的时间
let islandHidden = false;   // 已撤岛标记（避免重复发 STOP）

/* ================== 配置 ================== */
function refreshCfg(force) {
    const f = new java.io.File(kit.PATHS.cfg);
    const mt = f.exists() ? f.lastModified() : 0;
    if (!force && cfg && mt === cfgMtime) return cfg;
    cfgMtime = mt;
    cfg = kit.readCfg();

    // 上层规则如果被删/禁用，直接出栈
    if (timerRule) {
        const pool = upperKind === "notify" ? (cfg.notifies || []) : (cfg.schedules || []);
        const still = pool.filter(function (s) {
            return s.id === timerRule.id && s.enabled !== false;
        })[0];
        if (!still) { timerRule = null; timerEndAt = 0; showTimer = false; upperKind = "timer"; }
        else timerRule = still;
    }
    initIntervals();
    syncEvents();
    return cfg;
}

/** interval 规则首次出现时只登记时间，不立刻触发一次 */
function initIntervals() {
    (cfg.schedules || []).forEach(function (s) {
        if (s.when && s.when.type === "interval" && !(s.id in lastRun)) {
            lastRun[s.id] = Date.now();
        }
    });
}

function syncEvents() {
    registered.forEach(function (it) { try { auto.removeEvent(it.name); } catch (e) {} });
    registered = [];
    const names = cfg.events || ["WINDOW_STATE_CHANGED"];
    names.forEach(function (name) {
        const cb = function (e) { onAccessibility(name, e); };
        try {
            auto.registerEvent(name, cb);
            registered.push({ name: name, cb: cb });
        } catch (e) { log("注册事件失败 " + name + ": " + e); }
    });
}

/* ================== 事件 → 前台判定 ================== */
const FOREGROUND_EVENTS = ["WINDOW_STATE_CHANGED"];

// 桌面是「前台失效」；通知栏/输入法这类只是临时弹层，必须保持原状，否则会闪
const LAUNCHERS = [
    "com.miui.home", "com.huawei.android.launcher", "com.android.launcher",
    "com.android.launcher3", "com.oppo.launcher", "com.vivo.launcher",
    "com.bbk.launcher2", "com.sec.android.app.launcher",
    "com.google.android.apps.nexuslauncher",
];

function isLauncher(pkg) { return LAUNCHERS.indexOf(pkg) !== -1; }

/**
 * 桌面包名里的「真桌面」类名。
 * 实测 HyperOS（com.android.launcher）：
 *   桌面   → com.android.launcher.Launcher
 *   后台卡片 → android.widget.ListView   （另见 isRecents 的通用关键字）
 * 所以 launcher 包里只要类名不是桌面本体，就一律当卡片/过渡窗口，保持原状。
 */
const HOME_CLS_KEYWORDS = ["launcher", "home", "workspace"];

function isHomeWindow(cls) {
    if (!cls) return true;              // 拿不到类名时保守按桌面处理
    const s = cls.toLowerCase();
    for (let i = 0; i < HOME_CLS_KEYWORDS.length; i++) {
        if (s.indexOf(HOME_CLS_KEYWORDS[i]) !== -1) return true;
    }
    return false;
}

/**
 * 后台卡片（最近任务）的通用类名特征（其它 ROM 用得上）
 */
const RECENTS_KEYWORDS = ["recents", "quickstep", "overview", "taskview", "recentapps"];

function isRecents(cls) {
    if (!cls) return false;
    const s = cls.toLowerCase();
    for (let i = 0; i < RECENTS_KEYWORDS.length; i++) {
        if (s.indexOf(RECENTS_KEYWORDS[i]) !== -1) return true;
    }
    return false;
}

/* ================== 控件树反查 ==================
 * 系统「降级」后 currentPackage / currentActivity 会变成桌面或 SystemUI，
 * 但活动窗口的控件树仍然保留真实应用（实测 ima 稳定 90~100 个节点）。
 * 返回：
 *   "com.xxx"  → 找到真实应用
 *   ""         → 树里全是系统包 / 桌面 / 输入法，判定为真桌面
 *   null       → 取不到控件树，调用方回退到旧逻辑
 */
const SYSTEM_PKGS = LAUNCHERS.concat(["com.android.systemui", "com.android.settings"]);

function isSystemPkg(p) {
    if (!p) return true;
    if (SYSTEM_PKGS.indexOf(p) !== -1) return true;
    return kit.isImePackage(p);
}

let lastTreeScanAt = 0;

function detectRealPkg() {
    const now = Date.now();
    if (now - lastTreeScanAt < 800) return null;   // 节流，避免连续事件反复扫树
    lastTreeScanAt = now;

    var root = null;
    try { root = auto.rootInActiveWindow; } catch (e) { }
    if (!root) { try { root = auto.root; } catch (e) { } }
    if (!root) return null;

    var count = {};
    var stack = [root];
    var n = 0;

    while (stack.length > 0 && n < 600) {
        var u = stack.pop();
        n++;
        try {
            var p = String(u.packageName() || "");
            if (p && !isSystemPkg(p)) count[p] = (count[p] || 0) + 1;
            var cn = u.childCount();
            for (var i = 0; i < cn; i++) {
                var ch = u.child(i);
                if (ch) stack.push(ch);
            }
        } catch (e) { }
    }

    var best = "";
    var bestN = 0;
    for (var k in count) {
        if (count[k] > bestN) { bestN = count[k]; best = k; }
    }
    return best;
}

function onAccessibility(name, event) {
    try {
        lastEventAt = Date.now();
        if (FOREGROUND_EVENTS.indexOf(name) === -1) return;
        const pkg = String(event.packageName || "");
        if (!pkg) return;
        const cls = String(event.className || "");

        // 诊断：记录最近一条窗口事件，供配置页查看（只在变化时写，避免频繁 IO）
        if (pkg !== lastEvtPkg || cls !== lastEvtCls) {
            lastEvtPkg = pkg;
            lastEvtCls = cls;
            try {
                storages.create("island_state").put("lastEvt", { pkg: pkg, cls: cls, at: Date.now() });
            } catch (e) {}
        }

        // 后台卡片：只是「看一眼」，不是真的离开。
        // 关键：卡片页会把 promoted 通知整条藏起来，回来时必须重新 notify 才恢复，
        // 所以这里既要保持原岛，也要记下「刚从卡片回来」，回到应用时强制重发一次。
        const cardPage = isRecents(cls) || (isLauncher(pkg) && !isHomeWindow(cls));
        if (cardPage) {
            inRecents = true;
            if (deskTimer) { clearTimeout(deskTimer); deskTimer = null; }
            return;
        }

        if (isLauncher(pkg)) {
            inRecents = false;
            confirmDesktop();           // 回桌面：延迟复核
            return;
        }
        // 输入法浮层：包名是输入法，但真正的前台是「输入框所属应用」。
        // 从卡片回来直接点输入框时，全靠这一步把岛拉回宿主应用。
        if (kit.isImePackage(pkg)) {
            probeImeHost();
            return;
        }
        if (isIgnored(pkg)) return;     // 系统 UI：保持原状

        lastPkgEventAt = Date.now();
        const backFromRecents = inRecents;
        inRecents = false;

        // 从卡片回来时，即使前台包名没变也要重发一次，否则岛一直停在「被系统藏起来」的状态
        if (pkg === fgPkg && fgRule && !backFromRecents) return;

        // 命中规则的应用立即上岛，不等 250ms 复核（复核可能被输入法抢走）
        refreshCfg();
        const hit = findRule(pkg, cls);
        if (hit) {
            fgPkg = pkg;
            fgRule = hit;
            if (Date.now() < muteUntil) muteUntil = 0;
            render();
            return;
        }
        schedule(pkg, cls);
    } catch (e) { log("事件异常: " + e); }
}

let deskTimer = null;
let lastPkgEventAt = 0;   // 最近一次「非桌面」的窗口事件时间
let lastEvtPkg = "";
let lastEvtCls = "";
let inRecents = false;    // 是否刚从后台卡片页过来（该页会把岛隐藏）

/* ================== 输入法 → 宿主应用 ================== */
let imeProbeAt = 0;

/**
 * 输入法弹出时，事件包名是输入法本身，直接忽略会导致：
 * 从卡片回应用、直接点输入框 → 岛一直停在默认态，必须再点一次才行。
 * 这里用「可编辑控件」反查它所属的应用，再用该应用跑一次规则。
 * 只在宿主应用有规则时生效，避免打字过程把岛打成默认态。
 */
function probeImeHost() {
    const now = Date.now();
    if (now - imeProbeAt < 800) return;   // 节流：输入法窗口事件可能连发
    imeProbeAt = now;

    setTimeout(function () {
        try {
            var host = detectRealPkg();      // 控件树最可靠
            if (!host) host = hostByEditable();
            if (!host) return;
            refreshCfg();
            const hit = findRule(host, "");
            if (!hit) return;
            fgPkg = host;
            fgRule = hit;
            if (Date.now() < muteUntil) muteUntil = 0;
            render();
        } catch (e) { }
    }, 200);   // 等输入框渲染出来
}

function hostByEditable() {
    try {
        const e = editable(true).findOnce();
        if (e) {
            const p = String(e.packageName() || "");
            if (p && !kit.isImePackage(p) && !isIgnored(p)) return p;
        }
    } catch (e) { }
    // 输入法窗口拿不到宿主控件时，从 Activity 名反查已知规则应用
    // （输入法弹出时 currentActivity 常常仍是宿主的 Activity）
    try {
        const act = String(currentActivity() || "");
        if (act) {
            const hit = (cfg.rules || []).filter(function (r) { return act.indexOf(r.pkg) === 0; })[0];
            if (hit) return hit.pkg;
        }
    } catch (e) { }
    try {
        const cur = String(currentPackage() || "");
        if (cur && !kit.isImePackage(cur) && !isIgnored(cur)) return cur;
    } catch (e) { }
    return "";
}

/**
 * 到期复核：滑出卡片后系统常常再补一串 Launcher 事件，光过滤 ListView 不够。
 * 到达延迟末尾时，以「真实前台」为准重新落一次：
 *   - 还在卡片页（launcher 包 + 非桌面类名）→ 保持原岛
 *   - 真实前台是有规则的应用 → 交给 commit，避免把刚上好的岛清成默认态
 *     （从卡片点回应用时，桌面事件会比应用事件更晚到达，这是闪默认态的根因）
 *   - 真桌面 → 清空
 */
function confirmDesktop() {
    const t0 = Date.now();
    const delay = Number((cfg.safety && cfg.safety.desktopDelayMs) || 800);
    if (deskTimer) clearTimeout(deskTimer);
    deskTimer = setTimeout(function () {
        deskTimer = null;
        if (lastPkgEventAt > t0) return;   // 期间来了应用事件 → 不是真的回桌面

        // 优先看控件树：系统降级后 currentPackage 会说谎
        const real = detectRealPkg();
        if (real) {              // 找到真实应用 → 强制重发一次（岛可能已被系统藏起来）
            refreshCfg();
            const realRule = findRule(real, "");
            if (realRule) {
                fgPkg = real;
                fgRule = realRule;
                if (Date.now() < muteUntil) muteUntil = 0;
                render();
            } else {
                commit(real, "");
            }
            return;
        }
        if (real === "") {       // 树里全是系统包 / 桌面 → 确实回桌面
            fgPkg = "";
            fgRule = null;
            render();
            return;
        }

        // 取不到控件树 → 回退到旧的前台判定
        let p = "", c = "";
        try { p = String(currentPackage() || ""); c = String(currentActivity() || ""); } catch (e) { }

        if (p && isRecents(c)) return;                       // 卡片页
        if (p && isLauncher(p) && !isHomeWindow(c)) return;  // 卡片页（launcher 包）

        if (p && !isLauncher(p)) {          // 真实前台已经切回应用
            refreshCfg();
            fgPkg = p;
            fgRule = findRule(p, c);
            if (Date.now() < muteUntil) muteUntil = 0;
            render();                       // 卡片页把岛藏了，这里必须重发
            return;
        }

        fgPkg = "";
        fgRule = null;
        render();
    }, delay);
}

function schedule(pkg, cls) {
    if (pendingTimer) clearTimeout(pendingTimer);
    const delay = (cfg.safety && cfg.safety.debounceMs) || 250;
    pendingTimer = setTimeout(function () {
        pendingTimer = null;
        commit(pkg, cls);
    }, delay);
}

function commit(pkg, cls) {
    refreshCfg();

    // 以「事件里的包名」为准。
    // 不再用 currentPackage() 覆盖：某些全屏应用（如 Adobe AIR 系）退出后，
    // 无障碍的 active window 仍停留在它身上，覆盖会把正确的前台改回旧应用。
    if (!pkg || isIgnored(pkg)) return;
    if (pkg === fgPkg && fgRule) return;

    fgPkg = pkg;
    fgRule = findRule(pkg, cls);
    if (Date.now() < muteUntil) muteUntil = 0;  // 前台变了 → 解除抑制
    render();
}

function findRule(pkg, cls) {
    const hit = (cfg.rules || []).filter(function (r) {
        return r.enabled !== false && r.pkg === pkg;
    });
    if (!hit.length) return null;
    if (cls) {
        for (let i = 0; i < hit.length; i++) {
            if (hit[i].matchClass && cls.indexOf(hit[i].matchClass) !== -1) return hit[i];
        }
    }
    return hit.filter(function (r) { return !r.matchClass; })[0] || hit[0];
}

function isIgnored(pkg) {
    if (!pkg) return true;
    if (kit.isImePackage(pkg)) return true;     // 动态识别输入法，换输入法也有效
    return (cfg && cfg.ignore || []).indexOf(pkg) !== -1;
}

/* ================== 双岛：取值 / 渲染 ================== */
function pickLayer() {
    if (timerRule && showTimer) return { kind: "timer", rule: timerRule };
    if (fgRule) return { kind: "fg", rule: fgRule };
    if (timerRule) return { kind: "timer", rule: timerRule };
    return null;
}

function render() {
    if (Date.now() < muteUntil) return;
    const layer = pickLayer();
    if (!layer) { noLayer(); return; }
    const other = layer.kind === "timer" ? fgRule : timerRule;
    push(buildPayload(layer.rule, layer.kind, other));
    lastRenderAt = Date.now();
    lastCurrent = {
        kind: layer.kind,
        name: displayName(layer.rule),
        id: layer.rule.id,
        hasOther: !!other,
    };
    persist();
}

function noLayer() {
    const delay = Number((cfg.safety && cfg.safety.noRuleDelayMs) || 0);
    if (delay <= 0) { applyNoRule(); return; }

    if (noRuleTimer) clearTimeout(noRuleTimer);
    noRuleTimer = setTimeout(function () {
        noRuleTimer = null;
        if (pickLayer()) { render(); return; }   // 延迟期间又命中了，撤销这次
        applyNoRule();
    }, delay);
}

/** 「未命中规则」的实际处理（延迟后执行） */
function applyNoRule() {
    const mode = (cfg.lifecycle && cfg.lifecycle.onNoRule) || "default";

    if (mode === "hide") {
        keepSince = 0;
        hideIsland();
        return;
    }
    if (mode === "keep") {
        if (!keepSince) keepSince = Date.now();
        return;
    }

    keepSince = 0;
    const d = cfg.island.default || {};
    push({
        title: d.title || "",
        text: d.content || "",
        short: d.short || "",
        actions: [],
    });
    lastCurrent = { kind: "none", name: d.title || "默认", id: "", hasOther: false };
    persist();
}

function buildPayload(rule, kind, other) {
    const c = rule.island || {};
    const isNotify = (kind === "timer" && upperKind === "notify" && rule === timerRule);
    const nctx = isNotify ? notifyCtx : { title: "", text: "", app: "" };

    let text = fillTpl(c.content || (isNotify ? "{title}：{text}" : ""), nctx);

    // 倒计时：展示应用层时，提示上层还剩多久
    if (kind === "fg" && timerRule && timerEndAt > 0) {
        const left = leftMinutes();
        if (left > 0) text = (text ? text + " · " : "") + "「" + displayName(timerRule) + "」还有 " + left + " 分钟";
    }

    return {
        title: fillTpl(c.title || (isNotify ? "{app}" : displayName(rule)), nctx),
        text: text,
        short: fillTpl(c.short || "", nctx),
        icon: c.icon || undefined,
        actions: buildButtons(rule, other),
    };
}

/**
 * 变量模板：{app} {title} {text} {time} {date} {hour} {min} {sec}
 * 以及 island_vars 里的自定义变量，例如 {water}。
 * 未知变量原样保留，方便排查拼写。
 */
function fillTpl(s, ctx) {
    const t = new Date();
    const base = {
        app: ctx.app || "",
        title: ctx.title || "",
        text: ctx.text || "",
        time: ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2),
        date: (t.getMonth() + 1) + "/" + t.getDate(),
        hour: String(t.getHours()),
        min: String(t.getMinutes()),
        sec: ("0" + t.getSeconds()).slice(-2),
    };
    var store = null;
    try { store = storages.create("island_vars"); } catch (e) { }

    var today = new Date().toDateString();

    return String(s == null ? "" : s).replace(/\{(\w+)\}/g, function (m, k) {
        if (k in base) return base[k];
        // AutoJs6 的 storages 没有 getAll()，只能按名逐个读
        if (!store) return m;
        var v = null;
        try {
            // 按天变量：有 xxx__day 记录且不是今天 → 视为 0
            if (store.contains(k + "__day")) {
                if (String(store.get(k + "__day", "")) !== today) return "0";
            }
            v = store.get(k, null);
        } catch (e) { v = null; }
        if (v === null || v === undefined) return m;
        return String(v);
    });
}

/** 切换键占一个按钮位；没有另一层时正常给 3 个 */
function buildButtons(rule, other) {
    const raw = (rule.island && rule.island.buttons) || [];
    const cap = other ? MAX_ACTIONS - 1 : MAX_ACTIONS;
    const out = [];
    raw.forEach(function (b, i) {
        if (out.length >= cap) return;
        if (!b || b.type === "none" || !b.label) return;
        out.push({ title: b.label, key: rule.id + "#" + i, icon: b.icon || undefined });
    });
    if (other) {
        out.push({ title: "切回" + displayName(other), key: kit.SWITCH_KEY });
    }
    return out.slice(0, MAX_ACTIONS);
}

function displayName(rule) {
    const c = rule.island || {};
    const s = String(c.short || c.title || rule.name || rule.appName || "");
    return s.length > 3 ? s.substring(0, 3) : s;
}

function leftMinutes() {
    if (!timerEndAt) return 0;
    const ms = timerEndAt - Date.now();
    return ms > 0 ? Math.max(1, Math.ceil(ms / 60000)) : 0;
}

function push(payload) {
    const sig = JSON.stringify(payload);
    if (sig === lastSig) return;
    try {
        island.show(payload);
        lastSig = sig;                 // 只有发成功才记，失败允许下次重试
        islandHidden = false;
    } catch (e) {
        lastSig = "";
        log("上岛失败: " + e);
    }
}

function hideIsland() {
    if (islandHidden) {                // 已经在撤岛状态，不重复发广播
        lastCurrent = { kind: "none", name: "已下岛", id: "", hasOther: false };
        persist();
        return;
    }
    islandHidden = true;
    lastSig = "";
    try { island.hide(); } catch (e) { log("下岛失败: " + e); }
    lastCurrent = { kind: "none", name: "已下岛", id: "", hasOther: false };
    persist();
}

/* ================== 定时调度 ================== */
function pad2(n) { return n < 10 ? ("0" + n) : ("" + n); }
function floorMin(d) { return Math.floor(d.getTime() / 60000) * 60000; }
function hhmm(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
function dayOf(d) { return d.getDay() === 0 ? 7 : d.getDay(); }

function tick() {
    const now = new Date();
    const prev = new Date(now.getTime() - 60000);
    // 两个候选分钟：当前分钟 + 前一分钟（30s tick 可能跨过整分边界，避免漏触发）
    const cands = [
        { ts: floorMin(now), hhmm: hhmm(now), day: dayOf(now) },
        { ts: floorMin(prev), hhmm: hhmm(prev), day: dayOf(prev) },
    ];

    // 上层到期 → 出栈
    if (timerRule && timerEndAt > 0 && Date.now() >= timerEndAt) {
        timerRule = null;
        timerEndAt = 0;
        showTimer = false;
        upperKind = "timer";
        render();
    }

    // 「保持不动」超时 → 回落默认态
    const keepMax = Number((cfg.lifecycle && cfg.lifecycle.keepMaxMin) || 0);
    if (keepSince && keepMax > 0 && Date.now() - keepSince > keepMax * 60000) {
        keepSince = 0;
        const d = cfg.island.default || {};
        push({ title: d.title || "", text: d.content || "", short: d.short || "", actions: [] });
        lastCurrent = { kind: "none", name: d.title || "默认", id: "", hasOther: false };
        persist();
    }

    // 触发检查
    (cfg.schedules || []).forEach(function (s) {
        if (s.enabled === false) return;
        const hit = matchWhen(s, cands);
        if (!hit) return;
        const key = s.id + "@" + hit;
        if (fired[key]) return;
        fired[key] = Date.now();
        cleanFired(now);
        fire(s);
    });

    // 倒计时刷新（展示应用层时才有可见变化）
    if (timerRule && timerEndAt > 0 && !showTimer) render();
}

/** 命中返回本次对应的时间点(ms)，否则 null */
function matchWhen(s, cands) {
    const w = s.when || {};

    if (w.type === "interval") {
        const every = Number(w.everyMin || 0) * 60000;
        if (every <= 0) return null;
        const last = Number(lastRun[s.id] || 0);
        return (Date.now() - last >= every) ? cands[0].ts : null;
    }

    for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        if (w.type === "weekly") {
            if (String(c.hhmm) !== String(w.at || "")) continue;
            if ((w.days || []).indexOf(c.day) === -1) continue;
            return c.ts;
        }
        if ((w.at || []).indexOf(c.hhmm) !== -1) return c.ts;
    }
    return null;
}

function cleanFired(now) {
    const today = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
    Object.keys(fired).forEach(function (k) {
        if (k.indexOf(today) === -1) delete fired[k];
    });
}

function fire(s) {
    timerRule = s;
    upperKind = "timer";
    showTimer = true;
    timerEndAt = Number(s.durationMin) > 0 ? Date.now() + Number(s.durationMin) * 60000 : 0;
    lastRun[s.id] = Date.now();
    render();
    if (s.autoRun) autoRun(s);
    log("定时上岛: " + (s.name || s.id));
}

function autoRun(s) {
    const bs = (s.island && s.island.buttons) || [];
    let n = 0;
    bs.forEach(function (b) {
        if (!b || !b.value) return;
        if (b.type === "task") { kit.launchTask(b.name || b.label, b.value, true); n++; }
        else if (b.type === "script") { kit.launchScript(b.value); n++; }
    });
    if (n) log("定时直跑 " + n + " 个任务");
}

/* ================== 按钮分发 ================== */
const SWITCH_ALIASES = [
    kit.SWITCH_KEY, "islandswitch", "__switch", "_switch", "switch", "swtich",
];

island.on("*", function (key) {
    threads.start(function () {
        try {
            refreshCfg();

            const k = String(key == null ? "" : key);
            try {
                storages.create("island_state").put("lastTap", { key: k, at: Date.now() });
            } catch (e) {}
            if (cfg.safety && cfg.safety.debug) toast("点击 key: " + k);
            if (!k || k === "null" || k === "undefined") return;   // 点岛本体：App 端未接入，忽略

            // 切换键：端上可能改写 key，兼容几种写法
            if (SWITCH_ALIASES.indexOf(k) !== -1) {
                doSwitch();
                return;
            }

            const parts = k.split("#");
            let rule = (cfg.rules || []).filter(function (r) { return r.id === parts[0]; })[0];
            let btn = null;
            if (rule) btn = ((rule.island && rule.island.buttons) || [])[Number(parts[1])];
            if (!btn) {
                const s = (cfg.schedules || []).filter(function (x) { return x.id === parts[0]; })[0];
                if (s) btn = ((s.island && s.island.buttons) || [])[Number(parts[1])];
            }
            if (!btn) {
                const n = (cfg.notifies || []).filter(function (x) { return x.id === parts[0]; })[0];
                if (n) btn = ((n.island && n.island.buttons) || [])[Number(parts[1])];
            }
            if (!btn) { toast("按钮不存在: " + k); return; }
            runAction(btn);
        } catch (e) {
            log("按钮处理异常: " + e);
            toast("按钮处理异常: " + e);
        }
    });
});

function doSwitch() {
    if (!fgRule && !timerRule) return;
    if (!fgRule) { toast("当前没有应用岛可切"); return; }
    showTimer = !showTimer;
    persist();
    render();
}

function runAction(b) {
    switch (b.type) {
        case "task":
            if (!b.value) return toast("未绑定脚本路径");
            kit.launchTask(b.name || b.label, b.value, true);
            break;
        case "script":
            if (!b.value) return toast("未绑定脚本路径");
            kit.launchScript(b.value);
            break;
        case "code":
            if (!b.value) return toast("未配置代码");
            engines.execScript("island_action.js", b.value);   // 注意：(name, script)
            setTimeout(function () { refreshCfg(); render(); }, 400);   // 变量可能被改了
            break;
        case "app":
            if (!b.value) return toast("未配置包名");
            app.launchPackage(b.value);
            break;
        case "page":
            kit.openConfig();
            break;
        case "hide":
            dismissCurrent();
            break;
        case "last":
            doSwitch();
            break;
        case "none":
        default:
            break;
    }
}

/* ================== 通知岛 ================== */
function startNotifyListener() {
    try {
        events.observeNotification();
        events.on("notification", function (n) {
            try { onNotification(n); } catch (e) { log("通知处理异常: " + e); }
        });
        log("通知监听已启动");
    } catch (e) {
        log("通知监听启动失败（可能未授予通知使用权）: " + e);
    }
}

function onNotification(n) {
    if (Date.now() < muteUntil) return;

    const pkg = String(n.getPackageName() || "");
    if (!pkg || isIgnored(pkg)) return;

    const pool = (cfg.notifies || []).filter(function (r) {
        return r.enabled !== false && r.pkg === pkg;
    });
    if (!pool.length) return;

    const title = String(n.getTitle() || "");
    const text = String(n.getText() || "");

    const rule = pool.filter(function (r) {
        if (!r.keyword) return true;
        return (title + " " + text).indexOf(r.keyword) !== -1;
    })[0];
    if (!rule) return;

    notifyCtx = { title: title, text: text, app: rule.appName || pkg };
    timerRule = rule;
    upperKind = "notify";
    showTimer = true;
    timerEndAt = Number(rule.durationMin) > 0
        ? Date.now() + Number(rule.durationMin) * 60000
        : 0;

    render();
    log("通知上岛: " + pkg + " / " + title);
}

/* ================== 下岛 ================== */
/** 岛上的「下岛」按钮：定时岛只清定时层，应用岛才整体下岛 */
function dismissCurrent() {
    if (showTimer && timerRule) {
        timerRule = null;
        timerEndAt = 0;
        showTimer = false;
        render();
        toast("定时岛已下");
    } else {
        manualHide();
    }
}

function manualHide() {
    const min = (cfg.lifecycle && cfg.lifecycle.manualMuteMin) || 10;
    muteUntil = Date.now() + min * 60000;
    timerRule = null;
    timerEndAt = 0;
    showTimer = false;
    hideIsland();
    toast("已下岛，" + min + " 分钟内不再自动上岛");
}

/* ================== 命令 / 心跳 / 兜底 ================== */
function startCmdLoop() {
    setInterval(function () {
        try {
            const c = storages.create("island_state").get("cmd", null);
            if (!c || !c.at || c.at <= lastCmdAt) return;
            lastCmdAt = c.at;
            refreshCfg();
            if (c.action === "hide") manualHide();
            else if (c.action === "reload") { refreshCfg(true); render(); }
            else if (c.action === "showTimer") { showTimer = true; render(); }
            else if (c.action === "showFg") { showTimer = false; render(); }
            else if (c.action === "hideTimer") {
                if (timerRule) {
                    timerRule = null;
                    timerEndAt = 0;
                    showTimer = false;
                    render();          // 回落到应用岛或默认态
                }
            }
        } catch (e) { log("命令处理异常: " + e); }
    }, CMD_MS);
}

function startHeartbeat() {
    const safety = cfg.safety || {};
    let lastScreenOn = device.isScreenOn();
    const ms = Number(safety.heartbeatMs || 0);
    if (ms > 0) {
        // 兜底：无障碍事件被清空时仍能跟上前台变化
        setInterval(function () {
            try {
                refreshCfg();
                if (new java.io.File(kit.PATHS.dir).exists()) {
                    files.write(kit.PATHS.hb, String(Date.now()));
                }

                // 自愈：事件回调若被清空（AutoJs6 老问题），这里重新注册
                if (lastEventAt && Date.now() - lastEventAt > 90000) {
                    log("事件静默超过 90 秒，重新注册无障碍回调");
                    syncEvents();
                    lastEventAt = Date.now();
                }

                // 息屏 / 亮屏切换：息屏可撤岛，亮屏恢复
                const screenOn = device.isScreenOn();
                if (screenOn !== lastScreenOn) {
                    lastScreenOn = screenOn;
                    if (!screenOn) {
                        if (cfg.safety.hideWhenScreenOff !== false) hideIsland();
                    } else {
                        lastSig = "";      // 强制重发，绕过内容去重
                        render();
                    }
                }
                if (safety.onlyWhenScreenOn && !screenOn) return;

                let cur = "";
                try { cur = String(currentPackage() || ""); } catch (e) {}
                if (!cur || isIgnored(cur)) {
                    // 输入法 / 系统 UI 占位时换一个来源再试
                    try {
                        const act = String(currentActivity() || "");
                        const p = act.split("/")[0];
                        if (p && !isIgnored(p)) cur = p;
                    } catch (e) {}
                }

                // 自愈：前台确实变了，但事件迟迟没来 → 回调可能被清空
                // 只在「前台变化 + 静默 60s + 距上次重注册 5 分钟」时触发，
                // 设备静止或事件正常时都不会进这个分支
                if (cur && !isIgnored(cur) && cur !== fgPkg
                    && Date.now() - lastEventAt > 60000
                    && Date.now() - lastReregisterAt > 300000) {
                    lastReregisterAt = Date.now();
                    log("前台已变化但事件静默，重新注册无障碍回调");
                    syncEvents();
                    lastEventAt = Date.now();
                }

                if (Date.now() < muteUntil) return;

                // 事件仍在活跃时不做覆盖：currentPackage 可能停留在旧应用（全屏应用尤其明显）
                const stale = !lastEventAt || (Date.now() - lastEventAt > 60000);
                if (fgPkg && fgRule && !stale) return;
                if (!cur || isIgnored(cur)) return;
                if (cur === fgPkg && fgRule) return;

                fgPkg = cur;
                fgRule = findRule(cur, "");
                render();
            } catch (e) { log("心跳异常: " + e); }
        }, ms);
    } else {
        // 无需兜底时，只写心跳文件给配置页看
        setInterval(function () {
            try {
                if (new java.io.File(kit.PATHS.dir).exists()) {
                    files.write(kit.PATHS.hb, String(Date.now()));
                }
            } catch (e) {}
        }, 30000);
    }
    // 调度独立 30s
    setInterval(function () {
        try { refreshCfg(); tick(); } catch (e) { log("调度异常: " + e); }
    }, TICK_MS);
}

/* ================== 持久化 ================== */
function persist() {
    kit.writeState({
        timerId: timerRule ? timerRule.id : "",
        timerEndAt: timerEndAt,
        showTimer: showTimer,
        upperKind: upperKind,
        muteUntil: muteUntil,
        lastRun: lastRun,
        current: lastCurrent,
        lastEventAt: lastEventAt,
        lastRenderAt: lastRenderAt,
        dir: kit.PATHS.dir,          // 供配置页核对：两边是否指向同一个目录
        build: BUILD,
        at: Date.now(),
    });
}

function restore() {
    const s = kit.readState();
    muteUntil = Number(s.muteUntil || 0);
    lastRun = s.lastRun || {};
    if (s.at) lastCmdAt = Number(s.at);
    upperKind = s.upperKind === "notify" ? "notify" : "timer";

    if (s.timerId && (Number(s.timerEndAt) === 0 || Number(s.timerEndAt) > Date.now())) {
        const pool = upperKind === "notify" ? (cfg.notifies || []) : (cfg.schedules || []);
        const r = pool.filter(function (x) { return x.id === s.timerId; })[0];
        if (r) {
            timerRule = r;
            timerEndAt = Number(s.timerEndAt || 0);
            showTimer = !!s.showTimer;
        }
    } else if (upperKind === "notify") {
        upperKind = "timer";
    }

    // 恢复上次的应用岛：重启时前台常是 AutoJs（无规则），
    // 不恢复就会直接落默认态，看起来像「重启后岛不显示了」
    if (s.current && s.current.kind === "fg" && s.current.id) {
        const prevRule = (cfg.rules || []).filter(function (x) { return x.id === s.current.id; })[0];
        if (prevRule && prevRule.pkg) { fgPkg = prevRule.pkg; fgRule = prevRule; }
    }
}

/* ================== 启动 ================== */
/* ---- 单实例锁：避免重复点击启动多个守护 ---- */
(function () {
    let self = null;
    try { self = engines.myEngine(); } catch (e) {}
    let others = 0;
    try {
        engines.all().forEach(function (e) {
            try {
                if (self && e.getId && String(e.getId()) === String(self.getId())) return;
                if (String(e.getSource() || "").indexOf("island_daemon.js") !== -1) others++;
            } catch (err) {}
        });
    } catch (e) {}
    if (others > 0) {
        log("已有 " + others + " 个守护实例在运行，本次启动忽略");
        toast("守护已在运行，本次启动已忽略");
        exit();
    }
})();

auto();
try { new java.io.File(kit.PATHS.dir).mkdirs(); } catch (e) {}
refreshCfg(true);
restore();
initIntervals();         // restore 之后再补一次，避免 interval 首启丢失基准
try { storages.create("island_state").put("build", BUILD); } catch (e) {}
log("守护目录: " + kit.PATHS.dir);
log("配置文件: " + kit.PATHS.cfg);
island.start();          // 按钮广播 + 脚本保活
startNotifyListener();   // 通知岛触发源
startCmdLoop();
startHeartbeat();

// 启动时先按当前前台渲染一次；前台没有规则就沿用 restore 恢复的岛
try {
    const cur = String(currentPackage() || "");
    if (cur && !isIgnored(cur)) {
        const hit = findRule(cur, "");
        if (hit) { fgPkg = cur; fgRule = hit; }
        else if (!fgRule) { fgPkg = cur; fgRule = null; }
    }
} catch (e) {}
render();
toast("灵动岛守护已启动 · " + BUILD);

events.on("exit", function () {
    try { if (pendingTimer) clearTimeout(pendingTimer); } catch (e) {}
    try { registered.forEach(function (it) { auto.removeEvent(it.name); }); } catch (e) {}
    try {
        if (!cfg || !cfg.lifecycle || cfg.lifecycle.hideOnDaemonExit !== false) hideIsland();
    } catch (e) {}
    try { island.stop(); } catch (e) {}
    log("守护已退出");
});
