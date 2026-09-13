package com.floridacavesurvey.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.TokenStore
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.AuthRepository
import com.floridacavesurvey.android.ui.localAppContainer
import kotlinx.coroutines.launch

class AccountSettingsViewModel(private val repo: AuthRepository, private val tokenStore: TokenStore) : ViewModel() {
    var changePasswordMessage by mutableStateOf<String?>(null)
        private set
    var changePasswordError by mutableStateOf<String?>(null)
        private set
    var isChangingPassword by mutableStateOf(false)
        private set

    var twoFactorEnabled by mutableStateOf(tokenStore.session.value?.user?.twoFactorEnabled ?: false)
        private set
    var toggleError by mutableStateOf<String?>(null)
        private set
    var isTogglingTwoFactor by mutableStateOf(false)
        private set

    fun changePassword(current: String, new: String) {
        if (new.length < 10) {
            changePasswordError = "Password must be at least 10 characters long"
            return
        }
        viewModelScope.launch {
            isChangingPassword = true
            changePasswordError = null
            changePasswordMessage = null
            safeApiCall { repo.changePassword(current, new) }
                .onSuccess { changePasswordMessage = it }
                .onFailure { changePasswordError = it.message }
            isChangingPassword = false
        }
    }

    fun setTwoFactor(enabled: Boolean, password: String?) {
        viewModelScope.launch {
            isTogglingTwoFactor = true
            toggleError = null
            safeApiCall { repo.toggleTwoFactor(enabled, password) }
                .onSuccess {
                    twoFactorEnabled = it
                    tokenStore.updateUser { user -> user.copy(twoFactorEnabled = it) }
                }
                .onFailure { toggleError = it.message }
            isTogglingTwoFactor = false
        }
    }

    fun logout() = repo.logout()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountSettingsScreen(onBack: () -> Unit, onLoggedOut: () -> Unit) {
    val container = localAppContainer()
    val viewModel: AccountSettingsViewModel = viewModel(
        factory = viewModelFactory { initializer { AccountSettingsViewModel(container.authRepository, container.tokenStore) } },
    )
    val session = container.tokenStore.session.collectAsState().value

    var currentPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var showDisable2faDialog by remember { mutableStateOf(false) }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Account") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) } },
        )
    }) { padding ->
        Column(modifier = Modifier.padding(padding).padding(16.dp).fillMaxWidth()) {
            Text(session?.user?.username.orEmpty(), style = MaterialTheme.typography.titleLarge)
            Text(session?.user?.role.orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant)

            Spacer(Modifier.height(24.dp))
            Text("Change password", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = currentPassword,
                onValueChange = { currentPassword = it },
                label = { Text("Current password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = newPassword,
                onValueChange = { newPassword = it },
                label = { Text("New password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                supportingText = { Text("At least 10 characters") },
                modifier = Modifier.fillMaxWidth(),
            )
            viewModel.changePasswordMessage?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, color = MaterialTheme.colorScheme.primary)
            }
            viewModel.changePasswordError?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = { viewModel.changePassword(currentPassword, newPassword) },
                enabled = !viewModel.isChangingPassword && currentPassword.isNotBlank() && newPassword.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Update password") }

            Spacer(Modifier.height(24.dp))
            Text("Two-factor authentication", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Require a login code sent to your email", modifier = Modifier.weight(1f))
                Switch(
                    checked = viewModel.twoFactorEnabled == true,
                    onCheckedChange = { enabled ->
                        if (enabled) viewModel.setTwoFactor(true, null) else showDisable2faDialog = true
                    },
                    enabled = !viewModel.isTogglingTwoFactor,
                )
            }
            viewModel.toggleError?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            Spacer(Modifier.height(32.dp))
            OutlinedButton(
                onClick = { viewModel.logout(); onLoggedOut() },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Log out") }
        }
    }

    if (showDisable2faDialog) {
        var password by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showDisable2faDialog = false },
            title = { Text("Disable two-factor authentication?") },
            text = {
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Confirm your password") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.setTwoFactor(false, password)
                    showDisable2faDialog = false
                }) { Text("Disable") }
            },
            dismissButton = { TextButton(onClick = { showDisable2faDialog = false }) { Text("Cancel") } },
        )
    }
}
