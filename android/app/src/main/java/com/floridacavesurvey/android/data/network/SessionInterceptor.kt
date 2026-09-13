package com.floridacavesurvey.android.data.network

import com.floridacavesurvey.android.data.TokenStore
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Watches for the "Invalid or expired session"/"Authentication required"
 * responses that `authenticateToken` sends on a missing/bad/expired JWT
 * (server.js) and reacts by clearing the stored session and notifying the
 * UI. Deliberately narrower than "any 401/403": `requireRole` also answers
 * 403 for a logged-in user who simply lacks permission for that one action
 * (e.g. a member hitting a webmaster-only route), and that must NOT log the
 * user out - so the response body is checked, not just the status code.
 */
class SessionInterceptor(private val tokenStore: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)
        if ((response.code == 401 || response.code == 403) &&
            request.header(AuthInterceptor.NO_AUTH_HEADER) == null &&
            tokenStore.currentToken != null
        ) {
            val body = runCatching { response.peekBody(2048).string() }.getOrDefault("")
            val isSessionError = SESSION_ERROR_MARKERS.any { body.contains(it, ignoreCase = true) }
            if (isSessionError) {
                tokenStore.clear()
                SessionExpiredNotifier.notify()
            }
        }
        return response
    }

    private companion object {
        val SESSION_ERROR_MARKERS = listOf(
            "Authentication required",
            "Invalid or expired session",
            "Two-factor verification required",
        )
    }
}
