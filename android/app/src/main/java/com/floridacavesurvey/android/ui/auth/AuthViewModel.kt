package com.floridacavesurvey.android.ui.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.floridacavesurvey.android.data.model.SessionUser
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.AuthRepository
import com.floridacavesurvey.android.data.repository.LoginOutcome
import kotlinx.coroutines.launch

/** Which screen the login flow is currently showing. */
sealed class LoginStep {
    data object Credentials : LoginStep()
    data class TwoFactor(val twoFactorToken: String, val message: String) : LoginStep()
}

class AuthViewModel(private val repo: AuthRepository) : ViewModel() {

    var step by mutableStateOf<LoginStep>(LoginStep.Credentials)
        private set
    var isLoading by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set
    var loggedInUser by mutableStateOf<SessionUser?>(null)
        private set

    fun login(username: String, password: String) {
        if (username.isBlank() || password.isBlank()) {
            errorMessage = "Enter your username and password."
            return
        }
        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            safeApiCall { repo.login(username, password) }
                .onSuccess { outcome -> applyOutcome(outcome) }
                .onFailure { errorMessage = it.message }
            isLoading = false
        }
    }

    fun submitTwoFactorCode(code: String) {
        val pending = step as? LoginStep.TwoFactor ?: return
        if (code.isBlank()) {
            errorMessage = "Enter the 6-digit code from your email."
            return
        }
        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            safeApiCall { repo.verifyTwoFactor(pending.twoFactorToken, code) }
                .onSuccess { outcome -> applyOutcome(outcome) }
                .onFailure { errorMessage = it.message }
            isLoading = false
        }
    }

    fun resendCode() {
        val pending = step as? LoginStep.TwoFactor ?: return
        viewModelScope.launch {
            isLoading = true
            safeApiCall { repo.resendTwoFactor(pending.twoFactorToken) }
                .onSuccess { errorMessage = null }
                .onFailure { errorMessage = it.message }
            isLoading = false
        }
    }

    fun backToCredentials() {
        step = LoginStep.Credentials
        errorMessage = null
    }

    fun clearError() {
        errorMessage = null
    }

    private fun applyOutcome(outcome: LoginOutcome) {
        when (outcome) {
            is LoginOutcome.LoggedIn -> loggedInUser = outcome.user
            is LoginOutcome.TwoFactorRequired -> step = LoginStep.TwoFactor(outcome.twoFactorToken, outcome.message)
        }
    }
}
