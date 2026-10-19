package com.example.liveupdateverify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.NotificationCompat

/**
 * 通知内容模型：待命态 / 广播显示态都转成它。
 */
data class NotifyData(
    val title: String,
    val text: String,
    val short: String,
    // 兼容保留：广播仍可带 smallIcon，但实际统一使用单色熊猫，不随其变化
    val smallIconName: String? = null,
    val action1Title: String? = null,
    val action1Key: String? = null,
    val action1Icon: String? = null,
    val action2Title: String? = null,
    val action2Key: String? = null,
    val action2Icon: String? = null,
    val action3Title: String? = null,
    val action3Key: String? = null,
    val action3Icon: String? = null
)

/**
 * 统一通知构建器。
 *
 * ★ 全工程只有这里会出现 NotificationCompat.Builder ★
 * 所有路径（待命态 / 刷新诊断 / UPDATE 广播 / 按钮点击后刷新）都必须调用 buildNotification()，
 * 保证 smallIcon 始终是同一个单色熊猫。
 */
object NotificationFactory {

    private const val MAX_SHORT_CHARS = 4
    private const val REQ_ACTION1 = 1101
    private const val REQ_ACTION2 = 1102
    private const val REQ_ACTION3 = 1103

    /** 渠道 ID 与已验证版本一致，不可改（重要级别创建后不可变） */
    fun ensureChannel(ctx: Context, channelId: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(channelId) != null) return

        val channel = NotificationChannel(
            channelId,
            ctx.getString(R.string.channel_name),
            NotificationManager.IMPORTANCE_LOW   // 严禁 IMPORTANCE_MIN
        ).apply {
            description = ctx.getString(R.string.channel_description)
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    /**
     * ★ 唯一的通知构建方法 ★
     *
     * - smallIcon 固定为单色熊猫 ic_stat_panda（不读取 broadcast 的 smallIcon）
     * - 不设置 largeIcon，避免出现彩色 App 图标
     * - 提升双保险、ongoing、IMPORTANCE_LOW 均保持不变
     * - 按钮按 1→2→3 添加，最多 3 个（系统上限，超出忽略）
     */
    fun buildNotification(ctx: Context, channelId: String, data: NotifyData): Notification {
        val builder = NotificationCompat.Builder(ctx, channelId)
            // 统一单色熊猫（状态栏/胶囊左侧小图标）
            .setSmallIcon(R.drawable.ic_stat_panda)
            .setContentTitle(data.title.ifBlank { ctx.getString(R.string.idle_title) })
            .setContentText(data.text)
            .setOngoing(true)
            // 样式保持 ProgressStyle（与已验证可上岛的版本一致）
            .setProgress(100, 60, false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        // 提升双保险之①
        builder.setRequestPromotedOngoing(true)
        // 提升双保险之②
        builder.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })

        // 胶囊短文字（<= 4 字，超出截断）
        builder.setShortCriticalText(truncateShort(data.short))

        // 动态按钮：1 → 2 → 3，最多 3 个
        addAction(ctx, builder, REQ_ACTION1, data.action1Title, data.action1Key, data.action1Icon, data)
        addAction(ctx, builder, REQ_ACTION2, data.action2Title, data.action2Key, data.action2Icon, data)
        addAction(ctx, builder, REQ_ACTION3, data.action3Title, data.action3Key, data.action3Icon, data)

        // 禁止项：不设 RemoteViews / setColorized(true) / setGroupSummary，也不设 largeIcon
        return builder.build()
    }

    private fun addAction(
        ctx: Context,
        builder: NotificationCompat.Builder,
        requestCode: Int,
        title: String?,
        key: String?,
        iconName: String?,
        data: NotifyData
    ) {
        // 为空则不显示；最多 3 个由调用顺序天然保证
        if (title.isNullOrBlank()) return
        builder.addAction(
            resolveActionIcon(ctx, iconName),
            title,
            clickPendingIntent(ctx, requestCode, key.orEmpty(), data)
        )
    }

    /**
     * 按钮点击 → 显式交给本 App 的 UpdateReceiver，再由它 sendBroadcast 转发 FROM_APP。
     * 用显式 Intent 规避 Android 14+ 对“隐式 PendingIntent”的限制。
     */
    private fun clickPendingIntent(
        ctx: Context,
        requestCode: Int,
        key: String,
        data: NotifyData
    ): PendingIntent {
        val intent = Intent(ctx, UpdateReceiver::class.java)
            .setAction(LiveUpdateService.ACTION_FROM_APP)
            .putExtra(LiveUpdateService.EXTRA_EVENT, LiveUpdateService.EVENT_ACTION_CLICKED)
            .putExtra(LiveUpdateService.EXTRA_KEY, key)
            .putExtra(LiveUpdateService.EXTRA_TITLE, data.title)
            .putExtra(LiveUpdateService.EXTRA_SHORT, data.short)

        return PendingIntent.getBroadcast(
            ctx,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    // ================= 按钮图标解析（逻辑保持原样） =================

    /**
     * actionIcon：短名自动补 ic_action_（bear -> ic_action_bear），
     * 也支持完整名（ic_action_bear）；解析失败回退 ic_action_done。
     */
    fun resolveActionIcon(ctx: Context, name: String?): Int {
        var raw = name?.trim().orEmpty()
        // 兼容旧文档：需求里写的是 smile（笑脸），实际提供的素材是小狗
        if (raw.equals("smile", ignoreCase = true)) raw = "dog"
        if (raw.isEmpty()) return R.drawable.ic_action_done

        val candidate = when {
            raw.startsWith("ic_action_") -> raw
            raw.startsWith("ic_") -> ""          // ic_stat_* 等不接受
            else -> "ic_action_$raw"
        }
        if (candidate.isNotEmpty()) {
            val id = ctx.resources.getIdentifier(candidate, "drawable", ctx.packageName)
            if (id != 0) return id
        }
        return R.drawable.ic_action_done
    }

    /** 胶囊短文字最多 4 个字符（代理对安全，不会把 emoji 截半） */
    fun truncateShort(s: String): String {
        if (s.isEmpty()) return s
        var count = 0
        var end = 0
        while (end < s.length && count < MAX_SHORT_CHARS) {
            end += if (Character.isHighSurrogate(s[end]) && end + 1 < s.length) 2 else 1
            count++
        }
        return s.substring(0, end)
    }
}
