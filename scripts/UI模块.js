/**
 * UI模块.js —— 通用 UI 构件（灵动岛 / 卡片 / 列表 都能用）
 * ------------------------------------------------------------------
 * 用法：
 *   const UI = require("/storage/emulated/0/脚本/常用模块/UI模块.js");
 *   UI.setContext(auto.service);        // 可选；不设时自动用全局 context
 *   const T = UI.theme();               // 深浅自适应配色，用的时候现取
 *   v.setBackground(UI.roundBg(T.card, 16));      // 圆角按 dp
 *   v.setBackground(UI.roundBgPx(T.card, 90));    // 圆角按 px
 * 提供：C / dp / isNight / theme /
 *       roundBg(r=dp) / roundBgPx(r=px) / strokeBg / ovalBg / solidBg /
 *       divider / progressBar / pillButton / swipeToReveal
 *
 * 注意：整体用 IIFE 包起来 —— 否则模块顶层的 const/let 会和「引用它的
 *       主脚本」的同名声明冲突（AutoJs6 require 会报「变量重复声明」）。
 * ------------------------------------------------------------------
 */
module.exports = (function () {

    let CTX = null;
    function ctx() { if (CTX) return CTX; try { return context; } catch (e) { return null; } }
    function setContext(c) { CTX = c; }

    const MATCH = android.view.ViewGroup.LayoutParams.MATCH_PARENT;
    const WRAP  = android.view.ViewGroup.LayoutParams.WRAP_CONTENT;
    const G     = android.view.Gravity;
    const LL    = android.widget.LinearLayout;
    const FL    = android.widget.FrameLayout;
    const TV    = android.widget.TextView;
    const V     = android.view.View;

    function C(hex) { return android.graphics.Color.parseColor(hex); }
    function dp(v) { return Math.round(v * ctx().getResources().getDisplayMetrics().density); }

    function isNight() {
        try {
            let cfg = ctx().getResources().getConfiguration();
            return (cfg.uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                === android.content.res.Configuration.UI_MODE_NIGHT_YES;
        } catch (e) { return false; }
    }

    // —— 深浅自适应配色（换皮只改这里）——
    function theme() {
        return isNight() ? {
            dark: true,
            card: "#1C1C1E", card2: "#2A2A2D",
            title: "#FFFFFF", name: "#F2F2F7", sub: "#9A9A9E",
            divider: "#2E2E31", track: "#2E2E31",
            accent: "#34D399", onAccent: "#04231A",
            todo: "#F0B429",
            danger: "#E5484D", onDanger: "#FFFFFF"
        } : {
            dark: false,
            card: "#FFFFFF", card2: "#F4F4F6",
            title: "#141418", name: "#16161A", sub: "#8A8A8D",
            divider: "#ECECEE", track: "#EDEDF0",
            accent: "#12B76A", onAccent: "#FFFFFF",
            todo: "#E0A106",
            danger: "#E5484D", onDanger: "#FFFFFF"
        };
    }

    // —— 背景 ——
    function roundBg(hex, r) {          // 圆角 r 按 dp
        let d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        d.setColor(C(hex)); d.setCornerRadius(dp(r));
        return d;
    }
    function roundBgPx(hex, px) {       // 圆角直接用像素（灵动岛那套参数是 px 制，用这个）
        let d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        d.setColor(C(hex)); d.setCornerRadius(px);
        return d;
    }
    function solidBg(hex) { return new android.graphics.drawable.ColorDrawable(C(hex)); }
    function strokeBg(strokeHex, w, r) {
        let d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
        d.setColor(android.graphics.Color.TRANSPARENT);
        d.setStroke(dp(w), C(strokeHex)); d.setCornerRadius(dp(r));
        return d;
    }
    function ovalBg(fillHex, strokeHex, strokeW) {
        let d = new android.graphics.drawable.GradientDrawable();
        d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        d.setColor(fillHex ? C(fillHex) : android.graphics.Color.TRANSPARENT);
        if (strokeHex) d.setStroke(dp(strokeW), C(strokeHex));
        return d;
    }

    // —— 分隔线 ——
    function divider(hex, widthDp, vertical) {
        let v = new V(ctx());
        v.setBackground(solidBg(hex));
        if (vertical) v.setLayoutParams(new LL.LayoutParams(dp(widthDp || 1), MATCH));
        else v.setLayoutParams(new LL.LayoutParams(MATCH, dp(widthDp || 1)));
        return v;
    }

    // —— 胶囊小按钮 ——
    function pillButton(text, bgHex, txtHex, size, padH, padV) {
        let b = new TV(ctx());
        b.setText(text); b.setTextSize(size || 12);
        b.setTextColor(C(txtHex)); b.setGravity(G.CENTER);
        b.setBackground(roundBg(bgHex, 999));
        b.setPadding(dp(padH || 12), dp(padV || 5), dp(padH || 12), dp(padV || 5));
        return b;
    }

    // —— 进度条：返回 { view, set(ratio) } ——
    function progressBar(T, hDp) {
        let track = new FL(ctx());
        track.setBackground(roundBg(T.track, (hDp || 6) / 2));
        let fill = new V(ctx());
        fill.setBackground(roundBg(T.accent, (hDp || 6) / 2));
        track.addView(fill, new FL.LayoutParams(0, MATCH));
        function setRatio(ratio) {
            ratio = Math.max(0, Math.min(1, ratio || 0));
            let w = track.getWidth();
            if (w <= 0) { track.post(function () { setRatio(ratio); }); return; }
            let lp = fill.getLayoutParams();
            lp.width = Math.max(1, Math.round(w * ratio));
            fill.setLayoutParams(lp);
        }
        return { view: track, set: setRatio };
    }

    /**
     * 左滑露出操作按钮（从「任务列表」抽出来的通用件）
     *   content : 上层可滑动视图（如卡片面板）
     *   acts    : 右侧操作按钮数组（View[]，自己设好宽高与点击）
     *   opts    : { actWidth(默认64), gap(默认6), slop(默认8), onTap, onSwipe }
     *             onTap : 点击（没滑动）时回调 → onTap()
     *             onSwipe : 判定为滑动的那一刻回调一次 → onSwipe()
     * 返回 outer（FrameLayout，可直接 addView）
     */
    function swipeToReveal(content, acts, opts) {
        opts = opts || {};
        const ME = android.view.MotionEvent;
        const ACT_W = opts.actWidth || 64;
        const GAP   = opts.gap || 6;
        const SLOP  = opts.slop || 8;

        let actsW = dp((ACT_W + GAP) * acts.length);
        let bar = new LL(ctx());
        bar.setOrientation(LL.HORIZONTAL);
        bar.setGravity(G.RIGHT | G.CENTER_VERTICAL);
        let blp = new FL.LayoutParams(actsW, MATCH);
        blp.gravity = G.RIGHT | G.CENTER_VERTICAL;
        bar.setLayoutParams(blp);
        for (let i = 0; i < acts.length; i++) {
            let b = acts[i];
            let lp = new LL.LayoutParams(dp(ACT_W), MATCH);
            lp.leftMargin = dp(GAP);
            b.setLayoutParams(lp);
            bar.addView(b);
        }

        let outer = new FL(ctx());
        outer.addView(bar);
        outer.addView(content, new FL.LayoutParams(MATCH, MATCH));

        let st = { downX: 0, downY: 0, baseX: 0, active: false };
        function settle(target) {
            content.animate().translationX(target).setDuration(150).start();
        }
        content.setOnTouchListener(function (view, event) {
            let a = event.getAction();
            if (a === ME.ACTION_DOWN) {
                st.downX = event.getRawX(); st.downY = event.getRawY();
                st.baseX = view.getTranslationX(); st.active = false;
                return true;
            } else if (a === ME.ACTION_MOVE) {
                let dx = event.getRawX() - st.downX, dy = event.getRawY() - st.downY;
                if (!st.active && Math.abs(dx) > dp(SLOP) && Math.abs(dx) > Math.abs(dy)) {
                    st.active = true;
                    try { view.getParent().requestDisallowInterceptTouchEvent(true); } catch (e) {}
                    if (opts.onSwipe) opts.onSwipe();      // 判定为滑动（不是点击）时回调一次
                }
                if (st.active) {
                    let nx = st.baseX + dx;
                    if (nx > 0) nx = 0;
                    if (nx < -actsW) nx = -actsW;
                    view.setTranslationX(nx);
                }
                return true;
            } else {
                if (st.active) {
                    settle(content.getTranslationX() < -actsW / 2 ? -actsW : 0);
                } else if (a === ME.ACTION_UP && opts.onTap) {
                    opts.onTap();
                }
                return true;
            }
        });
        return outer;
    }

    return {
        setContext: setContext,
        C: C, dp: dp, isNight: isNight, theme: theme,
        roundBg: roundBg, roundBgPx: roundBgPx, solidBg: solidBg, strokeBg: strokeBg, ovalBg: ovalBg,
        divider: divider, progressBar: progressBar, pillButton: pillButton, swipeToReveal: swipeToReveal
    };
})();
