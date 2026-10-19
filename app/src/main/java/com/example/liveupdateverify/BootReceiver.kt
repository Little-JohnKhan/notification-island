package com.example.liveupdateverify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * 开机自启 / 应用更新后重启服务（进入待命态）。
 *
 * 说明：只能提高恢复概率，不保证 100%——Android 12+ 对“后台启动前台服务”有限制，
 * Android 15/16 更严格，ColorOS 还可能拦截。最可靠仍是手动打开一次 App。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                try {
                    val i = Intent(context, LiveUpdateService::class.java)
                        .setAction(LiveUpdateService.ACTION_START)
                    ContextCompat.startForegroundService(context, i)
                    Log.i(TAG, "已尝试开机/更新后启动前台服务")
                } catch (t: Throwable) {
                    // 失败静默：不崩溃、不弹任何提示
                    Log.w(TAG, "开机启动前台服务失败（系统限制，已忽略）：${t.javaClass.simpleName}")
                }
            }
        }
    }

    private companion object {
        const val TAG = "BootReceiver"
    }
}
