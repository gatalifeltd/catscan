// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
plugins {
    id("com.android.application") version "9.5.1"
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21"
}

// `-PFAULTS=1` builds the variant with planted UI defects (raw key, ellipsized label).
val faults = providers.gradleProperty("FAULTS").orNull == "1"

android {
    namespace = "org.catscan.sample"
    compileSdk = 37

    defaultConfig {
        applicationId = "org.catscan.sample"
        minSdk = 33
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
        buildConfigField("boolean", "FAULTS", faults.toString())
    }

    // Keep only the app locales; library resources otherwise add ~90 more.
    androidResources {
        localeFilters += setOf("en", "de", "fr")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
}
