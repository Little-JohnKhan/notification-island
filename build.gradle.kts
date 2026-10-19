// 顶层构建文件：统一声明插件版本（apply false = 此处不应用，由子模块应用）
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
}
