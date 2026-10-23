package com.example.liveupdateverify

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * 前台服务（上岛的硬前提）。
 *
 * 三种状态，始终是同一条通知、同一个 NOTIF_ID：
 *  - 待命态：上岛服务待命 / 等待脚本指令（**不上岛**，只占通知栏）
 *  - 显示态：广播 com.liveupdate.verify.UPDATE 的 title/text/short（0~3 个按钮，会上岛）
 *  - 静默态：STOP 之后的状态 —— **服务保持运行**，通知不申请 promoted，因此不上岛
 *
 * 关键改动一（相对旧版）：
 *  STOP 不再 stopSelf()。停掉前台服务会让 App 失去后台优先级，
 *  被系统冻结后就再也收不到/起不了后续的 UPDATE，表现为「岛彻底不再出现，
 *  直到手动点开 App」。现在 STOP 只把通知换成静默态，服务常驻。
 *
 * 关键改动二：
 *  待命态也不再申请 promoted。旧版 onStartCommand 走 showIdle() 时会把
 *  「待命中」提升成胶囊，于是「打开 App」「进程被系统重启（START_STICKY + intent=null）」
 *  这两种情况都会在岛上冒出一条 App 原生通知，看起来像脚本失效。
 *  现在只有真正带着脚本内容（ACTION_UPDATE）的通知才会上岛。
 *
 * 所有「上岛」通知都由 NotificationFactory.buildNotification() 构建，本类不直接 new Builder；
 * 待命/静默通知由本类自建（刻意不调用 setRequestPromotedOngoing）。
 */
class LiveUpdateService : Service() {

    companion object {
        private const val TAG = "LiveUpdateService"

        // 渠道 ID 与已验证版本一致（重要级别创建后不可变）
        const val CHANNEL_ID = "live_update_verify_channel_v1"
        const val NOTIF_ID = 1001

        // 内部指令
        const val ACTION_START = "com.example.liveupdateverify.action.START"
        const val ACTION_STOP = "com.liveupdate.verify.STOP"

        // 脚本 → App
        const val ACTION_UPDATE = "com.liveupdate.verify.UPDATE"

        // App → 脚本
        const val ACTION_FROM_APP = "com.liveupdate.verify.FROM_APP"

        // 脚本 → App 的 extras
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        const val EXTRA_SHORT = "short"
        const val EXTRA_SMALL_ICON = "smallIcon"
        const val EXTRA_ACTION1_TITLE = "action1Title"
        const val EXTRA_ACTION1_KEY = "action1Key"
        const val EXTRA_ACTION1_ICON = "action1Icon"
        const val EXTRA_ACTION2_TITLE = "action2Title"
        const val EXTRA_ACTION2_KEY = "action2Key"
        const val EXTRA_ACTION2_ICON = "action2Icon"
        const val EXTRA_ACTION3_TITLE = "action3Title"
        const val EXTRA_ACTION3_KEY = "action3Key"
        const val EXTRA_ACTION3_ICON = "action3Icon"

        // App → 脚本 的 extras
        const val EXTRA_EVENT = "event"
        const val EXTRA_KEY = "key"
        const val EVENT_ACTION_CLICKED = "action_clicked"

        /**
         * 同进程内的服务实例：UpdateReceiver 用它直接 startForeground 更新通知，
         * 避免依赖 Activity，也避免从后台再拉起 FGS。
         */
        @Volatile
        var instance: LiveUpdateService? = null
            private set

        /** 从 Intent 解析通知内容（Receiver 与 Service 共用同一套字段名） */
        fun parseExtras(intent: Intent): NotifyData = NotifyData(
            title = intent.getStringExtra(EXTRA_TITLE).orEmpty(),
            text = intent.getStringExtra(EXTRA_TEXT).orEmpty(),
            short = intent.getStringExtra(EXTRA_SHORT).orEmpty(),
            smallIconName = intent.getStringExtra(EXTRA_SMALL_ICON),
            action1Title = intent.getStringExtra(EXTRA_ACTION1_TITLE),
            action1Key = intent.getStringExtra(EXTRA_ACTION1_KEY),
            action1Icon = intent.getStringExtra(EXTRA_ACTION1_ICON),
            action2Title = intent.getStringExtra(EXTRA_ACTION2_TITLE),
            action2Key = intent.getStringExtra(EXTRA_ACTION2_KEY),
            action2Icon = intent.getStringExtra(EXTRA_ACTION2_ICON),
            action3Title = intent.getStringExtra(EXTRA_ACTION3_TITLE),
            action3Key = intent.getStringExtra(EXTRA_ACTION3_KEY),
            action3Icon = intent.getStringExtra(EXTRA_ACTION3_ICON)
        )
    }

    /** 当前显示内容；null = 待命/静默 */
    @Volatile
    private var current: NotifyData? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        logExitReasons()
    }

    /**
     * 诊断：把系统记录的历史进程退出原因写进日志，用来回答「App 为什么被杀」。
     *
     * 只在服务真正新建时打印（进程重启才算一次），所以日志里出现几条，
     * 就说明进程在本次安装后被启动过几次 —— 每次启动都对应一次「被杀/自启」。
     * 重点看 reason：2=被信号杀死（LMK 或 ROM 强杀）、14=被冻结、3=低内存。
     */
    private fun logExitReasons() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        try {
            val am = getSystemService(android.app.ActivityManager::class.java) ?: return
            val list = am.getHistoricalProcessExitReasons(packageName, 0, 5)
            if (list.isEmpty()) {
                Log.i(TAG, "进程退出历史：无记录（本次是首次启动）")
                return
            }
            val sdf = java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.getDefault())
            for (info in list) {
                val why = when (info.reason) {
                    1 -> "主动退出"
                    2 -> "被信号杀死 signal=${info.status}"
                    3 -> "低内存"
                    4 -> "Java 崩溃"
                    5 -> "Native 崩溃"
                    6 -> "ANR"
                    7 -> "初始化失败"
                    8 -> "权限变更"
                    9 -> "资源占用过高"
                    10 -> "用户请求"
                    11 -> "用户强行停止"
                    12 -> "依赖进程死亡"
                    14 -> "被冻结 Freezer"
                    15 -> "包状态变更"
                    16 -> "App 更新"
                    else -> "其他(${info.reason})"
                }
                Log.i(TAG, "进程退出历史：${sdf.format(java.util.Date(info.timestamp))}  $why")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "读退出历史失败（已忽略）: ${t.javaClass.simpleName}")
        }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // ★ 只降级，不停服务
                demoteToIdle()
            }

            ACTION_UPDATE -> {
                // 服务被 Receiver 拉起：立刻展示这条通知
                val data = parseExtras(intent)
                current = data
                postNotification(NotificationFactory.buildNotification(this, CHANNEL_ID, data))
            }

            else -> {
                // 首次启动 / 开机自启 / 界面回到前台：
                // 已有内容就保持（避免打开 App 把脚本内容冲掉），否则进入待命态
                val c = current
                if (c != null) {
                    postNotification(NotificationFactory.buildNotification(this, CHANNEL_ID, c))
                } else {
                    showIdle()
                }
            }
        }
        return START_STICKY
    }

    /**
     * 待命态：没有任何脚本内容时显示。
     *
     * ★ 不申请 promoted，所以不会上岛。旧版这里是会长出原生胶囊的，
     * 于是「打开 App」「进程被系统重启」都会在岛上冒出一条「待命中」。
     */
    fun showIdle() {
        postSilentIdle()
    }

    /**
     * 静默态：收到 STOP 后调用，语义上是「脚本主动要求下岛」。
     * 实现与 [showIdle] 完全相同 —— 都是不带 promoted 的 FGS 占位通知。
     */
    fun demoteToIdle() {
        postSilentIdle()
    }

    /**
     * 待命 / 静默共用：一条不上岛的常驻通知。
     *
     * 不上岛的唯一原因是**不调用 setRequestPromotedOngoing / setCriticalText**，
     * 与渠道、优先级无关（已验证：渠道和 NOTIF_ID 全程不变）。
     *
     * 注意：刻意不加 setPriority(PRIORITY_MIN)。Android 8+ 的优先级由渠道决定，
     * 这两行无效；而且把前台服务通知压到最低，部分 ROM 会把进程判定为低价值，
     * 反而更容易被清理。
     */
    private fun postSilentIdle() {
        current = null
        try {
            val n = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(applicationInfo.icon)
                .setContentTitle(getString(R.string.idle_title))
                .setContentText(getString(R.string.idle_text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .build()
            postNotification(n)
            Log.i(TAG, "进入静默待命（服务保留，不上岛）")
        } catch (t: Throwable) {
            Log.e(TAG, "写静默待命失败（已忽略）: ${t.javaClass.simpleName}", t)
        }
    }

    /** 供 UpdateReceiver 同步内存状态（通知本身由 Receiver 构建并调用 postNotification） */
    fun updateCurrentData(data: NotifyData) {
        current = data
    }

    /** 刷新当前通知（无内容时刷新静默占位，不会上岛） */
    fun refreshNotification() {
        val data = current
        if (data == null) postSilentIdle()
        else postNotification(NotificationFactory.buildNotification(this, CHANNEL_ID, data))
    }

    /**
     * 真正把通知挂到前台服务上。
     * 同一个 NOTIF_ID 再次调用 = 更新通知，提升标记保持不变。
     */
    fun postNotification(notification: Notification) {
        try {
            NotificationFactory.ensureChannel(this, CHANNEL_ID)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) { // 34
                startForeground(
                    NOTIF_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "startForeground 失败（已忽略）: ${t.javaClass.simpleName}", t)
        }
    }

    /**
     * 真正停止服务（彻底退出，不再保活）。
     * 仅用于用户明确要关闭 App 的场景，脚本的 STOP 不再走这里。
     */
    fun stopAndRemove() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (t: Throwable) {
            Log.w(TAG, "stopForeground 失败（已忽略）: ${t.javaClass.simpleName}")
        }
        current = null
        stopSelf()
    }
}
