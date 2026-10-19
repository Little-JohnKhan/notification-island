package com.example.liveupdateverify

/**
 * 全局 UI 日志缓冲。
 *
 * 目的：广播可能在 App 处于后台时被处理，这时界面日志区并不存在。
 *  - Activity 在前台：直接回调到界面（即时可见）
 *  - Activity 不在前台：先缓存，下次 onResume 时一次性补显
 *
 * 这样“后台是否真的处理了广播”可以直接在界面上确认。
 */
object UiLog {

    private const val MAX = 500
    private val pending = ArrayList<String>()

    @Volatile
    private var listener: ((String) -> Unit)? = null

    fun add(line: String) {
        val l = listener
        if (l != null) {
            l(line)
            return
        }
        synchronized(pending) {
            pending.add(line)
            if (pending.size > MAX) pending.removeAt(0)
        }
    }

    fun attach(l: (String) -> Unit) {
        listener = l
        val flush: List<String>
        synchronized(pending) {
            flush = ArrayList(pending)
            pending.clear()
        }
        flush.forEach { l(it) }
    }

    fun detach() {
        listener = null
    }
}
