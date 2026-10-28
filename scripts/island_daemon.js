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
const BUILD = "v64 / 2026-10-28 17:45";

/**
 * 代码按钮的预置 API。
 * 代码在独立脚本里执行，拿不到守护的内存状态，
 * 所以通过 storages 的 cmd 通道与守护通信。
 * 用户只需写 mute(10) / hide()。
 */
const CODE_API = [
    'var __s = storages.create("island_state");',
    'function mute(m){ __s.put("cmd", { action: "muteFor", min: Number(m) || 10, at: Date.now() }); }',
    'function hide(){ __s.put("cmd", { action: "hide", at: Date.now() }); }',
].join("\n");

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
let fgMuteUntil = 0;        // 应用层「临时屏蔽」到期时间
let timerMuteUntil = 0;     // 定时/通知层「临时屏蔽」到期时间
let lastRun = {};           // interval 类型上次执行时间
let fired = {};             // 去重：id@yyyy-MM-dd HH:mm
let lastSig = "";           // 上岛内容签名（避免重复广播）
let lastCurrent = {};       // 给配置页看的「当前岛」信息
let lastCmdAt = 0;
let pendingTimer = null;
let lastEventAt = 0;        // 最近一次收到无障碍事件的时间
let lastRenderAt = 0;       // 最近一次真正推送岛内容的时间
let lastForceAt = 0;        // 最近一次「定期重发」的时间
let appEchoAt = 0;          // 最近一次收到上岛 App 自身通知的时间（当作 ACK）
let lastSilentLogAt = 0;    // 「事件静默」日志的降频控制
let lastFixLog = "";        // 「控件树纠正」日志的去重签名
let lastTreeCheckAt = 0;    // 上次控件树查询时间（自适应降频用）
let lastTreePkg = null;     // 上次控件树结论；null=从未查过
let lastBeatAt = 0;         // 上次心跳时间（用于检测进程被冻结）
let lastStallLogAt = 0;     // 「调度停摆」诊断日志的降频控制
const APP_PKG = "com.example.liveupdateverify";   // 上岛中转 App
let lastReregisterAt = 0;   // 最近一次自愈重注册的时间（带冷却）
let noRuleTimer = null;     // 未命中规则的延迟判定
let keepSince = 0;          // 进入「保持不动」的时间
let islandHidden = false;   // 已撤岛标记（避免重复发 STOP）
let mutedPkg = "";          // 「下岛」屏蔽的应用：离开该应用前不再为它上岛

/**
 * 单实例锁（daemon.lock 存当前持有者的引擎 id）。
 *
 * 为什么不用 forceStop 就够：它是协作式中断，只在脚本执行到检查点时才生效。
 * daemon 全是 setInterval / events 回调，没有主循环，标志可能长时间没人检查，
 * 于是出现「日志说已强制终止，实际两个实例都在跑」。
 * 这里改成让旧实例自己读锁、自己 exit() —— 自杀一定生效。
 */
const LOCK_PATH = kit.PATHS.dir + "/daemon.lock";
let MY_ID = "";              // 本实例的引擎 id

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

    // 快速路径：根节点包名就是真实应用时，1 次 IPC 即可返回。
    // 只有「根节点是系统包 / 桌面 / 输入法」时，才需要遍历整棵树找真实应用
    // —— 那种情况下根节点和子节点的包名才会不一致。
    var rootPkg = "";
    try { rootPkg = String(root.packageName() || ""); } catch (e) { }
    if (rootPkg && !isSystemPkg(rootPkg)) return rootPkg;

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
        // 上岛 App 自己的界面：既不是规则应用，也不是「离开了应用」。
        // 按系统浮层处理 —— 保持当前岛不动，并记下时间，
        // 这样回到原应用时会强制重发一次。否则打开 App 检查会先撤岛，
        // 回来又可能被 pkg===fgPkg 去重短路，岛就空着不回来了。
        if (pkg === APP_PKG) {
            appEchoAt = Date.now();
            overlaySince = Date.now();
            return;
        }

        if (isIgnored(pkg)) {
            // 系统浮层（截屏 / 内容传送门 / 分享面板）出现时，岛会被浮层遮住。
            // 记下时间，等回到真正的应用时强制重发一次，否则会一直停在「被藏起来」的状态。
            overlaySince = Date.now();
            return;
        }

        lastPkgEventAt = Date.now();
        const backFromRecents = inRecents;
        const backFromOverlay = overlaySince && (Date.now() - overlaySince < 20000);
        overlaySince = 0;
        inRecents = false;

        // 从卡片页 / 系统浮层回来时，即使前台包名没变也要重发一次，
        // 否则岛一直停在「被系统藏起来」的状态。
        // 注意必须清掉内容签名，否则 push() 会因为「内容没变」而跳过发送。
        if (backFromOverlay || backFromRecents) lastSig = "";
        if (pkg === fgPkg && fgRule && !backFromRecents && !backFromOverlay) return;

        // 命中规则的应用立即上岛，不等 250ms 复核（复核可能被输入法抢走）
        refreshCfg();
        const hit = findRule(pkg, cls);
        if (hit) {
            fgPkg = pkg;
            fgRule = hit;
            if (mutedPkg) mutedPkg = "";
            render();
            return;
        }

        // 未命中：可能事件包名被系统顶替成了别的应用。
        // 控件树反查一次——它同时能回答「在哪个应用」和「是否在桌面」，
        // 这里取「在哪个应用」这个结果，避免误判成离开规则应用而撤岛。
        const real = detectRealPkg();
        if (real && real !== pkg) {
            const realRule = findRule(real, "");
            if (realRule) {
                log("事件包名不可信: " + pkg + " → 控件树 " + real);
                fgPkg = real;
                fgRule = realRule;
                if (mutedPkg) mutedPkg = "";
                render();
                return;
            }
        }

        schedule(pkg, cls);
    } catch (e) { log("事件异常: " + e); }
}

let deskTimer = null;
let lastPkgEventAt = 0;   // 最近一次「非桌面」的窗口事件时间
let lastEvtPkg = "";
let lastEvtCls = "";
let inRecents = false;    // 是否刚从后台卡片页过来（该页会把岛隐藏）
let overlaySince = 0;     // 系统浮层（截屏/分享面板等）出现的时刻

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
            if (mutedPkg) mutedPkg = "";
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
                if (mutedPkg) mutedPkg = "";
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
            if (mutedPkg) mutedPkg = "";
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
    if (mutedPkg) mutedPkg = "";  // 前台变了 → 解除抑制
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
/** 定时/通知层当前是否可用（未被临时屏蔽、且存在） */
function timerUsable() {
    return !!timerRule && Date.now() >= timerMuteUntil;
}

/** 应用层当前是否可用（未被临时屏蔽、未被下岛屏蔽、且存在） */
function fgUsable() {
    return !!fgRule && Date.now() >= fgMuteUntil && !(mutedPkg && fgPkg === mutedPkg);
}

function pickLayer() {
    const timerOk = timerUsable();
    const fgOk = fgUsable();

    if (timerOk && showTimer) return { kind: "timer", rule: timerRule };
    if (fgOk) return { kind: "fg", rule: fgRule };
    if (timerOk) return { kind: "timer", rule: timerRule };
    return null;
}

function render() {
    // 「下岛」屏蔽：只要前台还是被屏蔽的那个应用，就不再为它上岛；
    // 一旦前台变了（切换到别的应用或回桌面），立即解除。
    if (mutedPkg && fgPkg !== mutedPkg) mutedPkg = "";

    const layer = pickLayer();
    if (!layer) {
        // 屏蔽期内没有可显示的层时直接撤岛，
        // 不要退化成「未命中规则」的默认态（否则屏蔽会变成显示"就绪"）
        if (Date.now() < timerMuteUntil || Date.now() < fgMuteUntil) { hideIsland(); return; }
        noLayer();
        return;
    }

    // 「切回」按钮只在另一层真正可用时出现，
    // 否则会留着一个点了没反应的死按钮
    const other = layer.kind === "timer"
        ? (fgUsable() ? fgRule : null)
        : (timerUsable() ? timerRule : null);

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

    // 倒计时不再自动附加到正文，改为模板变量 {left}，
    // 由规则内容自己决定要不要显示、显示成什么样。

    return {
        title: fillTpl(c.title || (isNotify ? "{app}" : displayName(rule)), nctx),
        text: text,
        short: fillTpl(c.short || "", nctx),
        icon: c.icon || undefined,
        actions: buildButtons(rule, other),
    };
}

/**
 * 变量模板：{app} {title} {text} {time} {date} {hour} {min} {sec} {left}
 * 以及 island_vars 里的自定义变量，例如 {water}。
 * {left} = 当前上层定时岛的剩余分钟数（无定时岛时为 0）。
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
        left: String(leftMinutes()),
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

/* ================== 诊断日志 ==================
 * 只记录「关键决策点」：调度是否执行、补发为何放弃、触发为何被去重拦下。
 * 独立文件 diag.log，滚动保留，不影响主日志。
 * 定位「定时岛到点没上岛」这类问题时，看这个文件即可。
 */
const DIAG_PATH = kit.PATHS.dir + "/diag.log";
const DIAG_MAX = 700;          // 文件行数上限（约一周的日志量）
const DIAG_KEEP = 500;         // 滚动后保留的行数
const DIAG_TRIM_EVERY = 200;   // 每 200 条检查一次，避免每次写都读全文
let diagCount = 0;

function diag(msg) {
    try {
        const t = new Date();
        const line = "[" + pad2(t.getMonth() + 1) + "-" + pad2(t.getDate()) + " "
            + t.toTimeString().slice(0, 8) + "] " + msg;

        // 周期性滚动：读全文 → 保留最后 DIAG_KEEP 行 → 重写。
        // 旧实现只在进程启动后的第一条日志时判断一次，之后无限追加，
        // 结果几天后文件里全是历史噪音（还混着旧版本的记录）。
        if (++diagCount % DIAG_TRIM_EVERY === 1) {
            try {
                const arr = (files.read(DIAG_PATH) || "").split("\n")
                    .filter(function (x) { return x; });
                if (arr.length > DIAG_MAX) {
                    files.write(DIAG_PATH, arr.slice(arr.length - DIAG_KEEP).join("\n") + "\n");
                }
            } catch (e) {}
        }
        files.append(DIAG_PATH, line + "\n");
    } catch (e) {}
}

/**
 * 详细日志开关。
 * 默认关闭 —— 「跳过某点（已触发过）」「某点已过期 X 分钟」这类消息
 * 每次 tick / 每次补发检查都会产生，一天能刷几百条，把真正的异常淹没掉。
 * 排查「定时岛到点没上岛」时把它改成 true，日志会恢复完整细节。
 */
const DIAG_VERBOSE = false;
function dv(msg) { if (DIAG_VERBOSE) diag(msg); }

let lastTickAt = 0;         // 调度器上次执行时间（用于检测停摆）

function tick() {
    lastTickAt = Date.now();
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
        if (fired[key]) {
            dv("tick 跳过 " + (s.name || s.id) + "（" + hhmm(new Date(hit)) + " 已触发过）");
            return;
        }
        fired[key] = Date.now();
        cleanFired(now);
        diag("tick 触发 " + (s.name || s.id) + "（" + hhmm(new Date(hit)) + "）");
        fire(s);
    });

    // 倒计时刷新：{left} 会随时间变化，任何一层都要重绘
    if (timerRule && timerEndAt > 0) render();
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

    // 注意：Rhino 里 for 循环体内的 const/let 不会在每次迭代重新绑定，
    // 必须一律用 var，否则所有迭代都拿到第一次的值。
    for (var ci = 0; ci < cands.length; ci++) {
        var cItem = cands[ci];
        if (w.type === "weekly") {
            if (String(cItem.hhmm) !== String(w.at || "")) continue;
            if ((w.days || []).indexOf(cItem.day) === -1) continue;
            return cItem.ts;
        }
        if ((w.at || []).indexOf(cItem.hhmm) !== -1) return cItem.ts;
    }
    return null;
}

function cleanFired(now) {
    // key 的实际格式是 id@毫秒时间戳，不含日期字符串。
    // 旧实现用「key 里是否含 YYYY-MM-DD」判断，永远命中不了，
    // 结果每次都会把刚写入的 key 也删掉，去重完全失效。
    // 改为按时间戳清理，保留最近 6 小时。
    const cutoff = now.getTime() - 6 * 3600 * 1000;
    Object.keys(fired).forEach(function (k) {
        const at = Number(String(k).split("@")[1] || 0);
        if (at && at < cutoff) delete fired[k];
    });
}

/**
 * 定时触发。
 * endAt 可选：补发时传入「原始到期时间」，避免从补发时刻重新计时。
 */
function fire(s, endAt) {
    timerRule = s;
    upperKind = "timer";
    showTimer = true;
    // 新的触发点到来 → 解除这一层的屏蔽（不动应用层）
    timerMuteUntil = 0;
    timerEndAt = endAt || (Number(s.durationMin) > 0 ? Date.now() + Number(s.durationMin) * 60000 : 0);
    lastRun[s.id] = Date.now();
    render();
    if (s.autoRun) autoRun(s);
    log("定时上岛: " + (s.name || s.id));
}

/**
 * 补发错过的定时触发点。
 *
 * 定时任务是 30 秒轮询 + 「当前分钟/前一分钟」命中的机制，
 * 息屏期间进程被系统冻结时 tick 不会执行，一旦错过就永远不会补，
 * 表现为「12:00 设了规则，12:10 解锁却什么都没有」。
 *
 * 这里在亮屏时回头检查当天已过、但仍在 durationMin 窗口内的触发点，
 * 用原始到期时间补上，不重新计时。
 */
function catchUp() {
    // 定时层被临时屏蔽时不补发，避免绕过用户的屏蔽意图
    if (Date.now() < timerMuteUntil) {
        diag("补发放弃：定时层屏蔽中，还剩 "
            + Math.round((timerMuteUntil - Date.now()) / 1000) + " 秒");
        return 0;
    }

    const now = Date.now();
    const d = new Date(now);
    let hit = 0;
    const list = cfg.schedules || [];

    list.forEach(function (s) {
        const nm = s.name || s.id;
        if (s.enabled === false) { dv("  跳过 " + nm + "：已禁用"); return; }
        if (s.autoRun) { dv("  跳过 " + nm + "：开了「到点执行」，不补"); return; }

        const w = s.when || {};
        if (w.type === "interval" || w.type === "weekly") {
            dv("  跳过 " + nm + "：类型 " + w.type + " 不补");
            return;
        }

        const dur = Number(s.durationMin) || 0;
        if (dur <= 0) { dv("  跳过 " + nm + "：未设时长（一直显示），不补"); return; }

        const ats = w.at || [];
        let nearestExpired = -1;

        // Rhino 陷阱：for 循环体内的 const 不会逐次重新绑定，
        // 曾经导致所有时间点都算成第一个（08:00），补发永久失效。
        for (var ai = 0; ai < ats.length; ai++) {
            var avStr = String(ats[ai]);
            var avPart = avStr.split(":");
            var avHh = Number(avPart[0]);
            var avMm = Number(avPart[1]);
            if (isNaN(avHh) || isNaN(avMm)) continue;

            var avTs = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                                avHh, avMm, 0, 0).getTime();
            if (avTs > now) continue;                 // 还没到
            var avEndAt = avTs + dur * 60000;
            if (now >= avEndAt) {                     // 已过期
                var avGap = now - avEndAt;
                if (nearestExpired < 0 || avGap < nearestExpired) nearestExpired = avGap;
                continue;
            }

            var avKey = s.id + "@" + avTs;
            if (fired[avKey]) {
                dv("  跳过 " + nm + " @" + avStr + "：今天这个点已触发过");
                continue;
            }

            fired[avKey] = now;
            fire(s, avEndAt);
            hit++;
            log("补发定时岛: " + nm + "（原定 " + avStr + "）");
            diag("  补发 " + nm + " @" + avStr + "（窗口还剩 "
                + Math.round((avEndAt - now) / 1000) + " 秒）");
            break;
        }

        // 过期提示也归到详细日志：每次补发检查都会算一遍，正常情况天天有
        if (nearestExpired >= 10 * 60000) {
            dv("  " + nm + " 最近一个时间点已过期 "
                + Math.round(nearestExpired / 60000) + " 分钟");
        }
    });

    if (hit) {
        cleanFired(d);
        diag("补发定时岛 " + hit + " 条");
    }
    return hit;
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
    // 目标层被屏蔽时按钮本不该出现，这里兜底防止「点了没反应」
    if (showTimer && !fgUsable()) { toast("另一层当前不可用"); return; }
    if (!showTimer && !timerUsable()) { toast("另一层当前不可用"); return; }
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
            engines.execScript("island_action.js", CODE_API + "\n" + b.value);   // 注意：(name, script)
            // 命令轮询是 1 秒一轮，这里等它处理完再重绘，
            // 否则 mute()/hide() 会先被 400ms 的 render 抢在前面闪一下
            setTimeout(function () { refreshCfg(); render(); }, 1200);
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
        case "mute":
            muteFor(b.value);
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
    // 注意：这里不再因为屏蔽而提前返回。
    // 来了新的匹配通知就是要放行，并解除定时/通知层的屏蔽。
    const pkg = String(n.getPackageName() || "");

    // 上岛 App 自己重建通知，等于它收到并响应了 UPDATE 广播 —— 当作 ACK 用。
    // App 被系统杀死后，下一次广播会把它拉起，这里就能重新记到响应时间。
    if (pkg === APP_PKG) {
        appEchoAt = Date.now();
        try {
            var nt = String(n.getTitle() || "");
            // App 的通知变成「待命」= 它进入了静默态（进程被重启 / 收到 STOP / 打开了界面），
            // 岛上的内容已经没了。若 daemon 认为当前应该有岛，就立刻补推一次，
            // 否则岛会一直空着，只能等下次切换应用或手动点开 App。
            if (nt.indexOf("待命") !== -1 && !islandHidden && (fgRule || (timerRule && showTimer))) {
                lastSig = "";
                setTimeout(function () {
                    try { render(); } catch (e) { }
                }, 500);
                log("App 进入待命态，已补推岛内容");
            }
        } catch (e) { }
        return;
    }

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
    // 来了新的匹配通知 → 解除这一层的屏蔽
    timerMuteUntil = 0;
    timerEndAt = Number(rule.durationMin) > 0
        ? Date.now() + Number(rule.durationMin) * 60000
        : 0;

    render();
    log("通知上岛: " + pkg + " / " + title);
}

/* ================== 下岛 / 临时屏蔽 ================== */
/**
 * 下岛：撤掉，本次不再回来。
 * - 上层是定时岛 / 通知岛：只撤这一层，应用岛自动浮现
 * - 当前是应用岛：屏蔽到离开这个应用为止（切走或回桌面即解除）
 */
function dismissCurrent() {
    if (showTimer && timerRule) {
        timerRule = null;
        timerEndAt = 0;
        timerMuteUntil = 0;
        showTimer = false;
        render();
        toast("定时岛已下");
        return;
    }

    mutedPkg = fgPkg || "";
    fgMuteUntil = 0;
    hideIsland();
    toast(mutedPkg ? "已下岛，离开该应用后恢复" : "已下岛");
}

/**
 * 临时屏蔽：只作用于「当前正在看的那一层」，N 分钟后自动恢复。
 *
 * - 定时岛/通知岛在上层：屏蔽这一层；应用岛若存在会立刻浮现
 *   同时顺延 timerEndAt（等于暂停计时），恢复后继续走完剩余时长
 * - 当前是应用岛：屏蔽应用层，N 分钟后恢复
 *
 * 计时独立：屏蔽定时岛不会影响应用岛，反之亦然。
 */
function muteFor(min) {
    const m = Math.max(1, Number(min) || 10);
    const ms = m * 60000;

    if (showTimer && timerRule) {
        timerMuteUntil = Date.now() + ms;
        if (timerEndAt > 0) timerEndAt += ms;   // 暂停计时
        toast("定时岛已屏蔽 " + m + " 分钟");
    } else {
        fgMuteUntil = Date.now() + ms;
        toast("应用岛已屏蔽 " + m + " 分钟");
    }

    render();   // 立刻重算该显示哪一层
}

/* ================== 命令 / 心跳 / 兜底 ================== */
function startCmdLoop() {
    setInterval(function () {
        try {
            const c = storages.create("island_state").get("cmd", null);
            if (!c || !c.at || c.at <= lastCmdAt) return;
            lastCmdAt = c.at;
            refreshCfg();
            if (c.action === "hide") dismissCurrent();
            else if (c.action === "muteFor") muteFor(c.min);
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
                checkLockOwner();      // 锁被新实例接管 → 自己退出，避免双实例打架
                const tickAt = Date.now();

                // 检测「进程被系统冻结后解冻」：
                // 冻结期间 setInterval 完全停摆，醒来时这段间隔会异常大。
                // 此时内存里的 fgPkg 还是冻结前的旧值，必须立即重新同步，
                // 否则会出现「回桌面不撤岛 / 回了应用岛还停在旧应用」的僵持。
                if (lastBeatAt && tickAt - lastBeatAt > 90000) {
                    const slept = Math.round((tickAt - lastBeatAt) / 1000);
                    log("检测到进程被冻结 " + slept + " 秒，立即重新同步前台");
                    const real = detectRealPkg();
                    if (real !== null) {
                        if (real === "") {
                            fgPkg = "";
                            fgRule = null;
                        } else {
                            fgPkg = real;
                            fgRule = findRule(real, "");
                        }
                    }
                    lastSig = "";
                    catchUp();
                    render();
                }
                lastBeatAt = tickAt;

                // 调度停摆检测：tick 每 30 秒一次，超过 90 秒没执行说明被挂起过，
                // 那段时间内的定时触发点全部会丢，需要靠 catchUp 补。
                // 降频到每小时一条：休眠时每次唤醒都会命中，一天能刷出上百条
                if (lastTickAt && tickAt - lastTickAt > 90000
                    && tickAt - lastStallLogAt > 3600000) {
                    lastStallLogAt = tickAt;
                    var onScr = true;
                    try { onScr = device.isScreenOn(); } catch (e) {}
                    diag("调度停摆：" + Math.round((tickAt - lastTickAt) / 1000)
                        + " 秒内 tick 未执行" + (onScr ? "（亮屏，需关注）" : "（休眠中，正常）"));
                }

                refreshCfg();
                if (new java.io.File(kit.PATHS.dir).exists()) {
                    files.write(kit.PATHS.hb, String(Date.now()));
                }

                // 自愈：事件回调若被清空（AutoJs6 老问题），这里重新注册
                // 注意：静置不动时系统本来就不派发 WINDOW_STATE_CHANGED，
                // 所以「静默」是常态，日志降频到 10 分钟一条，避免刷屏。
                if (lastEventAt && Date.now() - lastEventAt > 90000) {
                    syncEvents();
                    lastEventAt = Date.now();
                    // 静置时本来就不派发事件，这条日志纯属噪音，降到每小时最多一条
                    if (Date.now() - lastSilentLogAt > 3600000) {
                        lastSilentLogAt = Date.now();
                        log("事件静默（静置属正常），已重新注册无障碍回调");
                    }
                }

                // 息屏 / 亮屏切换：息屏可撤岛，亮屏恢复
                const screenOn = device.isScreenOn();
                if (screenOn !== lastScreenOn) {
                    lastScreenOn = screenOn;
                    if (!screenOn) {
                        if (cfg.safety.hideWhenScreenOff !== false) hideIsland();
                    } else {
                        lastSig = "";      // 强制重发，绕过内容去重
                        catchUp();         // 息屏期间漏掉的定时触发点，在这里补上
                        render();
                    }
                }
                if (safety.onlyWhenScreenOn && !screenOn) return;

                // 定期重发：Live Update 久不更新会被系统判定不活跃并降级/回收，
                // 而应用岛在上岛后没有任何状态变化，永远不会自己重发。
                // 这里兜底刷一次，绕过内容去重（内容没变也要重发）。
                // 60 秒：App 侧状态丢失（进程重启后通知被重置成待命）时，
                // 最迟一分钟内能自己恢复，不用手动点开 App。
                const FORCE_MS = 60000;
                if (Date.now() - lastForceAt > FORCE_MS) {
                    lastForceAt = Date.now();
                    if (fgRule || (timerRule && showTimer)) {
                        lastSig = "";
                        render();
                        // App 超过 3 分钟没有任何通知事件 → 可能被系统清理过，值得记一笔
                        if (!appEchoAt || Date.now() - appEchoAt > 3 * 60000) {
                            const gapMin = appEchoAt ? Math.round((Date.now() - appEchoAt) / 60000) : -1;
                            log("定期重发岛（App 上次响应："
                                + (gapMin < 0 ? "从未收到" : gapMin + " 分钟前") + "）");
                        }
                    }
                }

                let cur = "";
                try { cur = String(currentPackage() || ""); } catch (e) {}

                // 事件静默超过 60 秒后 currentPackage() 不可信：
                // 系统降级后它会停在旧应用上（实测会卡在 org.autojs.autojs6），
                // 导致 fgRule 变 null、岛被撤且再也回不来。
                // 用控件树反查纠正 —— 和 confirmDesktop / 输入法反查是同一套逻辑。
                const silentNow = !lastEventAt || (Date.now() - lastEventAt > 60000);
                if (silentNow) {
                    // 扫描频率自适应：
                    //   有岛时 5 秒一次（要及时纠正误报，否则会闪/撤）
                    //   无岛时 30 秒一次（只需发现「静默切进了规则应用」，不必急）
                    const hasIsland = !!(fgRule || (timerRule && showTimer));
                    const treeGap = hasIsland ? 5000 : 30000;
                    if (Date.now() - lastTreeCheckAt < treeGap) {
                        // 本次跳过扫描，直接沿用上次结论
                        if (lastTreePkg !== null) cur = lastTreePkg;
                    } else {
                        lastTreeCheckAt = Date.now();
                        const treePkg = detectRealPkg();
                        if (treePkg === "") {
                            lastTreePkg = "";
                            // 控件树里只剩系统包 / 桌面 / 输入法 → 确实在桌面
                            if (fgPkg || fgRule) {
                                log("控件树判定在桌面，撤岛（当前记录: " + (fgPkg || "空") + "）");
                                fgPkg = "";
                                fgRule = null;
                                render();
                            }
                            return;
                        }
                        if (treePkg) {
                            lastTreePkg = treePkg;
                            if (treePkg !== cur) {
                                // 同一对「误报包名 → 真实包名」只记一次，
                                // 否则输入法长期占着 currentPackage() 时会每 5 秒刷一条
                                const fixSig = (cur || "空") + "→" + treePkg;
                                if (fixSig !== lastFixLog) {
                                    lastFixLog = fixSig;
                                    log("控件树纠正前台: " + fixSig);
                                }
                            } else {
                                lastFixLog = "";
                            }
                            cur = treePkg;
                        }
                    }
                }

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

                if (Date.now() < fgMuteUntil) return;

                // 事件仍在活跃时不做覆盖：currentPackage 可能停留在旧应用（全屏应用尤其明显）
                if (fgPkg && fgRule && !silentNow) return;
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
        fgMuteUntil: fgMuteUntil,
        timerMuteUntil: timerMuteUntil,
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
    fgMuteUntil = Number(s.fgMuteUntil || 0);
    timerMuteUntil = Number(s.timerMuteUntil || 0);
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
/* ---- 单实例锁：启动时抢锁；旧实例靠心跳自查自杀（forceStop 不可靠） ---- */
(function () {
    let self = null;
    try { self = engines.myEngine(); } catch (e) {}
    MY_ID = self ? String(self.getId()) : "";

    let owner = "";
    try { owner = String(files.read(LOCK_PATH) || "").trim(); } catch (e) {}

    let others = [];
    try {
        engines.all().forEach(function (e) {
            try {
                if (self && e.getId && String(e.getId()) === String(self.getId())) return;
                if (String(e.getSource() || "").indexOf("island_daemon.js") !== -1) others.push(e);
            } catch (err) {}
        });
    } catch (e) {}

    // 别的实例持锁、且心跳新鲜 → 它是健康的，本次启动直接放弃
    let lastHb = 0;
    try { lastHb = parseInt(files.read(kit.PATHS.hb), 10) || 0; } catch (e) {}
    const hbFresh = !!lastHb && Date.now() - lastHb < 90000;
    if (others.length > 0 && owner && owner !== MY_ID && hbFresh) {
        log("守护已在运行（实例 " + owner + "），本次启动忽略");
        toast("守护已在运行，本次启动已忽略");
        exit();
    }

    // 抢锁：写下自己的 id。旧实例下一次心跳会发现锁已易主，自己 exit()。
    try { files.write(LOCK_PATH, MY_ID); } catch (e) {}
    if (others.length > 0) {
        others.forEach(function (e) { try { e.forceStop(); } catch (err) {} });
        log("接管单实例锁（" + MY_ID + "），已请求终止 " + others.length +
            " 个旧实例，它们会在下次心跳时自行退出");
    }
})();

/**
 * 心跳里自查锁归属。
 * 被抢了锁就自己退出 —— 不依赖 forceStop 能不能打断。
 */
function checkLockOwner() {
    if (!MY_ID) return;
    let owner = "";
    try { owner = String(files.read(LOCK_PATH) || "").trim(); } catch (e) { return; }
    if (owner && owner !== MY_ID) {
        log("单实例锁已被实例 " + owner + " 接管，本实例退出（我是 " + MY_ID + "）");
        // 退出前关掉「退出时撤岛」：新实例正在渲染，这里再撤一次会闪
        try { if (cfg && cfg.lifecycle) cfg.lifecycle.hideOnDaemonExit = false; } catch (e) {}
        exit();
    }
}

auto();
try { new java.io.File(kit.PATHS.dir).mkdirs(); } catch (e) {}
// 立即打一次心跳：让 watchdog 与本实例的锁判断都能马上看到"我还活着"
try { files.write(kit.PATHS.hb, String(Date.now())); } catch (e) {}
refreshCfg(true);
restore();
initIntervals();         // restore 之后再补一次，避免 interval 首启丢失基准
try { storages.create("island_state").put("build", BUILD); } catch (e) {}
diag("=== 守护启动 " + BUILD + " ===");
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
