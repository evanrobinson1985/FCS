plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.floridacavesurvey.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.floridacavesurvey.android"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // Overridable at build time with -PapiBaseUrl=https://your-host/ ;
        // defaults to the production Florida Cave Survey server.
        val apiBaseUrl = (project.findProperty("apiBaseUrl") as String?)
            ?: "https://floridacavesurvey.org/"
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")

        // The Google Cloud "Web application" OAuth client ID (used as the
        // Credential Manager request's serverClientId - see the webmaster
        // flavor and android/README.md "Google sign-in setup"). Only the
        // webmaster flavor's login screen actually offers Google sign-in,
        // but this is shared config either way so it isn't duplicated.
        val googleWebClientId = (project.findProperty("googleWebClientId") as String?) ?: ""
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"$googleWebClientId\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    flavorDimensions += "audience"
    productFlavors {
        // The regular, public-facing app: every member signs in with their
        // own username/password (Google sign-in is never offered here).
        create("general") {
            dimension = "audience"
            buildConfigField("boolean", "SHOW_GOOGLE_SIGN_IN", "false")
        }
        // A second, separately-installable build for exactly one account
        // (see GOOGLE_WEBMASTER_EMAIL server-side): its login screen leads
        // with "Continue with Google" instead of a password field, with
        // username/password still available underneath as a fallback. Own
        // applicationId/name/icon so it installs as its own app alongside
        // the general one, not a replacement for it.
        create("webmaster") {
            dimension = "audience"
            applicationIdSuffix = ".webmaster"
            versionNameSuffix = "-webmaster"
            buildConfigField("boolean", "SHOW_GOOGLE_SIGN_IN", "true")
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
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.2")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.8.0")

    // Networking
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-moshi:2.11.0")
    implementation("com.squareup.moshi:moshi:1.15.1")
    implementation("com.squareup.moshi:moshi-kotlin:1.15.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Local encrypted token storage
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Images (cave photos, narrative images)
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Map (hillshade tile viewer) - osmdroid, no Google API key required
    implementation("org.osmdroid:osmdroid-android:6.1.20")

    // Google sign-in (webmaster flavor only, but harmless to share) - Credential
    // Manager is the current recommended replacement for the old GoogleSignIn API.
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
