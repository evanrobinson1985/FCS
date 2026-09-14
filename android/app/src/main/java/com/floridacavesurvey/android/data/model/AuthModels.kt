package com.floridacavesurvey.android.data.model

// --- Requests ---------------------------------------------------------

data class LoginRequest(val username: String, val password: String)

data class GoogleLoginRequest(val idToken: String)

data class VerifyTwoFactorRequest(val twoFactorToken: String, val code: String)

data class ResendTwoFactorRequest(val twoFactorToken: String)

data class ToggleTwoFactorRequest(val enabled: Boolean, val password: String? = null)

data class ForgotPasswordRequest(val email: String)

data class ResetPasswordRequest(val token: String, val newPassword: String)

data class ChangePasswordRequest(val currentPassword: String, val newPassword: String)

data class CreateAccountRequest(
    val username: String,
    val email: String,
    val password: String,
    val states: List<String>,
)

// --- Responses ----------------------------------------------------------

/**
 * Covers both possible shapes of POST /api/login (and the identical shape
 * returned by /api/verify-2fa): either a completed login (`token` present)
 * or a pending-2FA handoff (`twoFactorRequired`+`twoFactorToken` present).
 * Modeled as one class with nullable branches rather than a sealed type
 * because Moshi's reflection adapter can't discriminate a sealed class from
 * JSON shape alone without extra wiring - the repository layer checks
 * `twoFactorRequired` to decide which branch it got.
 */
data class LoginResult(
    val success: Boolean? = null,
    val token: String? = null,
    val username: String? = null,
    val fullName: String? = null,
    val role: String? = null,
    val nssNumber: String? = null,
    val twoFactorEnabled: Boolean? = null,
    val allowedStates: List<String>? = null,
    val twoFactorRequired: Boolean? = null,
    val twoFactorToken: String? = null,
    val message: String? = null,
)

data class ResendTwoFactorResponse(val message: String)

data class ToggleTwoFactorResponse(val message: String, val twoFactorEnabled: Boolean)

data class SimpleSuccessResponse(val success: Boolean? = null, val message: String? = null)
