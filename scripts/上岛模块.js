/**
 * 上岛模块.js —— 与「上岛验证」App 通信的完整封装（AutoJs6）
 *
 * 能力：
 *   show(opt)              上岛/更新内容（支持 0~3 个按钮，每个带图标）
 *   hide()                 下岛（停止服务、移除通知）
 *   on(key, fn)            定义某个按钮 key 的处理函数
 *   start()                开始监听按钮点击（会自动保活脚本）
 *   stop()                 停止监听并注销
 *
 * 用法：
 *   const island = require("./上岛模块.js");
 *
 *   // 定义按钮行为（key 与 show 里 actions 的 key 对应）
 *   island.on("pause", function (key, title) {
 *       toast("点了暂停");
 *   });
 *   island.on("cancel", function () {
 *       island.hide();
 *   });
 *
 *   // 需要接收按钮点击时才调用（不需要就跳过）
 *   island.start();
 *
 *   // 上岛
 *   island.show({
 *       title: "下载中",
 *       text: "正在下载 3/10",
 *       short: "下载中",
 *       actions: [
 *           { title: "暂停", key: "pause", icon: "bear" },
 *           { title: "取消", key: "cancel", icon: "cat" }
 *       ]
 *   });
 *
 *   island.hide();
 */

module.exports = (function () {

    // ===== 与 App 约定的常量 =====
    var PKG = "com.example.liveupdateverify";
    var ACTION_UPDATE = "com.liveupdate.verify.UPDATE";
    var ACTION_STOP = "com.liveupdate.verify.STOP";
    var ACTION_FROM_APP = "com.liveupdate.verify.FROM_APP";

    var MAX_SHORT = 4;      // 胶囊最多 4 个中文字
    var MAX_ACTIONS = 3;    // 当前 App 版本最多 3 个按钮（Android 系统上限）

    // ===== 内部状态 =====
    var handlers = {};       // key -> function
    var receiver = null;
    var keepAliveTimer = null;

    /** 截断字符串到 n 个字符 */
    function cut(s, n) {
        s = (s === null || s === undefined) ? "" : String(s);
        return s.length > n ? s.substring(0, n) : s;
    }

    /**
     * 上岛 / 更新内容
     * @param {Object} opt
     *   title   {string}
     *   text    {string}
     *   short   {string} 胶囊短文字（自动截断到 4 字）
     *   icon    {string} 通知小图标名，默认 panda
     *   actions {Array}  [{ title, key, icon }]，最多 2 个
     */
    function show(opt) {
        opt = opt || {};
        var i = new android.content.Intent(ACTION_UPDATE);
        i.setPackage(PKG);
        i.putExtra("title", opt.title || "");
        i.putExtra("text", opt.text || "");
        i.putExtra("short", cut(opt.short, MAX_SHORT));
        if (opt.icon) i.putExtra("smallIcon", opt.icon);

        var acts = opt.actions || [];
        var n = Math.min(acts.length, MAX_ACTIONS);
        for (var k = 0; k < n; k++) {
            var a = acts[k] || {};
            var idx = k + 1;
            i.putExtra("action" + idx + "Title", a.title || "");
            i.putExtra("action" + idx + "Key", a.key || "");
            if (a.icon) i.putExtra("action" + idx + "Icon", a.icon);
        }
        context.sendBroadcast(i);
    }

    /** 下岛：移除通知、停止前台服务 */
    function hide() {
        var i = new android.content.Intent(ACTION_STOP);
        i.setPackage(PKG);
        context.sendBroadcast(i);
    }

    /**
     * 定义按钮回调
     * @param {string} key   与 show 里 actions[].key 一致
     * @param {Function} fn  回调 function(key, title)
     * 特殊：on("*", fn) 可注册兜底回调
     */
    function on(key, fn) {
        handlers[key] = fn;
        return api;
    }

    /** 开始监听按钮点击（自动保活脚本，重复调用不会重复注册） */
    function start() {
        if (receiver) return api;

        receiver = new JavaAdapter(android.content.BroadcastReceiver, {
            onReceive: function (ctx, i) {
                var key = null;
                var title = null;
                try {
                    key = i.getStringExtra("key");
                    title = i.getStringExtra("title");
                    if (key && handlers[key]) {
                        handlers[key](key, title);
                    } else if (handlers["*"]) {
                        handlers["*"](key, title);
                    } else {
                        log("上岛：收到未定义的 key=" + key);
                    }
                } catch (e) {
                    log("上岛 onReceive 异常: " + e);
                }
            }
        });

        var filter = new android.content.IntentFilter(ACTION_FROM_APP);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, 2); // RECEIVER_EXPORTED
        } else {
            context.registerReceiver(receiver, filter);
        }

        // 关键：保持脚本运行，否则监听会随脚本结束失效
        if (!keepAliveTimer) {
            keepAliveTimer = setInterval(function () {}, 1000);
        }

        // 退出时自动注销，避免残留注册
        events.on("exit", function () {
            stop();
        });

        return api;
    }

    /** 停止监听并注销 */
    function stop() {
        try {
            if (receiver) context.unregisterReceiver(receiver);
        } catch (e) { }
        receiver = null;

        try {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
        } catch (e) { }
        keepAliveTimer = null;
    }

    /** 一键收工：下岛 + 注销监听 + 结束脚本 */
    function quit() {
        hide();
        stop();
        setTimeout(function () {
            try { exit(); } catch (e) { }
        }, 200);
    }

    var api = {
        PKG: PKG,
        show: show,
        hide: hide,
        on: on,
        start: start,
        stop: stop,
        quit: quit
    };
    return api;

})();
