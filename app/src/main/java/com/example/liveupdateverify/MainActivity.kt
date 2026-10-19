package com.example.liveupdateverify

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 主界面：开始 / 停止 / 刷新诊断 / 跳转设置，以及一块可复制的日志区。
 *
 * - Android 15/16 强制 edge-to-edge：enableEdgeToEdge() + WindowInsets 给根布局加内边距，
 *   保证四个按钮都在状态栏下方、可正常点击。
 * - App 启动时自动开始前台服务（进入待命态）。
 */
class MainActivity : ComponentActivity() {

    private lateinit var logView: TextView
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.US)

    // 四、权限申请：用 ActivityResultContracts.RequestPermission() 请求 POST_NOTIFICATIONS
    private val requestPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                appendLog("POST_NOTIFICATIONS 已授予")
                // 授权后再触发一次，确保前台服务通知能显示出来
                startLiveUpdateService()
            } else {
                appendLog("POST_NOTIFICATIONS 被拒绝：通知可能无法显示，请到系统设置手动开启")
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Android 15/16 强制 edge-to-edge：显式开启并自行处理 insets
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        logView = findViewById(R.id.logView)

        // 顶部避开状态栏、底部避开导航栏：四个按钮完全位于状态栏下方、可正常点击。
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(top = bars.top, bottom = bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(root)

        findViewById<Button>(R.id.btnStart).setOnClickListener { startLiveUpdateService() }
        findViewById<Button>(R.id.btnStop).setOnClickListener { stopLiveUpdateService() }
        findViewById<Button>(R.id.btnDiagnose).setOnClickListener { runDiagnostics() }
        findViewById<Button>(R.id.btnSettings).setOnClickListener { openPromotedSettings() }

        appendLog("应用已启动。SDK_INT = ${Build.VERSION.SDK_INT}")
        ensureNotificationPermission()

        // 启动即自动开始前台服务（待命态），免去每次手动点“开始”
        startLiveUpdateService()
    }

    override fun onResume() {
        super.onResume()
        // 挂上全局日志回调：App 在后台时收到的广播记录，会在打开界面时补显
        UiLog.attach { appendLog(it) }
        runDiagnostics()
    }

    override fun onPause() {
        UiLog.detach()
        super.onPause()
    }

    private fun ensureNotificationPermission() {
        // 注意：POST_PROMOTED_NOTIFICATIONS 是 normal 权限，清单声明即可，不要运行时申请它。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) { // 33
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED

            if (granted) {
                appendLog("POST_NOTIFICATIONS 已具备")
            } else {
                appendLog("请求运行时权限 POST_NOTIFICATIONS ...")
                requestPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun startLiveUpdateService() {
        // Android 12+ 限制后台启动 FGS；这里由前台 Activity 触发，符合要求。
        val intent = Intent(this, LiveUpdateService::class.java)
            .setAction(LiveUpdateService.ACTION_START)
        ContextCompat.startForegroundService(this, intent)
        appendLog(">>> 已请求启动前台服务（待命态）")

        // 提升通常是异步的，稍等片刻自动抓一次诊断
        logView.postDelayed({ runDiagnostics() }, 1500)
    }

    private fun stopLiveUpdateService() {
        val intent = Intent(this, LiveUpdateService::class.java)
            .setAction(LiveUpdateService.ACTION_STOP)
        startService(intent)
        appendLog(">>> 已请求停止前台服务（下岛）")
        logView.postDelayed({ runDiagnostics() }, 800)
    }

    /** 五、自检与诊断：把结果打印到界面日志区（方便截图判断卡在哪一步）。 */
    private fun runDiagnostics() {
        // 顺带刷新一次通知：统一走 NotificationFactory.buildNotification()，
        // 保证“启动 / 刷新诊断”后的小图标也是单色熊猫
        LiveUpdateService.instance?.refreshNotification()

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val sb = StringBuilder()

        sb.append("\n===== 诊断 ${timeFormat.format(Date())} =====")
        sb.append("\nBuild.VERSION.SDK_INT = ").append(Build.VERSION.SDK_INT)

        // 决定性的一项：权限 + 用户/系统开关是否真的允许发布提升通知
        if (Build.VERSION.SDK_INT >= 36) {
            sb.append("\nNotificationManager.canPostPromotedNotifications() = ")
                .append(nm.canPostPromotedNotifications())
                .append("   // false ⇒ 卡在权限或系统开关")
        } else {
            sb.append("\ncanPostPromotedNotifications() = N/A (SDK<36)")
        }

        val channel = nm.getNotificationChannel(LiveUpdateService.CHANNEL_ID)
        sb.append("\n渠道级别 importance = ").append(channel?.importance ?: "无")
            .append("   // 需要 >= IMPORTANCE_LOW(")
            .append(NotificationManager.IMPORTANCE_LOW).append(")")

        val active = nm.activeNotifications
        val target = active.firstOrNull { it.id == LiveUpdateService.NOTIF_ID }

        if (target == null) {
            sb.append("\n前台服务通知：不存在（服务未运行 / 已停止 / 被系统清理）")
        } else {
            val n: Notification = target.notification
            sb.append("\n前台服务通知：存在 (id=").append(target.id).append(")")
            sb.append("\n  FLAG_ONGOING_EVENT = ")
                .append((n.flags and Notification.FLAG_ONGOING_EVENT) != 0)

            if (Build.VERSION.SDK_INT >= 36) {
                sb.append("\n  hasPromotableCharacteristics() = ")
                    .append(n.hasPromotableCharacteristics())
                    .append("   // true = 通知结构合格")
                sb.append("\n  FLAG_PROMOTED_ONGOING = ")
                    .append((n.flags and Notification.FLAG_PROMOTED_ONGOING) != 0)
                    .append("   // true = 系统真的提升了它")
            } else {
                sb.append("\n  hasPromotableCharacteristics() = N/A (SDK<36)")
            }
        }

        sb.append(
            "\n提示：若 canPostPromotedNotifications=true 且 hasPromotableCharacteristics=true " +
                    "但未上岛，则卡在 OEM(OPPO/一加) 系统策略，非代码问题。"
        )

        appendLog(sb.toString())
    }

    /**
     * 六、跳转系统设置页，方便用户手动开启该 App 的“实时更新”。
     *
     * 坑 11：一加/ColorOS 16 实测，以下 action 都可能抛 ActivityNotFoundException，逐个兜底。
     * 注意：SDK 36 的 android.jar 里没有 Settings.ACTION_MANAGE_APP_PROMOTED_NOTIFICATIONS 常量，
     *       因此用字符串字面量。
     */
    private fun openPromotedSettings() {
        val pkgUri = Uri.parse("package:$packageName")
        val candidates = listOf(
            Intent("android.settings.MANAGE_APP_PROMOTED_NOTIFICATIONS").setData(pkgUri),
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
            Intent("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS").setData(pkgUri),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(pkgUri)
        )

        for (intent in candidates) {
            try {
                startActivity(intent)
                appendLog("已打开设置页：${intent.action}")
                return
            } catch (e: Exception) {
                // 换下一个候选
            }
        }
        appendLog("无法打开任何系统设置页，请手动前往：设置 → 通知 → 本应用")
    }

    private fun appendLog(msg: String) {
        logView.append(msg + "\n")
    }
}
