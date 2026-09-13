package com.floridacavesurvey.android.ui.admin

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.floridacavesurvey.android.data.model.*
import com.floridacavesurvey.android.data.network.UiState
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.AdminRepository
import com.floridacavesurvey.android.data.repository.CaveRepository
import com.floridacavesurvey.android.data.repository.SiteConfigRepository
import com.floridacavesurvey.android.data.repository.SubmissionRepository
import kotlinx.coroutines.launch

class UsersViewModel(private val repo: AdminRepository, private val caveRepo: CaveRepository) : ViewModel() {
    var users by mutableStateOf<UiState<List<AdminUser>>>(UiState.Loading)
        private set
    var states by mutableStateOf<List<StateInfo>>(emptyList())
        private set
    var actionError by mutableStateOf<String?>(null)
        private set

    init {
        load()
        viewModelScope.launch { safeApiCall { caveRepo.getStates() }.onSuccess { states = it } }
    }

    fun load() {
        viewModelScope.launch {
            users = UiState.Loading
            safeApiCall { repo.getUsers() }
                .onSuccess { users = UiState.Success(it) }
                .onFailure { users = UiState.Error(it.message ?: "Failed to load users") }
        }
    }

    fun approve(username: String) = runAction { repo.toggleStatus(username, true) }
    fun deactivate(username: String) = runAction { repo.toggleStatus(username, false) }
    fun changeRole(username: String, role: String) = runAction { repo.changeRole(username, role) }
    fun changeStates(username: String, states: List<String>) = runAction { repo.changeStates(username, states) }
    fun deleteUser(username: String) = runAction { repo.deleteUser(username) }

    private fun runAction(block: suspend () -> Any) {
        viewModelScope.launch {
            actionError = null
            safeApiCall { block() }.onSuccess { load() }.onFailure { actionError = it.message }
        }
    }
}

class SubmissionsViewModel(private val repo: SubmissionRepository) : ViewModel() {
    var pending by mutableStateOf<UiState<List<Submission>>>(UiState.Loading)
        private set
    var actionError by mutableStateOf<String?>(null)
        private set

    init { load() }

    fun load() {
        viewModelScope.launch {
            pending = UiState.Loading
            safeApiCall { repo.getPending() }
                .onSuccess { pending = UiState.Success(it.filter { s -> s.status == "pending" }) }
                .onFailure { pending = UiState.Error(it.message ?: "Failed to load submissions") }
        }
    }

    fun approve(submissionId: String) {
        viewModelScope.launch {
            safeApiCall { repo.approve(submissionId) }.onSuccess { load() }.onFailure { actionError = it.message }
        }
    }

    fun reject(submissionId: String, reason: String?) {
        viewModelScope.launch {
            safeApiCall { repo.reject(submissionId, reason) }.onSuccess { load() }.onFailure { actionError = it.message }
        }
    }
}

class SecurityLogsViewModel(private val repo: AdminRepository) : ViewModel() {
    var logs by mutableStateOf<UiState<List<SecurityLogEntry>>>(UiState.Loading)
        private set

    init { load() }

    fun load() {
        viewModelScope.launch {
            logs = UiState.Loading
            safeApiCall { repo.getSecurityLogs() }
                .onSuccess { logs = UiState.Success(it) }
                .onFailure { logs = UiState.Error(it.message ?: "Failed to load security logs") }
        }
    }
}

class SiteConfigViewModel(private val repo: SiteConfigRepository) : ViewModel() {
    var config by mutableStateOf<UiState<SiteConfig>>(UiState.Loading)
        private set
    var isSaving by mutableStateOf(false)
        private set
    var saveError by mutableStateOf<String?>(null)
        private set

    init { load() }

    fun load() {
        viewModelScope.launch {
            config = UiState.Loading
            safeApiCall { repo.getFullConfig() }
                .onSuccess { config = UiState.Success(it) }
                .onFailure { config = UiState.Error(it.message ?: "Failed to load site config") }
        }
    }

    fun update(fields: Map<String, Any?>) {
        viewModelScope.launch {
            isSaving = true
            saveError = null
            safeApiCall { repo.update(fields) }
                .onSuccess { config = UiState.Success(it) }
                .onFailure { saveError = it.message }
            isSaving = false
        }
    }
}
