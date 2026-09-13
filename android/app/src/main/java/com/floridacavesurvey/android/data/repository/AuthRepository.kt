package com.floridacavesurvey.android.data.repository

import com.floridacavesurvey.android.data.TokenStore
import com.floridacavesurvey.android.data.model.*
import com.floridacavesurvey.android.data.network.ApiService

sealed class LoginOutcome {
    data class LoggedIn(val user: SessionUser) : LoginOutcome()
    data class TwoFactorRequired(val twoFactorToken: String, val message: String) : LoginOutcome()
}

class AuthRepository(
    private val api: ApiService,
    private val tokenStore: TokenStore,
) {
    val session get() = tokenStore.session

    suspend fun login(username: String, password: String): LoginOutcome {
        val result = api.login(LoginRequest(username, password))
        return handleLoginResult(result)
    }

    suspend fun verifyTwoFactor(twoFactorToken: String, code: String): LoginOutcome {
        val result = api.verifyTwoFactor(VerifyTwoFactorRequest(twoFactorToken, code))
        return handleLoginResult(result)
    }

    suspend fun resendTwoFactor(twoFactorToken: String): String =
        api.resendTwoFactor(ResendTwoFactorRequest(twoFactorToken)).message

    private fun handleLoginResult(result: LoginResult): LoginOutcome {
        if (result.twoFactorRequired == true && result.twoFactorToken != null) {
            return LoginOutcome.TwoFactorRequired(result.twoFactorToken, result.message ?: "A verification code has been sent to your email.")
        }
        val token = requireNotNull(result.token) { "Login succeeded but no session token was returned." }
        val user = SessionUser(
            id = result.username.orEmpty(),
            username = result.username.orEmpty(),
            role = result.role ?: "member",
            fullName = result.fullName,
            allowedStates = result.allowedStates,
            twoFactorEnabled = result.twoFactorEnabled ?: false,
        )
        tokenStore.save(token, user)
        return LoginOutcome.LoggedIn(user)
    }

    suspend fun toggleTwoFactor(enabled: Boolean, password: String? = null): Boolean =
        api.toggleTwoFactor(ToggleTwoFactorRequest(enabled, password)).twoFactorEnabled

    suspend fun forgotPassword(email: String): String =
        api.forgotPassword(ForgotPasswordRequest(email)).message ?: "If the email exists, a reset link has been sent"

    suspend fun resetPassword(token: String, newPassword: String): String =
        api.resetPassword(ResetPasswordRequest(token, newPassword)).message ?: "Password updated."

    suspend fun changePassword(currentPassword: String, newPassword: String): String =
        api.changePassword(ChangePasswordRequest(currentPassword, newPassword)).message ?: "Password updated."

    suspend fun createAccount(username: String, email: String, password: String, states: List<String>): String =
        api.createAccount(CreateAccountRequest(username, email, password, states)).message
            ?: "Account created. An administrator must approve it before you can log in."

    fun logout() = tokenStore.clear()
}
