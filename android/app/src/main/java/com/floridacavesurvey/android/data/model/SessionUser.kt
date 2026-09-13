package com.floridacavesurvey.android.data.model

/**
 * Decoded from the JWT payload issued by POST /api/login and re-used as the
 * locally cached "who am I" (see server.js: jwt.sign({ id, username, role,
 * fullName, allowedStates }, ...)). `role` is one of "admin", "webmaster",
 * "member" - admin and webmaster are treated as equals everywhere in
 * server.js (see getAllowedStatesForUser / requireRole("admin", "webmaster")),
 * both bypassing the member-only state restriction.
 */
data class SessionUser(
    val id: String,
    val username: String,
    val role: String,
    val fullName: String?,
    val allowedStates: List<String>? = null,
    val twoFactorEnabled: Boolean = false,
) {
    val isWebmasterOrAdmin: Boolean
        get() = role == "admin" || role == "webmaster"
}
