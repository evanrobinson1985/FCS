package com.floridacavesurvey.android.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
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

class ForgotPasswordViewModel(private val repo: AuthRepository) : ViewModel() {
    var isLoading by mutableStateOf(false)
        private set
    var resultMessage by mutableStateOf<String?>(null)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    fun submit(email: String) {
        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            safeApiCall { repo.forgotPassword(email) }
                .onSuccess { resultMessage = it }
                .onFailure { errorMessage = it.message }
            isLoading = false
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForgotPasswordScreen(onBack: () -> Unit, onHaveResetToken: () -> Unit) {
    val container = localAppContainer()
    val viewModel: ForgotPasswordViewModel = viewModel(
        factory = viewModelFactory { initializer { ForgotPasswordViewModel(container.authRepository) } },
    )
    var email by remember { mutableStateOf("") }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Forgot Password") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) } },
        )
    }) { padding ->
        Column(modifier = Modifier.padding(padding).padding(24.dp).fillMaxWidth()) {
            if (viewModel.resultMessage != null) {
                Text(viewModel.resultMessage!!)
                Spacer(Modifier.height(16.dp))
                Button(onClick = onHaveResetToken, modifier = Modifier.fillMaxWidth()) { Text("I have a reset code") }
            } else {
                Text("Enter your account's email address and we'll send a link to reset your password.")
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                viewModel.errorMessage?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = { viewModel.submit(email) },
                    enabled = !viewModel.isLoading && email.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (viewModel.isLoading) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        Text("Send reset link")
                    }
                }
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onHaveResetToken, modifier = Modifier.fillMaxWidth()) {
                    Text("I already have a reset code")
                }
            }
        }
    }
}
