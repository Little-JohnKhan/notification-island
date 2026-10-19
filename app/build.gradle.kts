plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.liveupdateverify"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.example.liveupdateverify"
        minSdk = 29
        targetSdk = 36
        versionCode = 5
        versionName = "1.4"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // ★ 关键依赖：core-ktx 1.17.0 是首个包含“提升通知”向后移植 API 的版本
    //   （setRequestPromotedOngoing / setShortCriticalText），且 minCompileSdk = 36。
    //   注意：1.16.0 没有这两个 API；1.19.x 要求 compileSdk 37，请勿升级。
    implementation("androidx.core:core-ktx:1.17.0")

    // 仅用于 ActivityResultContracts.RequestPermission() 申请 POST_NOTIFICATIONS 运行时权限
    implementation("androidx.activity:activity:1.10.1")
}
