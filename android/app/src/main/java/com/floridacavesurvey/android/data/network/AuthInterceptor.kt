package com.floridacavesurvey.android.data.network

import com.floridacavesurvey.android.data.TokenStore
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Attaches `Authorization: Bearer <jwt>` to every request that carries one,
 * mirroring the server's `authenticateToken` middleware which reads that
 * header first (server.js). A request tagged [NoAuth] is sent as-is, for the
 * handful of routes that are public (login, create-account, forgot-password,
 * reset-password, site-status).
 */
class AuthInterceptor(private val tokenStore: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val token = tokenStore.currentToken
        val authedRequest = if (token != null && request.header(NO_AUTH_HEADER) == null) {
            request.newBuilder()
                .addHeader("Authorization", "Bearer $token")
                .build()
        } else {
            request.newBuilder().removeHeader(NO_AUTH_HEADER).build()
        }
        return chain.proceed(authedRequest)
    }

    companion object {
        const val NO_AUTH_HEADER = "X-Fcs-No-Auth"
    }
}
