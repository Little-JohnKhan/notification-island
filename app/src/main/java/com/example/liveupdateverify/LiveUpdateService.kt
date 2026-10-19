package com.example.liveupdateverify

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * 前台服务（上岛的硬前提）。
 *
 * 两种状态，始终是同一条通知、同一个 NOTIF_ID：
 *  - 待命态：上岛服务待命 / 等待脚本指令 / 待命中（无按钮）
 *  - 显示态：广播 com.liveupdate.verify.UPDATE 的 title/text/short（0~3 个按钮）
 *
 * 所有通知都由 NotificationFactory.buildNotification() 构建，本类不直接 new Builder。
 */
class LiveUpdateService : Service() {

    // ★ 全类唯一的伴生对象：所有常量、instance、parseExtras 都在这里 ★
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

    /** 当前显示内容；null = 待命态 */
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
                stopAndRemove()
                return START_NOT_STICKY
            }

            ACTION_UPDATE -> {
                // 服务未运行时被 Receiver 拉起：立刻展示这条通知
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

    /** 待命态（默认）：全部提升条件同样满足，不显示按钮 */
    fun showIdle() {
        current = null
        postNotification(NotificationFactory.buildNotification(this, CHANNEL_ID, idleData()))
    }

    /** 供 UpdateReceiver 同步内存状态（通知本身由 Receiver 构建并调用 postNotification） */
    fun updateCurrentData(data: NotifyData) {
        current = data
    }

    /**
     * 刷新当前通知（待命态则刷新待命态）。
     * 供“刷新诊断”“按钮点击后刷新”等路径复用，保证永远走同一条构建路径。
     */
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

    /** 停止 / 下岛 */
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
