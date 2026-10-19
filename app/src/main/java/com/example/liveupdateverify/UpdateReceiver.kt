package com.example.liveupdateverify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * 脚本 → App 的入口（Manifest 静态注册，exported=true，支持显式广播）。
 *
 *  - com.liveupdate.verify.UPDATE：★在 onReceive 内完成“重建通知 + 更新通知”★
 *  - com.liveupdate.verify.STOP  ：停止服务、移除通知（下岛）
 *
 * 另外承担 App → 脚本的转发：通知按钮的 PendingIntent 显式指向本 Receiver，
 * 这里再用 sendBroadcast 发出隐式广播 com.liveupdate.verify.FROM_APP 给脚本。
 *
 * 注意：本类不依赖 Activity 是否在前台，也不依赖“刷新诊断”。
 */
class UpdateReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        try {
            when (intent.action) {
                LiveUpdateService.ACTION_UPDATE -> handleUpdate(context, intent)
                LiveUpdateService.ACTION_STOP -> handleStop(context)
                LiveUpdateService.ACTION_FROM_APP -> forwardToScript(context, intent)
            }
        } catch (t: Throwable) {
            // 全程兜底：广播处理绝不崩溃
            Log.e(TAG, "onReceive 异常（已忽略）: ${t.javaClass.simpleName}", t)
        }
    }

    /**
     * 更新通知的全部工作都在这里完成：解析 → 构建 → startForeground 更新。
     * 不依赖 Activity、不需要打开界面、不需要“刷新诊断”。
     */
    private fun handleUpdate(context: Context, intent: Intent) {
        val data = LiveUpdateService.parseExtras(intent)

        // 界面日志：Activity 不在前台会先缓存，下次打开补显
        UiLog.add("收到广播 title=${data.title} short=${data.short}")

        val svc = LiveUpdateService.instance
        if (svc != null) {
            // 服务在运行：当场重建通知并 startForeground 更新（同一 ID）
            val notification =
                NotificationFactory.buildNotification(context, LiveUpdateService.CHANNEL_ID, data)
            svc.updateCurrentData(data)
            svc.postNotification(notification)
            Log.i(TAG, "已在后台直接更新通知: title=${data.title}, short=${data.short}")
            return
        }

        // 服务未运行：拉起服务，在 onStartCommand 中展示这条通知
        // （Android 12+ 后台启动 FGS 可能被拒，失败静默，不崩溃）
        try {
            val i = Intent(context, LiveUpdateService::class.java)
                .setAction(LiveUpdateService.ACTION_UPDATE)
            i.putExtras(intent) // 透传全部 extras
            ContextCompat.startForegroundService(context, i)
            Log.i(TAG, "服务未运行，已请求 startForegroundService")
        } catch (t: Throwable) {
            Log.w(TAG, "startForegroundService 失败（系统限制，已忽略）: ${t.javaClass.simpleName}")
        }
    }

    private fun handleStop(context: Context) {
        val svc = LiveUpdateService.instance
        if (svc != null) {
            svc.stopAndRemove()
            UiLog.add("收到广播 STOP，已停止服务（下岛）")
            return
        }
        try {
            context.startService(
                Intent(context, LiveUpdateService::class.java)
                    .setAction(LiveUpdateService.ACTION_STOP)
            )
        } catch (t: Throwable) {
            Log.w(TAG, "stop 失败（已忽略）: ${t.javaClass.simpleName}")
        }
    }

    /**
     * 通知按钮点击 → 转发给脚本，并按当前内容刷新一次通知
     * （刷新同样走 NotificationFactory.buildNotification，图标保持单色熊猫）。
     */
    private fun forwardToScript(context: Context, intent: Intent) {
        val key = intent.getStringExtra(LiveUpdateService.EXTRA_KEY).orEmpty()
        val out = Intent(LiveUpdateService.ACTION_FROM_APP)
            .putExtra(
                LiveUpdateService.EXTRA_EVENT,
                intent.getStringExtra(LiveUpdateService.EXTRA_EVENT)
                    ?: LiveUpdateService.EVENT_ACTION_CLICKED
            )
            .putExtra(LiveUpdateService.EXTRA_KEY, key)
            .putExtra(
                LiveUpdateService.EXTRA_TITLE,
                intent.getStringExtra(LiveUpdateService.EXTRA_TITLE).orEmpty()
            )
            .putExtra(
                LiveUpdateService.EXTRA_SHORT,
                intent.getStringExtra(LiveUpdateService.EXTRA_SHORT).orEmpty()
            )
        context.sendBroadcast(out)
        UiLog.add("已发送按钮点击广播 key=$key")
        Log.i(TAG, "已转发按钮点击: key=$key")

        // 按钮点击后刷新（服务在运行时）
        try {
            LiveUpdateService.instance?.refreshNotification()
        } catch (t: Throwable) {
            Log.w(TAG, "按钮点击后刷新通知失败（已忽略）: ${t.javaClass.simpleName}")
        }
    }

    private companion object {
        const val TAG = "UpdateReceiver"
    }
}
