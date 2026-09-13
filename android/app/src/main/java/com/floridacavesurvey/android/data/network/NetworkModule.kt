package com.floridacavesurvey.android.data.network

import com.floridacavesurvey.android.BuildConfig
import com.floridacavesurvey.android.data.TokenStore
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Builds the single Retrofit/OkHttp instance the whole app shares. Base URL
 * is [BuildConfig.API_BASE_URL] (set from the `apiBaseUrl` Gradle property,
 * see app/build.gradle.kts), so pointing the app at a different deployment
 * of the same server.js never requires touching source.
 */
object NetworkModule {

    val moshi: Moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    fun buildOkHttpClient(tokenStore: TokenStore): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BODY
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }
        return OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor(tokenStore))
            .addInterceptor(SessionInterceptor(tokenStore))
            .addInterceptor(logging)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    fun <T> buildService(okHttpClient: OkHttpClient, serviceClass: Class<T>): T {
        val retrofit = Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(okHttpClient)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
        return retrofit.create(serviceClass)
    }
}
