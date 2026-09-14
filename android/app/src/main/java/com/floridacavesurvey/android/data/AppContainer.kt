package com.floridacavesurvey.android.data

import android.content.Context
import com.floridacavesurvey.android.data.network.ApiService
import com.floridacavesurvey.android.data.network.NetworkModule
import com.floridacavesurvey.android.data.repository.AdminRepository
import com.floridacavesurvey.android.data.repository.AuthRepository
import com.floridacavesurvey.android.data.repository.CaveRepository
import com.floridacavesurvey.android.data.repository.MapRepository
import com.floridacavesurvey.android.data.repository.NarrativeRepository
import com.floridacavesurvey.android.data.repository.SiteConfigRepository
import com.floridacavesurvey.android.data.repository.StatisticsRepository
import com.floridacavesurvey.android.data.repository.SubmissionRepository

/** Simple hand-rolled dependency container (no Hilt/Dagger) - one instance per process, owned by [com.floridacavesurvey.android.FcsApplication]. */
class AppContainer(context: Context) {

    val tokenStore = TokenStore(context.applicationContext)

    private val okHttpClient = NetworkModule.buildOkHttpClient(tokenStore)
    private val api: ApiService = NetworkModule.buildService(okHttpClient, ApiService::class.java)

    val authRepository = AuthRepository(api, tokenStore)
    val caveRepository = CaveRepository(api)
    val narrativeRepository = NarrativeRepository(api)
    val submissionRepository = SubmissionRepository(api)
    val mapRepository = MapRepository(api)
    val adminRepository = AdminRepository(api)
    val siteConfigRepository = SiteConfigRepository(api)
    val statisticsRepository = StatisticsRepository(caveRepository, narrativeRepository, submissionRepository)
}
