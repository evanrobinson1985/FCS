package com.floridacavesurvey.android.ui.common

import com.floridacavesurvey.android.BuildConfig

/**
 * Builds a full, authenticated URL for an image/asset path the server returned relative
 * (e.g. "/cave-pictures/foo.jpg"). Uses the `?token=` fallback documented for authenticateToken
 * (server.js) since Coil's plain-URL `AsyncImage` has no easy way to attach a header per request.
 */
fun authedImageUrl(path: String, token: String?): String {
    val base = BuildConfig.API_BASE_URL.trimEnd('/')
    val full = if (path.startsWith("http")) path else "$base$path"
    if (token.isNullOrBlank()) return full
    val separator = if (full.contains("?")) "&" else "?"
    return "$full${separator}token=$token"
}
