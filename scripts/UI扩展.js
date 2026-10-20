/**
 * UI扩展.js —— 在 UI模块.js 之上补一层通用构件
 * ------------------------------------------------------------------
 * require 一次即可同时拿到 UI模块 全部能力（C / dp / theme / roundBg ...）
 * 以及以下新增：
 *
 *   【布局】  vbox hbox tv et btn pill line space spacer card scroll field
 *   【系统栏】applySystemBars statusBarHeight navigationBarHeight
 *   【面板】  createPanel bindPanel bindBack   ← 栈式面板 + 防点击穿透 + 返回键
 *   【选择】  pickList askText pickMulti
 *   【行式】  sectionLabel settingRow iconRow checkRow
 *   【应用】  appPickPanel（单选 / 多选合一）
 *   【文件】  filePicker
 *
 * 依赖：/storage/emulated/0/脚本/常用模块/UI模块.js
 * ------------------------------------------------------------------
 */
module.exports = (function () {

    const UI = require("/storage/emulated/0/脚本/常用模块/UI模块.js");
    try { UI.setContext(context); } catch (e) {}

    const LL = android.widget.LinearLayout;
    const FL = android.widget.FrameLayout;
    const TV = android.widget.TextView;
    const ET = android.widget.EditText;
    const SV = android.widget.ScrollView;
    const V = android.view.View;
    const G = android.view.Gravity;
    const MATCH = android.view.ViewGroup.LayoutParams.MATCH_PARENT;
    const WRAP = android.view.ViewGroup.LayoutParams.WRAP_CONTENT;
    const SCRIPT_ROOT = "/storage/emulated/0/脚本";

    function ctx() { try { return context; } catch (e) { return null; } }
    function C(h) { return UI.C(h); }
    function dp(v) { return UI.dp(v); }
    function T() { return UI.theme(); }
    function pageBg(t) { t = t || T(); return t.dark ? "#0E0E10" : "#F2F2F4"; }

    /* ================= 布局构件 ================= */

    function vbox(pad) {
        const v = new LL(ctx());
        v.setOrientation(LL.VERTICAL);
        if (pad != null) v.setPadding(dp(pad), dp(pad), dp(pad), dp(pad));
        return v;
    }

    function hbox() {
        const v = new LL(ctx());
        v.setOrientation(LL.HORIZONTAL);
        v.setGravity(G.CENTER_VERTICAL);
        return v;
    }

    function tv(text, size, colorHex, bold) {
        const t = new TV(ctx());
        t.setText(text == null ? "" : String(text));
        t.setTextSize(size || 14);
        t.setTextColor(C(colorHex || T().name));
        if (bold) t.setTypeface(null, android.graphics.Typeface.BOLD);
        t.setIncludeFontPadding(false);
        return t;
    }

    function et(hint, value, single) {
        const e = new ET(ctx());
        e.setBackground(UI.roundBg(T().card2, 12));
        e.setTextColor(C(T().title));
        e.setHintTextColor(C(T().sub));
        e.setTextSize(14);
        e.setHint(hint || "");
        if (value != null && value !== "") e.setText(String(value));
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
        e.setSingleLine(single !== false);
        e.setIncludeFontPadding(false);
        return e;
    }

    function btn(text, primary, onTap) {
        const b = tv(text, 14, primary ? (T().dark ? "#04231A" : "#FFFFFF") : T().name, true);
        b.setGravity(G.CENTER);
        b.setBackground(UI.roundBg(primary ? T().accent : T().card2, 12));
        b.setPadding(dp(16), dp(10), dp(16), dp(10));
        if (onTap) b.setOnClickListener(function () { onTap(); });
        return b;
    }

    function pill(text, bgHex, txtHex, size) {
        return UI.pillButton(text, bgHex || T().card2, txtHex || T().name, size || 12, 12, 6);
    }

    function space(w, h) {
        const v = new V(ctx());
        v.setLayoutParams(new LL.LayoutParams(w ? dp(w) : 0, h ? dp(h) : 0));
        return v;
    }

    function spacer() {
        const v = new V(ctx());
        v.setLayoutParams(new LL.LayoutParams(0, 1, 1));
        return v;
    }

    function line(colorHex) {
        const v = new V(ctx());
        v.setBackgroundColor(C(colorHex || T().divider));
        v.setLayoutParams(new LL.LayoutParams(MATCH, 1));
        return v;
    }

    function card(bgHex, radius, pad) {
        const c = vbox(pad == null ? 14 : pad);
        c.setBackground(UI.roundBg(bgHex || T().card, radius == null ? 16 : radius));
        return c;
    }

    function scroll() {
        const s = new SV(ctx());
        s.setClipToPadding(false);
        return s;
    }

    /** 竖向滚动容器：addView 到返回的 col，再把返回的 sv 加到父容器 */
    function scrollBox(colPad) {
        const sv = new SV(ctx());
        sv.setClipToPadding(false);
        const col = vbox(0);
        if (colPad != null) col.setPadding(dp(colPad), 0, dp(colPad), dp(colPad));
        sv.addView(col, new FL.LayoutParams(MATCH, WRAP));
        return { sv: sv, col: col };
    }

    /** 标签 + 输入框 */
    function field(labelText, inputView, gap) {
        const box = vbox(0);
        box.addView(tv(labelText, 12, T().sub));
        box.addView(space(0, gap == null ? 6 : gap));
        box.addView(inputView, new LL.LayoutParams(MATCH, WRAP));
        return box;
    }

    /* ================= 系统栏 ================= */

    function dimen(name, fallback) {
        try {
            const id = ctx().getResources().getIdentifier(name, "dimen", "android");
            return id > 0 ? ctx().getResources().getDimensionPixelSize(id) : fallback;
        } catch (e) { return fallback; }
    }
    function statusBarHeight() { return dimen("status_bar_height", 80); }
    function navigationBarHeight() { return dimen("navigation_bar_height", 0); }

    /**
     * 非沉浸式：内容从状态栏下方开始，避免再叠加一层状态栏高度的空白
     * @param {Object} o { window, theme, mainCol }
     */
    function applySystemBars(o) {
        o = o || {};
        const t = o.theme || T();
        const win = o.window;
        const bg = pageBg(t);

        if (win) {
            try { win.setStatusBarColor(C(bg)); } catch (e) {}
            try { win.setNavigationBarColor(C(bg)); } catch (e) {}
            try {
                const dv = win.getDecorView();
                let f = dv.getSystemUiVisibility()
                      & ~V.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                      & ~V.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
                if (!t.dark) {
                    f = f | V.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | V.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                } else {
                    f = f & ~V.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR & ~V.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
                dv.setSystemUiVisibility(f);
            } catch (e) {}
            try {
                const ic = win.getInsetsController();
                if (ic) ic.setSystemBarsAppearance(t.dark ? 0 : 24, 24);
            } catch (e) {}
        }
        try { ui.statusBarColor(C(bg)); } catch (e) {}

        if (o.mainCol) o.mainCol.setPadding(dp(16), dp(6), dp(16), dp(4));
    }

    /* ================= 面板（栈式 + 防穿透） ================= */

    let PANEL = null;

    function bindPanel(p) { PANEL = p; }

    /**
     * 创建栈式面板容器
     * 防穿透：给覆盖层设 clickable + 空 click，吃掉空白处的触摸，
     *         否则点空白会穿到底下的页面（见 随手记 里的 pickerPage 处理）
     */
    function createPanel(root) {
        const stack = [];

        const api = {
            open: function (builder) {
                const p = new FL(ctx());
                p.setBackgroundColor(C(pageBg()));

                // ← 防点击穿透：三件套缺一不可
                p.setClickable(true);
                p.setFocusable(true);
                p.setOnClickListener(function () {});

                const col = vbox(0);
                col.setClickable(true);      // 容器本身也吃掉点击
                p.addView(col, new FL.LayoutParams(MATCH, MATCH));

                builder(col, api);
                root.addView(p, new FL.LayoutParams(MATCH, MATCH));
                stack.push(p);
                return api;
            },
            close: function () {
                const p = stack.pop();
                if (p) { try { root.removeView(p); } catch (e) {} }
            },
            closeAll: function () {
                while (stack.length) api.close();
            },
            depth: function () { return stack.length; },
            root: function () { return stack[stack.length - 1] || null; },
        };

        bindPanel(api);
        return api;
    }

    /**
     * 绑定返回键 / 手势返回
     *  - 有面板：逐层关闭
     *  - 根页面：moveTaskToBack 回桌面，而不是 finish 回到 AutoJs6
     */
    function bindBack(panel) {
        try {
            ui.emitter.on("back_pressed", function (ev) {
                if (panel.depth() > 0) {
                    ev.consumed = true;
                    panel.close();
                    return;
                }
                ev.consumed = true;
                try { activity.moveTaskToBack(true); }
                catch (e) { try { activity.finish(); } catch (e2) {} }
            });
        } catch (e) { log("绑定返回键失败: " + e); }
    }

    /** 面板统一头部：‹ 标题 */
    function panelHeader(parent, title, onBack) {
        const h = hbox();
        h.setPadding(dp(8), dp(6), dp(16), dp(6));
        const back = tv("‹", 26, T().name, true);
        back.setPadding(dp(10), 0, dp(10), dp(2));
        back.setOnClickListener(function () {
            if (onBack) onBack();
            else if (PANEL) PANEL.close();
        });
        h.addView(back);
        h.addView(tv(title, 18, T().title, true));
        h.addView(spacer());
        parent.addView(h);
        parent.addView(line());
        return h;
    }

    /* ================= 选择器（替代 dialogs） ================= */

    function pickList(title, items, cur, onPick) {
        if (!PANEL) return;
        PANEL.open(function (col) {
            panelHeader(col, title);
            const box = scrollBox(16);
            items.forEach(function (t, i) {
                const r = hbox();
                r.setPadding(dp(14), dp(14), dp(14), dp(14));
                r.setBackground(UI.roundBg(T().card, 12));
                r.addView(tv(t, 15, T().name, i === cur));
                r.addView(spacer());
                if (i === cur) r.addView(tv("✓", 15, T().accent, true));
                r.setOnClickListener(function () {
                    PANEL.close();
                    onPick(i);
                });
                const lp = new LL.LayoutParams(MATCH, WRAP);
                lp.bottomMargin = dp(6);
                box.col.addView(r, lp);
            });
            col.addView(box.sv, new LL.LayoutParams(MATCH, 0, 1));
        });
    }

    function pickMulti(title, items, selectedIdx, onOk) {
        if (!PANEL) return;
        const sel = {};
        (selectedIdx || []).forEach(function (i) { sel[i] = true; });

        PANEL.open(function (col) {
            panelHeader(col, title);
            const box = scrollBox(16);

            items.forEach(function (t, i) {
                const r = hbox();
                r.setPadding(dp(14), dp(14), dp(14), dp(14));
                r.setBackground(UI.roundBg(T().card, 12));

                const mark = tv(sel[i] ? "✓" : "", 13, "#FFFFFF", true);
                mark.setGravity(G.CENTER);
                mark.setLayoutParams(new LL.LayoutParams(dp(22), dp(22)));
                const paint = function () {
                    mark.setText(sel[i] ? "✓" : "");
                    mark.setBackground(sel[i] ? UI.ovalBg(T().accent, null, 0)
                        : UI.ovalBg(null, T().sub, 2));
                };
                paint();

                r.addView(mark);
                r.addView(space(10, 0));
                r.addView(tv(t, 15, T().name));
                r.setOnClickListener(function () { sel[i] = !sel[i]; paint(); });

                const lp = new LL.LayoutParams(MATCH, WRAP);
                lp.bottomMargin = dp(6);
                box.col.addView(r, lp);
            });

            col.addView(box.sv, new LL.LayoutParams(MATCH, 0, 1));

            const bar = hbox();
            bar.setPadding(dp(16), dp(8), dp(16), dp(14));
            bar.addView(spacer());
            bar.addView(btn("完成", true, function () {
                const out = [];
                Object.keys(sel).forEach(function (k) { if (sel[k]) out.push(Number(k)); });
                PANEL.close();
                onOk(out);
            }));
            col.addView(bar);
        });
    }

    function askText(title, prefill, onOk, numeric) {
        if (!PANEL) return;
        PANEL.open(function (col) {
            panelHeader(col, title);
            const body = vbox(0);
            body.setPadding(dp(16), dp(14), dp(16), dp(16));

            const e = et("", prefill == null ? "" : String(prefill), true);
            if (numeric) e.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
            body.addView(e, new LL.LayoutParams(MATCH, WRAP));
            body.addView(space(0, 14));

            const bar = hbox();
            bar.addView(spacer());
            bar.addView(btn("取消", false, function () { PANEL.close(); }));
            bar.addView(space(8, 0));
            bar.addView(btn("确定", true, function () {
                const s = String(e.getText().toString() || "").trim();
                PANEL.close();
                onOk(s);
            }));
            body.addView(bar);
            col.addView(body);

            setTimeout(function () {
                try {
                    e.requestFocus();
                    const imm = ctx().getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
                    imm.showSoftInput(e, 0);
                } catch (err) {}
            }, 250);
        });
    }

    /* ================= 行式组件 ================= */

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

    /** 带勾选状态的行（事件页 / 多选列表复用） */
    function checkRow(parent, label, sub, checked, onToggle) {
        const r = hbox();
        r.setPadding(dp(12), dp(12), dp(12), dp(12));
        r.setBackground(UI.roundBg(T().card, 12));

        const mark = tv(checked ? "✓" : "", 13, "#FFFFFF", true);
        mark.setGravity(G.CENTER);
        mark.setLayoutParams(new LL.LayoutParams(dp(22), dp(22)));
        let on = !!checked;
        const paint = function () {
            mark.setText(on ? "✓" : "");
            mark.setBackground(on ? UI.ovalBg(T().accent, null, 0) : UI.ovalBg(null, T().sub, 2));
        };
        paint();

        r.addView(mark);
        r.addView(space(10, 0));

        const mid = vbox(0);
        mid.addView(tv(label, 14, T().name, true));
        if (sub) mid.addView(tv(sub, 9, T().sub));
        r.addView(mid, new LL.LayoutParams(0, WRAP, 1));

        const tail = tv("", 11, T().sub);
        r.addView(tail);

        r.setOnClickListener(function () {
            on = !on;
            paint();
            if (onToggle) onToggle(on);
        });

        const lp = new LL.LayoutParams(MATCH, WRAP);
        lp.bottomMargin = dp(6);
        parent.addView(r, lp);
        return { view: r, tail: tail, isOn: function () { return on; } };
    }

    /** 图标选择行 */
    function iconRow(parent, cur, setter, label, presets) {
        const r = hbox();
        r.setBackground(UI.roundBg(T().card2, 12));
        r.setPadding(dp(12), dp(11), dp(12), dp(11));
        r.addView(tv(label || "图标", 13, T().name), new LL.LayoutParams(0, WRAP, 1));

        const val = tv(cur || "默认", 13, cur ? T().accent : T().sub);
        r.addView(val);
        r.addView(tv(" ›", 14, T().sub));

        let curV = cur || "";
        function refresh(v) {
            val.setText(v || "默认");
            val.setTextColor(C(v ? T().accent : T().sub));
        }

        r.setOnClickListener(function () {
            const LIST = presets || ["（默认）", "手动输入…"];
            let idx = LIST.indexOf(curV);
            if (idx < 0) idx = 0;
            pickList("选择图标", LIST, idx, function (i) {
                if (i === 0) { curV = ""; setter(""); refresh(""); return; }
                if (i === LIST.length - 1) {
                    askText("图标名", curV || "", function (s) {
                        curV = String(s || "").trim();
                        setter(curV);
                        refresh(curV);
                    });
                    return;
                }
                curV = LIST[i];
                setter(curV);
                refresh(curV);
            });
        });
        parent.addView(r);
        return r;
    }

    /* ================= 应用选择 ================= */

    function listLauncherApps(includeSystem) {
        const pm = ctx().getPackageManager();
        const it = new android.content.Intent(android.content.Intent.ACTION_MAIN);
        it.addCategory(android.content.Intent.CATEGORY_LAUNCHER);
        const list = pm.queryIntentActivities(it, 0);
        const seen = {}, out = [];
        list.forEach(function (ri) {
            const pkg = String(ri.activityInfo.packageName);
            if (seen[pkg]) return;
            seen[pkg] = true;
            if (!includeSystem && (ri.activityInfo.applicationInfo.flags
                & android.content.pm.ApplicationInfo.FLAG_SYSTEM) !== 0) return;
            out.push({ pkg: pkg, name: String(ri.loadLabel(pm)) });
        });
        out.sort(function (a, b) { return a.name.localeCompare(b.name, "zh"); });
        return out;
    }

    /**
     * 应用选择面板（单选 / 多选合一）
     * @param {Object} o
     *   multi    {boolean}  true=多选（底部完成按钮），false=点一行即选
     *   includeSystem {boolean}
     *   onDone   {Function} multi 时回调 picked 数组
     *   onPick   {Function} 单选时回调单个 app
     */
    function appPickPanel(o) {
        if (!PANEL) return;
        o = o || {};
        let incSys = !!o.includeSystem;
        let apps = listLauncherApps(incSys);
        const selected = {};

        PANEL.open(function (col) {
            panelHeader(col, o.multi ? "选择应用（可多选）" : "选择应用");

            const search = et("搜索应用", "", true);

            // 「含系统应用」开关：默认关，打开后连同 FLAG_SYSTEM 的应用一起列出
            const sysBtn = tv("含系统应用", 11, T().sub, false);
            sysBtn.setGravity(G.CENTER);
            sysBtn.setPadding(dp(10), dp(8), dp(10), dp(8));
            const paintSysBtn = function () {
                sysBtn.setTextColor(C(incSys ? (T().dark ? "#04231A" : "#FFFFFF") : T().sub));
                sysBtn.setBackground(incSys ? UI.roundBg(T().accent, 10) : UI.roundBg(T().card2, 10));
            };
            paintSysBtn();

            const sw = hbox();
            sw.setPadding(dp(16), dp(8), dp(16), dp(8));
            sw.addView(search, new LL.LayoutParams(0, WRAP, 1));
            sw.addView(space(8, 0));
            sw.addView(sysBtn);
            col.addView(sw);

            const box = scrollBox(16);
            box.col.setPadding(dp(16), 0, dp(16), dp(12));
            col.addView(box.sv, new LL.LayoutParams(MATCH, 0, 1));

            let doneBtn = null;

            function countSel() {
                let n = 0;
                for (let k in selected) if (selected[k]) n++;
                return n;
            }

            function renderList() {
                const kw = String(search.getText().toString() || "").trim().toLowerCase();
                box.col.removeAllViews();
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

                    if (o.multi) {
                        const on = !!selected[a.pkg];
                        const mark = tv(on ? "✓" : "", 13, "#FFFFFF", true);
                        mark.setGravity(G.CENTER);
                        mark.setLayoutParams(new LL.LayoutParams(dp(22), dp(22)));
                        mark.setBackground(on ? UI.ovalBg(T().accent, null, 0)
                            : UI.ovalBg(null, T().sub, 2));
                        r.addView(mark);
                    } else {
                        r.addView(tv("›", 15, T().sub));
                    }

                    r.setOnClickListener(function () {
                        if (!o.multi) {
                            PANEL.close();
                            if (o.onPick) o.onPick(a);
                            return;
                        }
                        selected[a.pkg] = !selected[a.pkg];
                        renderList();
                        if (doneBtn) doneBtn.setText("完成 (" + countSel() + ")");
                    });

                    const lp = new LL.LayoutParams(MATCH, WRAP);
                    lp.bottomMargin = dp(6);
                    box.col.addView(r, lp);
                });

                if (!shown) {
                    const e = tv("没有匹配的应用", 13, T().sub);
                    e.setGravity(G.CENTER);
                    e.setPadding(0, dp(30), 0, 0);
                    box.col.addView(e);
                }
            }

            sysBtn.setOnClickListener(function () {
                incSys = !incSys;
                paintSysBtn();
                apps = listLauncherApps(incSys);
                renderList();
                if (doneBtn) doneBtn.setText("完成 (" + countSel() + ")");
            });

            search.addTextChangedListener(new JavaAdapter(android.text.TextWatcher, {
                afterTextChanged: function () { renderList(); },
                beforeTextChanged: function () {},
                onTextChanged: function () {},
            }));

            if (o.multi) {
                const bar = hbox();
                bar.setPadding(dp(16), dp(8), dp(16), dp(12));
                bar.addView(tv("勾选后完成", 10, T().sub));
                bar.addView(spacer());
                doneBtn = btn("完成 (0)", true, function () {
                    const picked = apps.filter(function (a) { return selected[a.pkg]; });
                    PANEL.close();
                    if (o.onDone) o.onDone(picked);
                });
                bar.addView(doneBtn);
                col.addView(bar);
            }

            renderList();
        });
    }

    /* ================= 文件选择 ================= */

    function filePicker(onPick, startDir) {
        if (!PANEL) return;
        let dir = startDir || SCRIPT_ROOT;

        PANEL.open(function (col) {
            panelHeader(col, "选择脚本");

            const pathTv = tv("", 10, T().sub);
            pathTv.setPadding(dp(18), dp(6), dp(18), dp(6));
            col.addView(pathTv);

            const box = scrollBox(16);
            box.col.setPadding(dp(16), 0, dp(16), dp(20));
            col.addView(box.sv, new LL.LayoutParams(MATCH, 0, 1));

            function rowItem(name, isDir, onTap) {
                const r = hbox();
                r.setPadding(dp(12), dp(11), dp(12), dp(11));
                r.setBackground(UI.roundBg(T().card, 12));
                r.addView(tv(isDir ? ("▸ " + name) : name, 14, T().name, isDir));
                r.setOnClickListener(function () { onTap(); });
                const lp = new LL.LayoutParams(MATCH, WRAP);
                lp.bottomMargin = dp(6);
                box.col.addView(r, lp);
            }

            function renderList() {
                pathTv.setText(dir);
                box.col.removeAllViews();

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
                        PANEL.close();
                        onPick(p);
                    });
                });

                if (!dirs.length && !fs.length) {
                    const e = tv("（此目录没有 .js 文件）", 12, T().sub);
                    e.setPadding(dp(12), dp(20), 0, 0);
                    box.col.addView(e);
                }
            }
            renderList();
        });
    }

    /* ================= 导出（UI模块 + 扩展） ================= */

    const api = {};
    for (let k in UI) { try { api[k] = UI[k]; } catch (e) {} }

    api.pageBg = pageBg;
    api.vbox = vbox; api.hbox = hbox; api.tv = tv; api.et = et; api.btn = btn;
    api.pill = pill; api.line = line; api.space = space; api.spacer = spacer;
    api.card = card; api.scroll = scroll; api.scrollBox = scrollBox; api.field = field;

    api.applySystemBars = applySystemBars;
    api.statusBarHeight = statusBarHeight;
    api.navigationBarHeight = navigationBarHeight;

    api.createPanel = createPanel; api.bindPanel = bindPanel; api.bindBack = bindBack;
    api.panelHeader = panelHeader;

    api.pickList = pickList; api.askText = askText; api.pickMulti = pickMulti;

    api.sectionLabel = sectionLabel; api.settingRow = settingRow;
    api.checkRow = checkRow; api.iconRow = iconRow;

    api.listLauncherApps = listLauncherApps;
    api.appPickPanel = appPickPanel;
    api.filePicker = filePicker;

    api.MATCH = MATCH; api.WRAP = WRAP; api.G = G; api.V = V;
    api.LL = LL; api.FL = FL; api.TV = TV; api.ET = ET; api.SV = SV;

    return api;
})();
