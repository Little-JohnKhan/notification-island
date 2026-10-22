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
 *  - 待命态：上岛服务待命 / 等待脚本指令（会被提升为岛）
 *  - 显示态：广播 com.liveupdate.verify.UPDATE 的 title/text/short（0~3 个按钮）
 *  - 静默态：STOP 之后的状态 —— **服务保持运行**，通知不申请 promoted，因此不上岛
 *
 * 关键改动（相对旧版）：
 *  STOP 不再 stopSelf()。停掉前台服务会让 App 失去后台优先级，
 *  被系统冻结后就再也收不到/起不了后续的 UPDATE，表现为「岛彻底不再出现，
 *  直到手动点开 App」。现在 STOP 只把通知换成静默态，服务常驻。
 *
 * 所有「上岛」通知都由 NotificationFactory.buildNotification() 构建，本类不直接 new Builder；
 * 只有静默态通知由本类自建（刻意不调用 setRequestPromotedOngoing）。
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

    private fun idleData() = NotifyData(
        title = getString(R.string.idle_title),   // 上岛服务待命
        text = getString(R.string.idle_text),     // 等待脚本指令
        short = getString(R.string.idle_short)    // 待命中
    )

    /** 待命态（会被提升为岛，用于开机后等待第一条指令） */
    fun showIdle() {
        current = null
        postNotification(NotificationFactory.buildNotification(this, CHANNEL_ID, idleData()))
    }

    /**
     * 静默态：收到 STOP 后调用。
     *
     * 与前者的区别只有一点：**不申请 promoted**，所以不会出现在状态栏胶囊里，
     * 但前台服务继续存活，App 保持高优先级，后续 UPDATE 立刻可用。
     *
     * 通知栏里会留下一条「待命」提示 —— 这是前台服务的硬性要求，无法隐藏。
     */
    fun demoteToIdle() {
        current = null
        try {
            val n = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(applicationInfo.icon)
                .setContentTitle(getString(R.string.idle_title))
                .setContentText(getString(R.string.idle_text))
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .build()
            postNotification(n)
            Log.i(TAG, "已降级为静默待命（服务保留）")
        } catch (t: Throwable) {
            Log.e(TAG, "demote 失败（已忽略）: ${t.javaClass.simpleName}", t)
        }
    }

    /** 供 UpdateReceiver 同步内存状态（通知本身由 Receiver 构建并调用 postNotification） */
    fun updateCurrentData(data: NotifyData) {
        current = data
    }

    /** 刷新当前通知（待命态则刷新待命态） */
    fun refreshNotification() {
        val data = current ?: idleData()
        postNotification(NotificationFactory.buildNotification(this, CHANNEL_ID, data))
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
