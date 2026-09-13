package com.floridacavesurvey.android

import android.app.Application
import com.floridacavesurvey.android.data.AppContainer
import org.osmdroid.config.Configuration

class FcsApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)

        // osmdroid requires this before any MapView is created: it sets the tile-cache
        // location and the User-Agent (some tile hosts 403 the default "osmdroid" UA).
        Configuration.getInstance().load(this, getSharedPreferences("osmdroid", MODE_PRIVATE))
        Configuration.getInstance().userAgentValue = packageName
    }
}
