package com.floridacavesurvey.android.data.model

/** GET /api/users entry - the fullest, password-stripped user projection (API ref §9.1.C). */
data class AdminUser(
    val id: String,
    val username: String,
    val email: String? = null,
    val fullName: String? = null,
    val nssNumber: String? = null,
    val role: String,
    val status: String,
    val created: String? = null,
    val lastLogin: String? = null,
    val loginAttempts: Int? = null,
    val isEmailVerified: Boolean? = null,
    val twoFactorEnabled: Boolean? = null,
    val allowedStates: List<String>? = null,
    val loginIPs: List<String>? = null,
    val isActive: Boolean? = null,
) {
    val isWebmaster: Boolean get() = role == "webmaster"
}

data class ChangeUserRoleRequest(val username: String, val newRole: String)

data class ChangeUserStatesRequest(val username: String, val allowedStates: List<String>)

data class ToggleUserStatusRequest(val username: String, val isActive: Boolean)

data class DeleteUserRequest(val username: String)

data class SecurityLogEntry(
    val timestamp: String,
    val action: String,
    val username: String,
    val ipAddress: String? = null,
    val details: String? = null,
)
