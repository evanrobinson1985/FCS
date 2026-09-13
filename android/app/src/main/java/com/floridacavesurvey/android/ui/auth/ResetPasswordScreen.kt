package com.floridacavesurvey.android.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.AuthRepository
import com.floridacavesurvey.android.ui.localAppContainer
import kotlinx.coroutines.launch

class ResetPasswordViewModel(private val repo: AuthRepository) : ViewModel() {
    var isLoading by mutableStateOf(false)
        private set
    var succeeded by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    fun submit(token: String, newPassword: String) {
        if (newPassword.length < 10) {
            errorMessage = "Password must be at least 10 characters long"
            return
        }
        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            safeApiCall { repo.resetPassword(token, newPassword) }
                .onSuccess { succeeded = true }
                .onFailure { errorMessage = it.message }
            isLoading = false
        }
    }
}

/** Reached either by pasting the reset token from the emailed link, or (if the OS handed the app
 * a `floridacavesurvey://reset?token=...` deep link) with [initialToken] pre-filled. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResetPasswordScreen(initialToken: String, onBack: () -> Unit, onDone: () -> Unit) {
    val container = localAppContainer()
    val viewModel: ResetPasswordViewModel = viewModel(
        factory = viewModelFactory { initializer { ResetPasswordViewModel(container.authRepository) } },
    )
    var token by remember { mutableStateOf(initialToken) }
    var newPassword by remember { mutableStateOf("") }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Reset Password") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) } },
        )
    }) { padding ->
        Column(modifier = Modifier.padding(padding).padding(24.dp).fillMaxWidth()) {
            if (viewModel.succeeded) {
                Text("Password updated. You can now log in with your new password.")
                Spacer(Modifier.height(16.dp))
                Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text("Back to login") }
            } else {
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("Reset token (from the emailed link)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = newPassword,
                    onValueChange = { newPassword = it },
                    label = { Text("New password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    supportingText = { Text("At least 10 characters") },
                    modifier = Modifier.fillMaxWidth(),
                )
                viewModel.errorMessage?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = { viewModel.submit(token, newPassword) },
                    enabled = !viewModel.isLoading && token.isNotBlank() && newPassword.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (viewModel.isLoading) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        Text("Reset password")
                    }
                }
            }
        }
    }
}
