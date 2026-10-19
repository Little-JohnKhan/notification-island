"ui";
/**
 * island_config.js —— 灵动岛规则配置页（ui 模式）
 * ------------------------------------------------------------------
 * 依赖：./island_kit.js（同目录）
 *       /storage/emulated/0/脚本/常用模块/UI模块.js
 * 输出：同目录 island_rules.json
 *
 * 说明：
 *   - ui 线程不能调阻塞式 dialogs，全部改为自绘面板（pickList / askText / pickMulti）
 *   - 面板用栈管理，子面板关闭后回到上一层
 * ------------------------------------------------------------------
 */
const kit = require("./island_kit.js");
const U = kit.U;
const UI = kit.UI;

/** 构建标记：设置页底部可见，用来确认当前跑的是哪一版 */
const BUILD = "v40 / 2026-10-19 23:12";

const LL = kit.LL, FL = kit.FL, TV = kit.TV, ET = kit.ET, SV = kit.SV;
const MATCH = kit.MATCH, WRAP = kit.WRAP, G = kit.G, V = kit.V;

let cfg = kit.readCfg();
let tab = "fg";
let darkCache = UI.isNight();

const EVENT_LIST = [
    { name: "WINDOW_STATE_CHANGED", label: "窗口状态变化", hint: "前台应用切换（推荐）" },
    { name: "WINDOW_CONTENT_CHANGED", label: "窗口内容变化", hint: "频繁，仅作内容刷新" },
    { name: "VIEW_CLICKED", label: "控件被点击", hint: "未验证是否可达" },
    { name: "NOTIFICATION_STATE_CHANGED", label: "通知状态变化", hint: "未验证是否可达" },
];

const ACT_TYPES = ["none", "task", "script", "code", "app", "page", "hide", "last"];
const ACT_LABELS = ["未配置", "运行任务（main）", "运行脚本", "执行代码", "打开应用", "打开规则页", "下岛", "切回另一层"];

/** 按钮图标：App 端内置 ic_action_dog / bear / rabbit / cat，兜底 ic_action_done */
const ICON_PRESETS = ["（默认）", "dog", "bear", "rabbit", "cat", "手动输入…"];

/* ================== 基础 ================== */
function T() { return kit.T(); }
function C(h) { return kit.C(h); }
function dp(v) { return kit.dp(v); }
function tv(t, s, c, b) { return kit.tv(t, s, c, b); }
function vbox(p) { return kit.vbox(p); }
function hbox() { return kit.hbox(); }
function line() { return kit.line(); }
function space(w, h) { return kit.space(w, h); }
function spacer() { return kit.spacer(); }

function applyBars() {
    kit.applySystemBars({ window: activity.getWindow(), mainCol: mainCol });
}

/* ================== 面板（来自 UI扩展：栈式 + 防点击穿透 + 返回键） ================== */
let panel = null;

function openPanel(builder) { panel.open(builder); }
function closePanel() { panel.close(); }
function panelHeader(parent, title, onBack) { return U.panelHeader(parent, title, onBack); }

/** 单选列表（替代 dialogs.select） */
function pickList(title, items, cur, onPick) {
    openPanel(function (col) {
        panelHeader(col, title, closePanel);
        const sv = new SV(context);
        const list = vbox(0);
        list.setPadding(dp(16), dp(10), dp(16), dp(16));
        items.forEach(function (t, i) {
            const r = hbox();
            r.setPadding(dp(14), dp(14), dp(14), dp(14));
            r.setBackground(UI.roundBg(T().card, 12));
            r.addView(tv(t, 15, T().name, i === cur));
            r.addView(spacer());
            if (i === cur) r.addView(tv("✓", 15, T().accent, true));
            r.setOnClickListener(function () {
                closePanel();
                onPick(i);
            });
            const lp = new LL.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = dp(6);
            list.addView(r, lp);
        });
        sv.addView(list, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));
    });
}

/** 多选列表（替代 dialogs.multiChoice） */
function pickMulti(title, items, selectedIdx, onOk) {
    const sel = {};
    (selectedIdx || []).forEach(function (i) { sel[i] = true; });

    openPanel(function (col) {
        panelHeader(col, title, closePanel);
        const sv = new SV(context);
        const list = vbox(0);
        list.setPadding(dp(16), dp(10), dp(16), dp(16));

        items.forEach(function (t, i) {
            const r = hbox();
            r.setPadding(dp(14), dp(14), dp(14), dp(14));
            r.setBackground(UI.roundBg(T().card, 12));

            const mark = tv(sel[i] ? "✓" : "", 13, "#FFFFFF", true);
            mark.setGravity(G.CENTER);
            mark.setLayoutParams(new LL.LayoutParams(dp(22), dp(22)));
            const paint = function () {
                mark.setText(sel[i] ? "✓" : "");
                mark.setBackground(sel[i] ? UI.ovalBg(T().accent, null, 0) : UI.ovalBg(null, T().sub, 2));
            };
            paint();

            r.addView(mark);
            r.addView(space(10, 0));
            r.addView(tv(t, 15, T().name));
            r.setOnClickListener(function () { sel[i] = !sel[i]; paint(); });

            const lp = new LL.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = dp(6);
            list.addView(r, lp);
        });

        sv.addView(list, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));

        const bar = hbox();
        bar.setPadding(dp(16), dp(8), dp(16), dp(14));
        bar.addView(spacer());
        bar.addView(kit.btn("完成", true, function () {
            const out = [];
            Object.keys(sel).forEach(function (k) { if (sel[k]) out.push(Number(k)); });
            closePanel();
            onOk(out);
        }));
        col.addView(bar);
    });
}

/** 文本输入（替代 dialogs.rawInput） */
function askText(title, prefill, onOk, numeric) {
    openPanel(function (col) {
        panelHeader(col, title, closePanel);
        const body = vbox(0);
        body.setPadding(dp(16), dp(14), dp(16), dp(16));

        const e = kit.et("", prefill == null ? "" : String(prefill), true);
        if (numeric) e.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        body.addView(e, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 14));

        const bar = hbox();
        bar.addView(spacer());
        bar.addView(kit.btn("取消", false, closePanel));
        bar.addView(space(8, 0));
        bar.addView(kit.btn("确定", true, function () {
            const s = String(e.getText().toString() || "").trim();
            closePanel();
            onOk(s);
        }));
        body.addView(bar);
        col.addView(body);

        setTimeout(function () {
            try {
                e.requestFocus();
                const imm = context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
                imm.showSoftInput(e, 0);
            } catch (err) {}
        }, 250);
    });
}

function sectionLabel(parent, text) {
    const t = tv(text, 12, T().sub);
    t.setPadding(dp(4), dp(14), dp(4), dp(6));
    parent.addView(t);
    return t;
}

function settingRow(parent, label, value, onTap) {
    const r = hbox();
    r.setPadding(dp(14), dp(13), dp(14), dp(13));
    r.setBackground(UI.roundBg(T().card, 12));
    r.addView(tv(label, 15, T().name));
    r.addView(spacer());
    r.addView(tv(value || "", 14, T().sub));
    r.addView(tv(" ›", 14, T().sub));
    if (onTap) r.setOnClickListener(function () { onTap(); });
    const lp = new LL.LayoutParams(MATCH, WRAP);
    lp.bottomMargin = dp(6);
    parent.addView(r, lp);
    return r;
}

/** 图标选择行：值直接写回调用方对象 */
function iconRow(cur, setter, label) {
    const r = hbox();
    r.setBackground(UI.roundBg(T().card2, 12));
    r.setPadding(dp(12), dp(11), dp(12), dp(11));
    r.addView(tv(label || "图标", 13, T().name), new LL.LayoutParams(0, WRAP, 1));

    const val = tv(cur || "默认", 13, cur ? T().accent : T().sub);
    r.addView(val);
    r.addView(tv(" ›", 14, T().sub));

    function refresh(v) {
        val.setText(v || "默认");
        val.setTextColor(C(v ? T().accent : T().sub));
    }

    r.setOnClickListener(function () {
        let idx = cur && ICON_PRESETS.indexOf(cur) >= 0 ? ICON_PRESETS.indexOf(cur) : 0;
        pickList("选择图标（名称需上岛 App 内置）", ICON_PRESETS, idx, function (i) {
            if (i === 0) {
                cur = ""; setter(""); refresh("");
                return;
            }
            if (i === ICON_PRESETS.length - 1) {
                askText("图标名（上岛 App 内置的资源名）", cur || "", function (s) {
                    cur = String(s || "").trim();
                    setter(cur);
                    refresh(cur);
                });
                return;
            }
            cur = ICON_PRESETS[i];
            setter(cur);
            refresh(cur);
        });
    });
    return r;
}

/* ================== 根界面 ================== */
const root = new FL(context);
root.setBackgroundColor(C(kit.pageBg()));
const mainCol = vbox(0);
ui.setContentView(root);
root.addView(mainCol, new FL.LayoutParams(MATCH, MATCH));

// 面板容器：栈式管理 + 每层自动吃掉空白点击（防穿透）
panel = U.createPanel(root);
U.bindBack(panel);

function rebuild() {
    mainCol.removeAllViews();
    mainCol.setBackgroundColor(C(kit.pageBg()));
    buildHeader();
    buildTabs();
    buildList();
    buildBottom();
    applyBars();
}

function buildHeader() {
    const h = hbox();
    h.setPadding(0, dp(2), 0, dp(2));
    h.addView(tv("灵动岛规则", 21, T().title, true));
    h.addView(spacer());

    const btnEvent = kit.pill("事件", T().card2, T().name, 12);
    btnEvent.setOnClickListener(function () { eventsPanel(); });
    const btnSet = kit.pill("设置", T().card2, T().name, 12);
    btnSet.setOnClickListener(function () { settingsPanel(); });
    const btnAdd = kit.pill("＋", T().card2, T().name, 14);
    btnAdd.setOnClickListener(function () {
        if (tab === "fg") appPicker();
        else if (tab === "timer") scheduleEditor(null);
        else notifyEditor(null);
    });

    [btnEvent, btnSet, btnAdd].forEach(function (b) {
        const lp = new LL.LayoutParams(WRAP, WRAP);
        lp.leftMargin = dp(8);
        b.setLayoutParams(lp);
        h.addView(b);
    });
    mainCol.addView(h);

    const st = hbox();
    st.setPadding(0, dp(2), 0, dp(4));
    const alive = kit.daemonAlive();
    let dbuild = "";
    try { dbuild = String(storages.create("island_state").get("build", "") || ""); } catch (e) {}
    st.addView(tv("●", 9, alive ? T().accent : T().sub));
    st.addView(space(4, 0));
    st.addView(tv((alive ? "守护 · 运行中" : "守护 · 未运行") + (alive && dbuild ? " · " + dbuild : ""),
        11, T().sub));
    mainCol.addView(st);
}

function buildTabs() {
    const row = hbox();
    row.setPadding(0, dp(2), 0, dp(8));
    [{ k: "fg", label: "前台" }, { k: "timer", label: "定时" }, { k: "notify", label: "通知" }].forEach(function (o) {
        const sel = o.k === tab;
        const chip = kit.pill(o.label,
            sel ? T().accent : T().card2,
            sel ? (T().dark ? "#04231A" : "#FFFFFF") : T().sub, 13);
        const lp = new LL.LayoutParams(WRAP, WRAP);
        lp.rightMargin = dp(8);
        chip.setLayoutParams(lp);
        chip.setOnClickListener(function () {
            if (tab === o.k) return;
            tab = o.k;
            rebuild();
        });
        row.addView(chip);
    });
    mainCol.addView(row);
}

function buildList() {
    const sv = new SV(context);
    sv.setClipToPadding(false);
    const col = vbox(0);
    col.setPadding(0, 0, 0, dp(8));

    const list = tab === "fg" ? (cfg.rules || [])
        : (tab === "timer" ? (cfg.schedules || []) : (cfg.notifies || []));
    if (!list.length) {
        const EMPTY = {
            fg: "还没有应用规则\n点右上角 ＋ 选择应用",
            timer: "还没有定时规则\n点右上角 ＋ 新建",
            notify: "还没有通知规则\n点右上角 ＋ 新建（需通知使用权）",
        };
        const empty = tv(EMPTY[tab] || "", 13, T().sub);
        empty.setPadding(dp(6), dp(50), dp(6), dp(50));
        empty.setGravity(G.CENTER);
        col.addView(empty);
    }
    list.forEach(function (item) {
        col.addView(makeCard(item, tab));
        col.addView(space(0, 8));
    });

    sv.addView(col, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
    mainCol.addView(sv, new LL.LayoutParams(MATCH, 0, 1));
}

function makeCard(item, kind) {
    const c = kit.card(T().card, 14, 13);
    const head = hbox();

    let name, desc;
    if (kind === "fg") {
        name = item.appName || item.pkg;
        desc = item.pkg;
    } else if (kind === "notify") {
        name = item.name || item.appName || item.pkg;
        desc = (item.appName ? item.appName + " · " : "")
            + (item.keyword ? ("含「" + item.keyword + "」") : "全部通知")
            + " · " + (Number(item.durationMin) > 0 ? (item.durationMin + " 分钟") : "一直显示");
    } else {
        name = item.name || "定时规则";
        desc = whenText(item);
    }

    head.addView(tv(name, 16, T().title, true));
    head.addView(spacer());
    const bc = ((item.island && item.island.buttons) || []).filter(function (b) {
        return b && b.type !== "none" && (b.label || b.value);
    }).length;
    if (bc > 0) head.addView(kit.pill("按钮 " + bc, T().card2, T().name, 11));
    c.addView(head);
    c.addView(space(0, 4));
    c.addView(tv(desc, 11, T().sub));
    c.setOnClickListener(function () {
        if (kind === "fg") ruleEditor(item);
        else if (kind === "notify") notifyEditor(item);
        else scheduleEditor(item);
    });
    return c;
}

function whenText(s) {
    const w = s.when || {};
    const dur = Number(s.durationMin) > 0 ? (s.durationMin + " 分钟") : "一直显示";
    if (w.type === "interval") return "每 " + (w.everyMin || 0) + " 分钟 · " + dur;
    if (w.type === "weekly") {
        const names = ["一", "二", "三", "四", "五", "六", "日"];
        const ds = (w.days || []).map(function (d) { return names[(d - 1) % 7]; }).join("");
        return "每周" + ds + " " + (w.at || "") + " · " + dur;
    }
    return "每天 " + (w.at || []).join(" / ") + " · " + dur;
}

function buildBottom() {
    mainCol.addView(line());
    const b = hbox();
    b.setPadding(0, dp(8), 0, dp(2));

    const st = kit.readState() || {};
    const cur = st.current || {};
    b.addView(tv("●", 9, cur.kind && cur.kind !== "none" ? T().accent : T().sub));
    b.addView(space(5, 0));
    b.addView(tv("当前岛 · " + (cur.name || "无"), 11, T().sub));
    b.addView(spacer());

    const off = kit.pill("下岛", T().card2, T().danger, 12);
    off.setOnClickListener(function () {
        kit.hideIslandNow();      // 直接发 STOP 广播，守护没在跑也能下岛
        kit.sendCmd("hide");      // 守护在跑时，顺便清栈 + 抑制
        toast("已下岛");
        setTimeout(rebuild, 600);
    });
    b.addView(off);
    mainCol.addView(b);
}

/* ================== 应用选择器 ================== */
/** 单选应用（搜索 + 首字母圆 + 包名），点一行即返回 */
function pickAppPanel(onPick) {
    const apps = kit.listLauncherApps(false);

    openPanel(function (col) {
        panelHeader(col, "选择应用", null);

        const search = kit.et("搜索应用", "", true);
        const sw = vbox(0);
        sw.setPadding(dp(16), dp(8), dp(16), dp(8));
        sw.addView(search, new LL.LayoutParams(MATCH, WRAP));
        col.addView(sw);

        const sv = new SV(context);
        const listCol = vbox(0);
        listCol.setPadding(dp(16), 0, dp(16), dp(12));
        sv.addView(listCol, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));

        function renderList() {
            const kw = String(search.getText().toString() || "").trim().toLowerCase();
            listCol.removeAllViews();
            let shown = 0;

            apps.forEach(function (a) {
                if (kw && a.name.toLowerCase().indexOf(kw) === -1
                    && a.pkg.toLowerCase().indexOf(kw) === -1) return;
                if (shown >= 80) return;
                shown++;

                const r = hbox();
                r.setPadding(dp(12), dp(11), dp(12), dp(11));
                r.setBackground(UI.roundBg(T().card, 12));

                const circle = tv(a.name.substring(0, 1), 14, T().name, true);
                circle.setGravity(G.CENTER);
                circle.setBackground(UI.ovalBg(T().card2, null, 0));
                circle.setLayoutParams(new LL.LayoutParams(dp(32), dp(32)));
                r.addView(circle);
                r.addView(space(10, 0));

                const mid = vbox(0);
                mid.addView(tv(a.name, 15, T().name, true));
                mid.addView(tv(a.pkg, 9, T().sub));
                r.addView(mid, new LL.LayoutParams(0, WRAP, 1));
                r.addView(tv("›", 15, T().sub));

                r.setOnClickListener(function () {
                    closePanel();
                    onPick(a);
                });

                const lp = new LL.LayoutParams(MATCH, WRAP);
                lp.bottomMargin = dp(6);
                listCol.addView(r, lp);
            });

            if (!shown) {
                const e = tv("没有匹配的应用", 13, T().sub);
                e.setGravity(G.CENTER);
                e.setPadding(0, dp(30), 0, 0);
                listCol.addView(e);
            }
        }

        search.addTextChangedListener(new JavaAdapter(android.text.TextWatcher, {
            afterTextChanged: function () { renderList(); },
            beforeTextChanged: function () {},
            onTextChanged: function () {},
        }));

        renderList();
    });
}

function appPicker() {
    const apps = kit.listLauncherApps(false);
    const selected = {};

    openPanel(function (col) {
        panelHeader(col, "选择应用", null);

        const search = kit.et("搜索应用", "", true);
        const sw = vbox(0);
        sw.setPadding(dp(16), dp(8), dp(16), dp(8));
        sw.addView(search, new LL.LayoutParams(MATCH, WRAP));
        col.addView(sw);

        const sv = new SV(context);
        const listCol = vbox(0);
        listCol.setPadding(dp(16), 0, dp(16), dp(12));
        sv.addView(listCol, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));

        let doneBtn = null;

        function countSel() {
            let n = 0;
            for (let k in selected) if (selected[k]) n++;
            return n;
        }

        function renderList() {
            const kw = String(search.getText().toString() || "").trim().toLowerCase();
            listCol.removeAllViews();
            let shown = 0;
            apps.forEach(function (a) {
                if (kw && a.name.toLowerCase().indexOf(kw) === -1
                    && a.pkg.toLowerCase().indexOf(kw) === -1) return;
                if (shown >= 80) return;
                shown++;

                const r = hbox();
                r.setPadding(dp(12), dp(11), dp(12), dp(11));
                r.setBackground(UI.roundBg(T().card, 12));

                const circle = tv(a.name.substring(0, 1), 14, T().name, true);
                circle.setGravity(G.CENTER);
                circle.setBackground(UI.ovalBg(T().card2, null, 0));
                circle.setLayoutParams(new LL.LayoutParams(dp(32), dp(32)));
                r.addView(circle);
                r.addView(space(10, 0));

                const mid = vbox(0);
                mid.addView(tv(a.name, 15, T().name, true));
                mid.addView(tv(a.pkg, 9, T().sub));
                r.addView(mid, new LL.LayoutParams(0, WRAP, 1));

                const on = !!selected[a.pkg];
                const mark = tv(on ? "✓" : "", 13, "#FFFFFF", true);
                mark.setGravity(G.CENTER);
                mark.setBackground(on ? UI.ovalBg(T().accent, null, 0) : UI.ovalBg(null, T().sub, 2));
                mark.setLayoutParams(new LL.LayoutParams(dp(22), dp(22)));
                r.addView(mark);

                r.setOnClickListener(function () {
                    selected[a.pkg] = !selected[a.pkg];
                    renderList();
                });

                const lp = new LL.LayoutParams(MATCH, WRAP);
                lp.bottomMargin = dp(6);
                listCol.addView(r, lp);
            });
            if (!shown) {
                const e = tv("没有匹配的应用", 13, T().sub);
                e.setGravity(G.CENTER);
                e.setPadding(0, dp(30), 0, 0);
                listCol.addView(e);
            }
            if (doneBtn) doneBtn.setText("完成 (" + countSel() + ")");
        }

        search.addTextChangedListener(new JavaAdapter(android.text.TextWatcher, {
            afterTextChanged: function () { renderList(); },
            beforeTextChanged: function () {},
            onTextChanged: function () {},
        }));

        const bar = hbox();
        bar.setPadding(dp(16), dp(8), dp(16), dp(12));
        bar.addView(tv("勾选后完成，每个应用建一条规则", 10, T().sub));
        bar.addView(spacer());
        doneBtn = kit.btn("完成 (0)", true, function () {
            const n = countSel();
            if (!n) { closePanel(); return; }
            const now = Date.now();
            let i = 0;
            Object.keys(selected).forEach(function (pkg) {
                if (!selected[pkg]) return;
                const app = apps.filter(function (x) { return x.pkg === pkg; })[0] || { name: pkg };
                cfg.rules.push({
                    id: "r" + (now + i++).toString(36),
                    pkg: pkg,
                    appName: app.name,
                    enabled: true,
                    matchClass: "",
                    island: {
                        title: app.name,
                        content: "已进入 " + app.name,
                        short: app.name.substring(0, 4),
                        icon: "",
                        buttons: [],
                    },
                });
            });
            saveAll();
            closePanel();
            rebuild();
            toast("已添加 " + n + " 条规则");
        });
        bar.addView(doneBtn);
        col.addView(bar);

        renderList();
    });
}

/* ================== 文件选择 ================== */
function filePicker(onPick) {
    let dir = "/storage/emulated/0/脚本";

    openPanel(function (col) {
        panelHeader(col, "选择脚本", null);
        const pathTv = tv("", 10, T().sub);
        pathTv.setPadding(dp(18), dp(6), dp(18), dp(6));
        col.addView(pathTv);

        const sv = new SV(context);
        const listCol = vbox(0);
        listCol.setPadding(dp(16), 0, dp(16), dp(20));
        sv.addView(listCol, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));

        function rowItem(name, isDir, onTap) {
            const r = hbox();
            r.setPadding(dp(12), dp(11), dp(12), dp(11));
            r.setBackground(UI.roundBg(T().card, 12));
            r.addView(tv(isDir ? ("▸ " + name) : name, 14, T().name, isDir));
            r.setOnClickListener(function () { onTap(); });
            const lp = new LL.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = dp(6);
            listCol.addView(r, lp);
        }

        function renderList() {
            pathTv.setText(dir);
            listCol.removeAllViews();
            rowItem("..", true, function () {
                const i = dir.lastIndexOf("/");
                if (i > 8) { dir = dir.substring(0, i); renderList(); }
            });
            let names = [];
            try { names = files.listDir(dir); } catch (e) { names = []; }
            const dirs = [], fs = [];
            names.forEach(function (n) {
                const p = dir + "/" + n;
                try {
                    if (files.isDir(p)) dirs.push(n);
                    else if (/\.js$/i.test(n)) fs.push(n);
                } catch (e) {}
            });
            dirs.sort().forEach(function (n) {
                rowItem(n, true, function () { dir = dir + "/" + n; renderList(); });
            });
            fs.sort().forEach(function (n) {
                rowItem(n, false, function () {
                    const p = dir + "/" + n;
                    closePanel();
                    onPick(p);
                });
            });
            if (!dirs.length && !fs.length) {
                const e = tv("（此目录没有 .js 文件）", 12, T().sub);
                e.setPadding(dp(12), dp(20), 0, 0);
                listCol.addView(e);
            }
        }
        renderList();
    });
}

/* ================== 动作行 ================== */
function actionText(act) {
    if (!act || !act.type || act.type === "none") return "未配置动作";
    if (act.type === "task") return "任务 · " + (act.name || act.value || "");
    if (act.type === "script") return "脚本 · " + String(act.value || "").split("/").pop();
    if (act.type === "code") return "代码片段";
    if (act.type === "app") return "应用 · " + (act.name || act.value || "");
    if (act.type === "page") return "打开规则页";
    if (act.type === "hide") return "下岛";
    if (act.type === "last") return "切回另一层";
    return "未配置动作";
}

function actionRow(act, onChange) {
    const r = hbox();
    r.setBackground(UI.roundBg(T().card2, 12));
    r.setPadding(dp(12), dp(12), dp(12), dp(12));
    const label = tv(actionText(act), 14, T().name);
    r.addView(label, new LL.LayoutParams(0, WRAP, 1));
    r.addView(tv("›", 15, T().sub));

    r.setOnClickListener(function () {
        let cur = ACT_TYPES.indexOf(act.type);
        if (cur < 0) cur = 0;

        pickList("动作类型", ACT_LABELS, cur, function (i) {
            const t = ACT_TYPES[i];

            if (t === "none") {
                act.type = "none"; act.value = ""; act.name = "";
                label.setText("未配置动作"); onChange(act); return;
            }
            if (t === "page" || t === "hide" || t === "last") {
                act.type = t; act.value = ""; act.name = "";
                label.setText(actionText(act));
                onChange(act);
                return;
            }
            if (t === "app") {
                const apps = kit.listLauncherApps(true);
                pickList("选择应用", apps.map(function (a) { return a.name; }), 0, function (k) {
                    act.type = "app"; act.value = apps[k].pkg; act.name = apps[k].name;
                    label.setText("应用 · " + apps[k].name);
                    onChange(act);
                });
                return;
            }
            if (t === "code") {
                askText("代码片段", act.value || "", function (s) {
                    act.type = "code"; act.value = s; act.name = "代码";
                    label.setText("代码片段");
                    onChange(act);
                });
                return;
            }
            filePicker(function (p) {
                act.type = t;
                act.value = p;
                const base = p.substring(p.lastIndexOf("/") + 1).replace(/\.js$/i, "");
                act.name = base;
                label.setText((t === "task" ? "任务 · " : "脚本 · ") + base);
                onChange(act);
            });
        });
    });
    return r;
}

/* ================== 规则编辑（前台） ================== */
function ruleEditor(rule) {
    const isNew = !rule;
    const r = rule ? JSON.parse(JSON.stringify(rule)) : {
        id: "r" + Date.now().toString(36),
        pkg: "com.unknown", appName: "新规则", enabled: true, matchClass: "",
        island: { title: "", content: "", short: "", icon: "", buttons: [] },
    };
    if (!r.island) r.island = {};
    if (!r.island.buttons) r.island.buttons = [];
    while (r.island.buttons.length < 3) r.island.buttons.push({ label: "", type: "none", name: "", value: "" });

    openPanel(function (col) {
        panelHeader(col, r.appName || "规则", null);

        const sv = new SV(context);
        const body = vbox(0);
        body.setPadding(dp(16), dp(10), dp(16), dp(16));

        const eTitle = kit.et("例如 微信", r.island.title || "");
        const eContent = kit.et("例如 点击运行微信脚本", r.island.content || "");
        const eShort = kit.et("最多 4 个字", r.island.short || "");

        body.addView(tv("岛标题", 12, T().sub));
        body.addView(space(0, 5));
        body.addView(eTitle, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 10));

        body.addView(tv("岛内容", 12, T().sub));
        body.addView(space(0, 5));
        body.addView(eContent, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 10));

        const h2 = hbox();
        h2.addView(tv("短文本（胶囊，最多 4 字）", 12, T().sub));
        h2.addView(spacer());
        const counter = tv((r.island.short || "").length + "/4", 11, T().sub);
        h2.addView(counter);
        body.addView(h2);
        body.addView(space(0, 5));
        body.addView(eShort, new LL.LayoutParams(MATCH, WRAP));

        eShort.addTextChangedListener(new JavaAdapter(android.text.TextWatcher, {
            afterTextChanged: function () {
                const n = String(eShort.getText().toString() || "").length;
                counter.setText(n + "/4");
                counter.setTextColor(C(n > 4 ? T().danger : T().sub));
            },
            beforeTextChanged: function () {},
            onTextChanged: function () {},
        }));

        body.addView(space(0, 16));
        body.addView(tv("按钮（最多 3 个，留空即不显示）", 12, T().sub));
        body.addView(space(0, 4));
        body.addView(tv("若存在定时岛，最后一位会被「切回」占用", 10, T().sub));
        body.addView(space(0, 8));

        const btnRows = [];
        for (let i = 0; i < 3; i++) {
            (function (idx) {
                const box = kit.card(T().card, 12, 12);

                const head = hbox();
                head.setPadding(0, 0, 0, 0);
                head.addView(tv("按钮 " + (idx + 1), 12, T().sub));
                head.addView(spacer());
                const curLabel = String(r.island.buttons[idx].label || "");
                const labelTv = tv(curLabel ? ("文字：" + curLabel) : "设置文字 ›", 13,
                    curLabel ? T().name : T().accent, !!curLabel);
                head.addView(labelTv);
                head.setOnClickListener(function () {
                    askText("按钮显示文字（岛上最多 4 字可见）", r.island.buttons[idx].label || "",
                        function (s) {
                            r.island.buttons[idx].label = String(s || "").trim();
                            const v = r.island.buttons[idx].label;
                            labelTv.setText(v ? ("文字：" + v) : "设置文字 ›");
                            labelTv.setTextColor(C(v ? T().name : T().accent));
                            labelTv.setTypeface(null, v ? android.graphics.Typeface.BOLD
                                : android.graphics.Typeface.NORMAL);
                        });
                });
                box.addView(head);
                box.addView(space(0, 8));

                box.addView(tv("点击动作", 11, T().sub));
                box.addView(space(0, 5));
                box.addView(actionRow(r.island.buttons[idx], function (act) {
                    const cur = r.island.buttons[idx];
                    cur.type = act.type;
                    cur.name = act.name || "";
                    cur.value = act.value || "";
                }));

                box.addView(space(0, 6));
                box.addView(iconRow(r.island.buttons[idx].icon, function (v) {
                    r.island.buttons[idx].icon = v;
                }, "按钮图标"));

                btnRows.push(idx);
                body.addView(box);
                body.addView(space(0, 8));
            })(i);
        }

        sv.addView(body, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));

        const bar = hbox();
        bar.setPadding(dp(16), dp(8), dp(16), dp(12));
        if (!isNew) {
            const del = kit.pill("删除规则", T().card2, T().danger, 12);
            del.setOnClickListener(function () {
                cfg.rules = cfg.rules.filter(function (x) { return x.id !== r.id; });
                saveAll(); closePanel(); rebuild();
            });
            bar.addView(del);
        }
        bar.addView(spacer());
        bar.addView(kit.btn("保存", true, function () {
            r.island.title = String(eTitle.getText().toString() || "");
            r.island.content = String(eContent.getText().toString() || "");
            r.island.short = String(eShort.getText().toString() || "").substring(0, 4);

            for (let i = 0; i < 3; i++) {
                const b = r.island.buttons[i];
                let lb = String(b.label || "").trim();
                if (!lb) {
                    if (b.type === "page") lb = "规则";
                    else if (b.type === "hide") lb = "下岛";
                    else if (b.type === "last") lb = "切回";
                    else if (b.value) lb = String(b.name || "执行").substring(0, 4);
                    else b.type = "none";
                }
                b.label = lb;
            }
            if (isNew) cfg.rules.push(r);
            else {
                const i = cfg.rules.map(function (x) { return x.id; }).indexOf(r.id);
                if (i >= 0) cfg.rules[i] = r;
            }
            saveAll(); closePanel(); rebuild(); toast("已保存");
        }));
        col.addView(bar);
    });
}

/* ================== 定时规则编辑 ================== */
function scheduleEditor(s) {
    const isNew = !s;
    const o = s ? JSON.parse(JSON.stringify(s)) : {
        id: "s" + Date.now().toString(36),
        enabled: true, name: "",
        when: { type: "daily", at: ["08:00"], days: [1, 2, 3, 4, 5], everyMin: 90 },
        durationMin: 0, autoRun: false,
        island: { title: "", content: "", short: "", buttons: [] },
    };
    if (!o.when) o.when = { type: "daily", at: ["08:00"] };
    if (!o.island) o.island = {};
    if (!o.island.buttons) o.island.buttons = [];
    while (o.island.buttons.length < 3) o.island.buttons.push({ label: "", type: "none", name: "", value: "" });

    openPanel(function (col) {
        panelHeader(col, isNew ? "新建定时规则" : (o.name || "定时规则"), null);

        const sv = new SV(context);
        const body = vbox(0);
        body.setPadding(dp(16), dp(10), dp(16), dp(16));

        const eName = kit.et("例如 早间签到提醒", o.name || "");
        body.addView(tv("名称", 12, T().sub));
        body.addView(space(0, 5));
        body.addView(eName, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 12));

        const rowsBox = vbox(0);
        body.addView(rowsBox);

        function renderRows() {
            rowsBox.removeAllViews();

            settingRow(rowsBox, "触发方式",
                o.when.type === "weekly" ? "每周" : (o.when.type === "interval" ? "间隔" : "每天"),
                function () {
                    const idx = o.when.type === "weekly" ? 1 : (o.when.type === "interval" ? 2 : 0);
                    pickList("触发方式", ["每天", "每周", "间隔重复"], idx, function (i) {
                        o.when.type = ["daily", "weekly", "interval"][i];
                        if (o.when.type === "interval" && !o.when.everyMin) o.when.everyMin = 90;
                        if (o.when.type !== "interval" && !(o.when.at || []).length) o.when.at = ["08:00"];
                        renderRows();
                    });
                });

            if (o.when.type === "interval") {
                settingRow(rowsBox, "间隔", "每 " + (o.when.everyMin || 90) + " 分钟", function () {
                    askText("每多少分钟触发一次", (o.when.everyMin || 90), function (s) {
                        o.when.everyMin = Math.max(1, parseInt(s, 10) || 90);
                        renderRows();
                    }, true);
                });
            } else {
                const at = (o.when.at && o.when.at.length) ? o.when.at : ["08:00"];
                settingRow(rowsBox, "时间", at.join(" / "), function () {
                    askText("时间，多个用逗号分隔（如 08:00,20:30）", at.join(","), function (s) {
                        const arr = String(s).split(/[,，\s]+/).filter(function (x) {
                            return /^\d{1,2}:\d{2}$/.test(x);
                        });
                        if (!arr.length) return toast("格式不对，示例 08:00");
                        o.when.at = arr;
                        renderRows();
                    });
                });
            }

            if (o.when.type === "weekly") {
                const names = ["一", "二", "三", "四", "五", "六", "日"];
                settingRow(rowsBox, "星期",
                    (o.when.days || []).map(function (d) { return names[d - 1]; }).join(" "), function () {
                        pickMulti("选择星期", names,
                            (o.when.days || []).map(function (d) { return d - 1; }),
                            function (idx) {
                                o.when.days = idx.map(function (i) { return i + 1; });
                                if (!o.when.days.length) o.when.days = [1];
                                renderRows();
                            });
                    });
            }

            settingRow(rowsBox, "持续时间",
                Number(o.durationMin) > 0 ? (o.durationMin + " 分钟") : "一直显示", function () {
                    askText("持续多少分钟后自动退场（0 = 一直显示）", (o.durationMin || 0), function (s) {
                        o.durationMin = Math.max(0, parseInt(s, 10) || 0);
                        renderRows();
                    }, true);
                });

            settingRow(rowsBox, "到点直接执行", o.autoRun ? "开" : "关", function () {
                o.autoRun = !o.autoRun;
                renderRows();
            });
        }
        renderRows();

        body.addView(space(0, 16));
        body.addView(tv("岛内容", 12, T().sub));
        body.addView(space(0, 8));

        const eTitle = kit.et("例如 该签到了", o.island.title || "");
        const eContent = kit.et("例如 微信 / 支付宝各有一个签到", o.island.content || "");
        const eShort = kit.et("最多 4 个字", o.island.short || "");

        body.addView(tv("岛标题", 11, T().sub));
        body.addView(space(0, 4));
        body.addView(eTitle, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 9));
        body.addView(tv("岛内容", 11, T().sub));
        body.addView(space(0, 4));
        body.addView(eContent, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 9));

        const h3 = hbox();
        h3.addView(tv("短文本（最多 4 字）", 11, T().sub));
        h3.addView(spacer());
        const counter = tv((o.island.short || "").length + "/4", 11, T().sub);
        h3.addView(counter);
        body.addView(h3);
        body.addView(space(0, 4));
        body.addView(eShort, new LL.LayoutParams(MATCH, WRAP));

        eShort.addTextChangedListener(new JavaAdapter(android.text.TextWatcher, {
            afterTextChanged: function () {
                const n = String(eShort.getText().toString() || "").length;
                counter.setText(n + "/4");
                counter.setTextColor(C(n > 4 ? T().danger : T().sub));
            },
            beforeTextChanged: function () {},
            onTextChanged: function () {},
        }));

        body.addView(space(0, 16));
        body.addView(tv("按钮（最多 3 个，留空即不显示）", 12, T().sub));
        body.addView(space(0, 4));
        body.addView(tv("若存在应用岛，最后一位会被「切回」占用", 10, T().sub));
        body.addView(space(0, 8));

        const btnRows = [];
        for (let i = 0; i < 3; i++) {
            (function (idx) {
                const box = kit.card(T().card, 12, 12);

                const head = hbox();
                head.addView(tv("按钮 " + (idx + 1), 12, T().sub));
                head.addView(spacer());
                const curLabel = String(o.island.buttons[idx].label || "");
                const labelTv = tv(curLabel ? ("文字：" + curLabel) : "设置文字 ›", 13,
                    curLabel ? T().name : T().accent, !!curLabel);
                head.addView(labelTv);
                head.setOnClickListener(function () {
                    askText("按钮显示文字（岛上最多 4 字可见）", o.island.buttons[idx].label || "",
                        function (s) {
                            o.island.buttons[idx].label = String(s || "").trim();
                            const v = o.island.buttons[idx].label;
                            labelTv.setText(v ? ("文字：" + v) : "设置文字 ›");
                            labelTv.setTextColor(C(v ? T().name : T().accent));
                            labelTv.setTypeface(null, v ? android.graphics.Typeface.BOLD
                                : android.graphics.Typeface.NORMAL);
                        });
                });
                box.addView(head);
                box.addView(space(0, 8));

                box.addView(tv("点击动作", 11, T().sub));
                box.addView(space(0, 5));
                box.addView(actionRow(o.island.buttons[idx], function (act) {
                    const cur = o.island.buttons[idx];
                    cur.type = act.type;
                    cur.name = act.name || "";
                    cur.value = act.value || "";
                }));

                box.addView(space(0, 6));
                box.addView(iconRow(o.island.buttons[idx].icon, function (v) {
                    o.island.buttons[idx].icon = v;
                }, "按钮图标"));

                btnRows.push(idx);
                body.addView(box);
                body.addView(space(0, 8));
            })(i);
        }

        sv.addView(body, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));

        const bar = hbox();
        bar.setPadding(dp(16), dp(8), dp(16), dp(12));
        if (!isNew) {
            const del = kit.pill("删除", T().card2, T().danger, 12);
            del.setOnClickListener(function () {
                cfg.schedules = cfg.schedules.filter(function (x) { return x.id !== o.id; });
                saveAll(); closePanel(); rebuild();
            });
            bar.addView(del);
        }
        bar.addView(spacer());
        bar.addView(kit.btn("保存", true, function () {
            o.name = String(eName.getText().toString() || "定时规则");
            o.island.title = String(eTitle.getText().toString() || "");
            o.island.content = String(eContent.getText().toString() || "");
            o.island.short = String(eShort.getText().toString() || "").substring(0, 4);

            for (let i = 0; i < 3; i++) {
                const b = o.island.buttons[i];
                let lb = String(b.label || "").trim();
                if (!lb) {
                    if (b.type === "page") lb = "规则";
                    else if (b.type === "hide") lb = "下岛";
                    else if (b.type === "last") lb = "切回";
                    else if (b.value) lb = String(b.name || "执行").substring(0, 4);
                    else b.type = "none";
                }
                b.label = lb;
            }
            if (isNew) cfg.schedules.push(o);
            else {
                const i = cfg.schedules.map(function (x) { return x.id; }).indexOf(o.id);
                if (i >= 0) cfg.schedules[i] = o;
            }
            saveAll(); closePanel(); rebuild(); toast("已保存");
        }));
        col.addView(bar);
    });
}

/* ================== 通知规则编辑 ================== */
function notifyEditor(item) {
    const isNew = !item;
    const o = item ? JSON.parse(JSON.stringify(item)) : {
        id: "n" + Date.now().toString(36),
        enabled: true, name: "", pkg: "", appName: "",
        keyword: "", durationMin: 3,
        island: { title: "{app}", content: "{title}：{text}", short: "", buttons: [] },
    };
    if (!o.island) o.island = {};
    if (!o.island.buttons) o.island.buttons = [];
    while (o.island.buttons.length < 3) {
        o.island.buttons.push({ label: "", type: "none", name: "", value: "" });
    }

    openPanel(function (col) {
        panelHeader(col, isNew ? "新建通知规则" : (o.name || "通知规则"), null);

        const sv = new SV(context);
        const body = vbox(0);
        body.setPadding(dp(16), dp(10), dp(16), dp(16));

        const eName = kit.et("例如 微信消息", o.name || "");
        body.addView(tv("名称", 12, T().sub));
        body.addView(space(0, 5));
        body.addView(eName, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 12));

        const rowsBox = vbox(0);
        body.addView(rowsBox);

        function renderRows() {
            rowsBox.removeAllViews();

            settingRow(rowsBox, "应用", o.appName || "未选择", function () {
                pickAppPanel(function (a) {
                    o.pkg = a.pkg;
                    o.appName = a.name;
                    renderRows();
                });
            });

            settingRow(rowsBox, "关键词",
                o.keyword ? ("含「" + o.keyword + "」") : "不限（全部通知）", function () {
                    askText("只对包含该关键词的通知上岛（留空 = 全部）", o.keyword || "", function (s) {
                        o.keyword = String(s || "").trim();
                        renderRows();
                    });
                });

            settingRow(rowsBox, "停留时长",
                Number(o.durationMin) > 0 ? (o.durationMin + " 分钟") : "一直显示", function () {
                    askText("停留多少分钟后回落（0 = 一直显示）", (o.durationMin || 0), function (s) {
                        o.durationMin = Math.max(0, parseInt(s, 10) || 0);
                        renderRows();
                    }, true);
                });
        }
        renderRows();

        body.addView(space(0, 16));
        body.addView(tv("岛内容（可用 {app} {title} {text}）", 12, T().sub));
        body.addView(space(0, 8));

        const eTitle = kit.et("{app}", o.island.title || "");
        const eContent = kit.et("{title}：{text}", o.island.content || "");
        const eShort = kit.et("最多 4 个字", o.island.short || "");

        body.addView(tv("岛标题", 11, T().sub));
        body.addView(space(0, 4));
        body.addView(eTitle, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 9));
        body.addView(tv("岛内容", 11, T().sub));
        body.addView(space(0, 4));
        body.addView(eContent, new LL.LayoutParams(MATCH, WRAP));
        body.addView(space(0, 9));
        body.addView(tv("短文本（最多 4 字）", 11, T().sub));
        body.addView(space(0, 4));
        body.addView(eShort, new LL.LayoutParams(MATCH, WRAP));

        body.addView(space(0, 16));
        body.addView(tv("按钮（最多 3 个，留空即不显示）", 12, T().sub));
        body.addView(space(0, 8));

        const btnRows = [];
        for (let i = 0; i < 3; i++) {
            (function (idx) {
                const box = kit.card(T().card, 12, 12);

                const head = hbox();
                head.addView(tv("按钮 " + (idx + 1), 12, T().sub));
                head.addView(spacer());
                const curLabel = String(o.island.buttons[idx].label || "");
                const labelTv = tv(curLabel ? ("文字：" + curLabel) : "设置文字 ›", 13,
                    curLabel ? T().name : T().accent, !!curLabel);
                head.addView(labelTv);
                head.setOnClickListener(function () {
                    askText("按钮显示文字（岛上最多 4 字可见）", o.island.buttons[idx].label || "",
                        function (s) {
                            o.island.buttons[idx].label = String(s || "").trim();
                            const v = o.island.buttons[idx].label;
                            labelTv.setText(v ? ("文字：" + v) : "设置文字 ›");
                            labelTv.setTextColor(C(v ? T().name : T().accent));
                        });
                });
                box.addView(head);
                box.addView(space(0, 8));

                box.addView(tv("点击动作", 11, T().sub));
                box.addView(space(0, 5));
                box.addView(actionRow(o.island.buttons[idx], function (act) {
                    const cur = o.island.buttons[idx];
                    cur.type = act.type;
                    cur.name = act.name || "";
                    cur.value = act.value || "";
                }));

                box.addView(space(0, 6));
                box.addView(iconRow(o.island.buttons[idx].icon, function (v) {
                    o.island.buttons[idx].icon = v;
                }, "按钮图标"));

                btnRows.push(idx);
                body.addView(box);
                body.addView(space(0, 8));
            })(i);
        }

        sv.addView(body, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));

        const bar = hbox();
        bar.setPadding(dp(16), dp(8), dp(16), dp(12));
        if (!isNew) {
            const del = kit.pill("删除", T().card2, T().danger, 12);
            del.setOnClickListener(function () {
                cfg.notifies = cfg.notifies.filter(function (x) { return x.id !== o.id; });
                saveAll(); closePanel(); rebuild();
            });
            bar.addView(del);
        }
        bar.addView(spacer());
        bar.addView(kit.btn("保存", true, function () {
            if (!o.pkg) return toast("先选择应用");
            o.name = String(eName.getText().toString() || o.appName || "通知规则");
            o.island.title = String(eTitle.getText().toString() || "");
            o.island.content = String(eContent.getText().toString() || "");
            o.island.short = String(eShort.getText().toString() || "").substring(0, 4);

            for (let i = 0; i < 3; i++) {
                const b = o.island.buttons[i];
                let lb = String(b.label || "").trim();
                if (!lb) {
                    if (b.type === "page") lb = "规则";
                    else if (b.type === "hide") lb = "下岛";
                    else if (b.type === "last") lb = "切回";
                    else if (b.value) lb = String(b.name || "执行").substring(0, 4);
                    else b.type = "none";
                }
                b.label = lb;
            }
            if (isNew) cfg.notifies.push(o);
            else {
                const i = cfg.notifies.map(function (x) { return x.id; }).indexOf(o.id);
                if (i >= 0) cfg.notifies[i] = o;
            }
            saveAll(); closePanel(); rebuild(); toast("已保存");
        }));
        col.addView(bar);
    });
}

/* ================== 事件面板 ================== */
function eventsPanel() {
    openPanel(function (col) {
        panelHeader(col, "接入事件", null);
        const body = vbox(0);
        body.setPadding(dp(16), dp(10), dp(16), dp(20));
        body.addView(tv("系统只会把服务声明过的事件回调过来，勾了不代表收得到。建议先实测。", 11, T().sub));
        body.addView(space(0, 10));

        const checks = {};
        EVENT_LIST.forEach(function (e) {
            const on = (cfg.events || []).indexOf(e.name) !== -1;
            const r = hbox();
            r.setPadding(dp(12), dp(12), dp(12), dp(12));
            r.setBackground(UI.roundBg(T().card, 12));

            const box = tv(on ? "✓" : "", 13, "#FFFFFF", true);
            box.setGravity(G.CENTER);
            box.setLayoutParams(new LL.LayoutParams(dp(22), dp(22)));
            const paint = function (v) {
                box.setText(v ? "✓" : "");
                box.setBackground(v ? UI.ovalBg(T().accent, null, 0) : UI.ovalBg(null, T().sub, 2));
            };
            paint(on);

            r.addView(box);
            r.addView(space(10, 0));

            const mid = vbox(0);
            mid.addView(tv(e.label, 14, T().name, true));
            mid.addView(tv(e.name, 9, T().sub));
            r.addView(mid, new LL.LayoutParams(0, WRAP, 1));

            const status = tv("", 11, T().sub);
            r.addView(status);

            checks[e.name] = { box: box, status: status, on: on, paint: paint };
            r.setOnClickListener(function () {
                const c = checks[e.name];
                c.on = !c.on;
                c.paint(c.on);
            });
            const lp = new LL.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = dp(6);
            body.addView(r, lp);
        });

        body.addView(space(0, 8));
        body.addView(kit.btn("测试 10 秒（请反复切几个应用）", false, function () {
            Object.keys(checks).forEach(function (k) { checks[k].status.setText(""); });
            toast("开始探测，请切换应用");
            kit.probeEvents(Object.keys(checks), 10000, function (hits) {
                ui.run(function () {
                    Object.keys(checks).forEach(function (k) {
                        checks[k].status.setText(hits[k] ? ("✓ " + hits[k]) : "✗");
                        checks[k].status.setTextColor(C(hits[k] ? T().accent : T().danger));
                    });
                    toast("探测完成");
                });
            });
        }));

        const svE = new SV(context);
        svE.setClipToPadding(false);
        svE.addView(body, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(svE, new LL.LayoutParams(MATCH, 0, 1));

        const bar = hbox();
        bar.setPadding(dp(16), dp(8), dp(16), dp(12));
        bar.addView(spacer());
        bar.addView(kit.btn("保存", true, function () {
            const arr = [];
            Object.keys(checks).forEach(function (k) { if (checks[k].on) arr.push(k); });
            if (!arr.length) return toast("至少保留一个事件");
            cfg.events = arr;
            saveAll(); closePanel(); toast("已保存");
        }));
        col.addView(bar);
    });
}

/* ================== 设置面板 ================== */
function settingsPanel() {
    openPanel(function (col) {
        panelHeader(col, "设置", null);
        const body = vbox(0);
        body.setPadding(dp(16), dp(2), dp(16), dp(16));

        sectionLabel(body, "通知岛");
        settingRow(body, "通知使用权", kit.notifyPermissionOk() ? "已授权" : "未授权 · 点此开启", function () {
            kit.openNotifySettings();
        });

        sectionLabel(body, "守护");
        settingRow(body, "重启守护", "停掉所有运行中的守护，再启动当前目录这个", function () {
            restartDaemon();
        });
        settingRow(body, "停止所有守护实例", "停止所有目录下运行中的 daemon（不删文件）", function () {
            stopAllDaemons();
        });
        settingRow(body, "测试上岛", "绕过规则，直接发一次上岛", function () {
            kit.testShow();
        });
        settingRow(body, "测试下岛", "立刻撤掉当前的岛", function () {
            kit.hideIslandNow();
        });
        const daemonPath = kit.findDaemonPath() || "未找到";
        const pathTv = tv("数据目录：" + kit.PATHS.dir + "\n配置：" + kit.PATHS.cfg
            + "\n守护脚本：" + daemonPath, 9, T().sub);
        pathTv.setPadding(dp(4), dp(4), dp(4), dp(6));
        body.addView(pathTv);

        sectionLabel(body, "诊断");
        const diagHint = tv("后台卡片页会让系统隐藏状态栏和岛，这是系统行为，代码绕不过去", 9, T().sub);
        diagHint.setPadding(dp(4), dp(0), dp(4), dp(6));
        body.addView(diagHint);
        const stD = kit.readState() || {};
        const sameDir = !stD.dir || stD.dir === kit.PATHS.dir;
        const dirTv = tv(sameDir
            ? "守护目录：与配置目录一致"
            : ("守护目录不一致：\n守护 " + stD.dir + "\n配置 " + kit.PATHS.dir),
            sameDir ? 10 : 11, sameDir ? T().sub : T().danger);
        dirTv.setPadding(dp(4), dp(2), dp(4), dp(8));
        body.addView(dirTv);

        const nowTs = Date.now();
        const evAgo = stD.lastEventAt ? Math.max(0, Math.round((nowTs - Number(stD.lastEventAt)) / 1000)) : -1;
        const rdAgo = stD.lastRenderAt ? Math.max(0, Math.round((nowTs - Number(stD.lastRenderAt)) / 1000)) : -1;

        settingRow(body, "最近收到事件", evAgo >= 0 ? (evAgo + " 秒前") : "无记录", null);
        settingRow(body, "最近上岛", rdAgo >= 0 ? (rdAgo + " 秒前") : "无记录", null);
        if (evAgo > 90) {
            const warn = tv("事件已静默 " + evAgo + " 秒：守护可能被清空无障碍回调，或前台一直没变", 10, T().danger);
            warn.setPadding(dp(4), dp(2), dp(4), dp(8));
            body.addView(warn);
        }

        let lastEvt = null;
        try { lastEvt = storages.create("island_state").get("lastEvt", null); } catch (e) { }
        if (lastEvt && lastEvt.pkg) {
            const evTv = tv("最近窗口事件：\n" + lastEvt.pkg + "\n" + (lastEvt.cls || "(无类名)"), 10, T().sub);
            evTv.setPadding(dp(4), dp(2), dp(4), dp(8));
            body.addView(evTv);
        }

        let lastTap = null;
        try { lastTap = storages.create("island_state").get("lastTap", null); } catch (e) { }
        settingRow(body, "最近一次点击",
            lastTap && lastTap.key
                ? (lastTap.key + " · " + new Date(Number(lastTap.at)).toLocaleTimeString())
                : "还没收到过点击",
            function () { closePanel(); settingsPanel(); });

        const modes = [["default", "显示默认态"], ["hide", "撤岛"], ["keep", "保持不动"]];
        sectionLabel(body, "未命中规则时");
        const noRuleHint = tv("显示默认态：回桌面就切「就绪」；撤岛：直接隐藏；保持不动：一直保留当前内容（受下方保持上限约束）", 9, T().sub);
        noRuleHint.setPadding(dp(4), dp(0), dp(4), dp(6));
        body.addView(noRuleHint);
        settingRow(body, "处理方式",
            (modes.filter(function (m) { return m[0] === cfg.lifecycle.onNoRule; })[0] || modes[0])[1],
            function () {
                let idx = 0;
                modes.forEach(function (m, i) { if (m[0] === cfg.lifecycle.onNoRule) idx = i; });
                pickList("未命中规则时", modes.map(function (m) { return m[1]; }), idx, function (i) {
                    cfg.lifecycle.onNoRule = modes[i][0];
                    saveAll(); closePanel(); settingsPanel();
                });
            });

        sectionLabel(body, "手动下岛");
        settingRow(body, "抑制时长", (cfg.lifecycle.manualMuteMin || 10) + " 分钟", function () {
            askText("下岛后多少分钟内不再自动上岛", (cfg.lifecycle.manualMuteMin || 10), function (s) {
                cfg.lifecycle.manualMuteMin = Math.max(0, parseInt(s, 10) || 0);
                saveAll(); closePanel(); settingsPanel();
            }, true);
        });

        sectionLabel(body, "未命中的抖动过滤");
        settingRow(body, "判定延迟", (cfg.safety.noRuleDelayMs || 0) + " ms", function () {
            const OPTS = [0, 300, 350, 500, 800];
            let idx = OPTS.indexOf(Number(cfg.safety.noRuleDelayMs));
            if (idx < 0) idx = 2;
            pickList("未命中后等多久再切默认态（过滤切换抖动）", OPTS.map(function (v) { return v + " ms"; }), idx,
                function (i) {
                    cfg.safety.noRuleDelayMs = OPTS[i];
                    saveAll(); closePanel(); settingsPanel();
                });
        });
        settingRow(body, "回桌面判定", (cfg.safety.desktopDelayMs || 0) + " ms", function () {
            const OPTS = [400, 800, 1200, 2000];
            let idx = OPTS.indexOf(Number(cfg.safety.desktopDelayMs));
            if (idx < 0) idx = 1;
            pickList("回桌面后等多久再确认；期间切回应用会自动撤销",
                OPTS.map(function (v) { return v + " ms"; }), idx,
                function (i) {
                    cfg.safety.desktopDelayMs = OPTS[i];
                    saveAll(); closePanel(); settingsPanel();
                });
        });
        settingRow(body, "保持上限",
            Number(cfg.lifecycle.keepMaxMin) > 0 ? (cfg.lifecycle.keepMaxMin + " 分钟") : "不限", function () {
                askText("「保持不动」最多保持多少分钟（0 = 不限）", (cfg.lifecycle.keepMaxMin || 0),
                    function (s) {
                        cfg.lifecycle.keepMaxMin = Math.max(0, parseInt(s, 10) || 0);
                        saveAll(); closePanel(); settingsPanel();
                    }, true);
            });

        sectionLabel(body, "默认态（未匹配时展示）");
        const varHint = tv("标题/内容可用变量：{time} {date} {hour} {min}；自定义变量先用 kit.setVar(\"名\", 值) 写入，再写 {名} 引用", 9, T().sub);
        varHint.setPadding(dp(4), dp(0), dp(4), dp(6));
        body.addView(varHint);
        settingRow(body, "标题", cfg.island.default.title || "就绪", function () {
            askText("默认态标题", cfg.island.default.title || "", function (s) {
                cfg.island.default.title = s;
                saveAll(); closePanel(); settingsPanel();
            });
        });
        settingRow(body, "内容", cfg.island.default.content || "", function () {
            askText("默认态内容", cfg.island.default.content || "", function (s) {
                cfg.island.default.content = s;
                saveAll(); closePanel(); settingsPanel();
            });
        });
        settingRow(body, "短文本", cfg.island.default.short || "空闲", function () {
            askText("默认态短文本（≤4 字）", cfg.island.default.short || "", function (s) {
                cfg.island.default.short = String(s).substring(0, 4);
                saveAll(); closePanel(); settingsPanel();
            });
        });

        sectionLabel(body, "安全兜底");
        settingRow(body, "事件兜底轮询", (cfg.safety.heartbeatMs || 0) > 0
            ? ((cfg.safety.heartbeatMs / 1000) + " 秒") : "关闭", function () {
            askText("事件丢失时用前台查询纠正，间隔几秒（0 = 关闭）", (cfg.safety.heartbeatMs || 0) / 1000, function (s) {
                cfg.safety.heartbeatMs = Math.max(0, Math.round((parseFloat(s) || 0) * 1000));
                saveAll(); closePanel(); settingsPanel();
            }, true);
        });
        settingRow(body, "息屏隐藏岛", cfg.safety.hideWhenScreenOff !== false ? "开" : "关", function () {
            cfg.safety.hideWhenScreenOff = !(cfg.safety.hideWhenScreenOff !== false);
            saveAll(); closePanel(); settingsPanel();
        });
        settingRow(body, "仅亮屏时工作", cfg.safety.onlyWhenScreenOn !== false ? "开" : "关", function () {
            cfg.safety.onlyWhenScreenOn = !(cfg.safety.onlyWhenScreenOn !== false);
            saveAll(); closePanel(); settingsPanel();
        });
        settingRow(body, "点击调试（收到点击时 toast key）", cfg.safety.debug ? "开" : "关", function () {
            cfg.safety.debug = !cfg.safety.debug;
            saveAll(); closePanel(); settingsPanel();
        });

        sectionLabel(body, "忽略名单（这些包名不改变岛）");
        const igHint = tv("输入法会自动识别，无需手动加", 9, T().sub);
        igHint.setPadding(dp(4), dp(0), dp(4), dp(4));
        body.addView(igHint);
        const igTv = tv((cfg.ignore || []).join("\n"), 9, T().sub);
        igTv.setPadding(dp(4), dp(2), dp(4), dp(10));
        body.addView(igTv);

        sectionLabel(body, "关于");
        const verTv = tv("构建 " + BUILD, 11, T().sub);
        verTv.setPadding(dp(4), dp(2), dp(4), dp(30));
        body.addView(verTv);

        const sv = new SV(context);
        sv.setClipToPadding(false);
        sv.addView(body, new android.widget.FrameLayout.LayoutParams(MATCH, WRAP));
        col.addView(sv, new LL.LayoutParams(MATCH, 0, 1));
    });
}

/* ================== 守护控制 ================== */
/** 停掉所有 daemon 实例（可能分布在不同目录） */
function stopAllDaemons(silent) {
    let stopped = 0;
    const found = [];
    try {
        engines.all().forEach(function (e) {
            try {
                const src = String(e.getSource() || "");
                if (src.indexOf("island_daemon.js") !== -1) {
                    found.push(src);
                    e.forceStop();
                    stopped++;
                }
            } catch (err) {}
        });
    } catch (e) { log("枚举脚本失败: " + e); }

    if (!silent) {
        if (stopped) {
            toast("已停止 " + stopped + " 个守护实例");
            log("已停止:\n" + found.join("\n"));
        } else {
            toast("没有找到运行中的守护实例");
        }
    }
    return stopped;
}

/** 停掉所有旧 daemon 实例，再启动扫描到的 daemon */
function restartDaemon() {
    const stopped = stopAllDaemons(true);
    const target = kit.findDaemonPath();

    if (!target) {
        toast("找不到 island_daemon.js，请确认脚本已放在 脚本/ 下");
        return;
    }

    setTimeout(function () {
        try {
            engines.execScriptFile(target);
            toast("已停止 " + stopped + " 个旧守护\n已启动：" + target.substring(target.lastIndexOf("/") + 1));
        } catch (e) {
            toast("启动失败：" + e);
        }
    }, 800);
}

/* ================== 保存 ================== */
function saveAll() {
    try {
        kit.writeCfg(cfg);
        kit.sendCmd("reload");
    } catch (e) {
        toast("保存失败：" + e);
        log(e);
    }
}

/* ================== 夜间切换 ================== */
setInterval(function () {
    const n = UI.isNight();
    if (n === darkCache) return;
    darkCache = n;
    while (panel.depth() > 0) closePanel();
    rebuild();
}, 1500);

ui.emitter.on("resume", function () {
    const n = UI.isNight();
    if (n !== darkCache) darkCache = n;
    rebuild();
});

/* 返回键 / 手势返回 由 U.bindBack 统一处理（逐层关闭 → 根页面退到桌面） */

rebuild();
