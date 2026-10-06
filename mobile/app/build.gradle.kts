import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing is read from mobile/keystore.properties (not committed).
// Without it, release builds are left unsigned.
val keystore = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.buzz.browser"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.buzz.browser"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (keystore.containsKey("storeFile")) {
            create("release") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("shared-assets"))
}

// The theme, fonts, icons and logo are shared with the desktop app, which owns them.
val syncSharedAssets by tasks.registering(Copy::class) {
    from("../../desktop/src/assets") {
        include("theme.css", "icons.js", "logo.svg", "fonts/*.woff2")
    }
    into(layout.buildDirectory.dir("shared-assets/ui/shared"))
}
tasks.named("preBuild") { dependsOn(syncSharedAssets) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
}
