package com.floridacavesurvey.android.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import com.floridacavesurvey.android.data.model.StateInfo
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.AuthRepository
import com.floridacavesurvey.android.data.repository.CaveRepository
import com.floridacavesurvey.android.ui.localAppContainer
import kotlinx.coroutines.launch

class CreateAccountViewModel(
    private val authRepo: AuthRepository,
    private val caveRepo: CaveRepository,
) : ViewModel() {
    var states by mutableStateOf<List<StateInfo>>(emptyList())
        private set
    var isLoading by mutableStateOf(false)
        private set
    var succeeded by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    init {
        viewModelScope.launch {
            safeApiCall { caveRepo.getStates() }.onSuccess { states = it }
        }
    }

    fun submit(username: String, email: String, password: String, selectedStates: Set<String>) {
        if (selectedStates.isEmpty()) {
            errorMessage = "Choose at least one state you'll be reporting caves in."
            return
        }
        if (password.length < 10) {
            errorMessage = "Password must be at least 10 characters long"
            return
        }
        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            safeApiCall { authRepo.createAccount(username, email, password, selectedStates.toList()) }
                .onSuccess { succeeded = true }
                .onFailure { errorMessage = it.message }
            isLoading = false
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateAccountScreen(onBack: () -> Unit) {
    val container = localAppContainer()
    val viewModel: CreateAccountViewModel = viewModel(
        factory = viewModelFactory {
            initializer { CreateAccountViewModel(container.authRepository, container.caveRepository) }
        },
    )
    var username by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val selectedStates = remember { mutableStateListOf<String>() }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Create Account") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) } },
        )
    }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(24.dp).fillMaxWidth().verticalScroll(rememberScrollState()),
        ) {
            if (viewModel.succeeded) {
                Text("Account created. An administrator must approve it before you can log in.")
                Spacer(Modifier.height(16.dp))
                Button(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Back to login") }
                return@Column
            }

            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("Username") },
                singleLine = true,
                supportingText = { Text("3-32 characters: letters, numbers, . _ -") },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                supportingText = { Text("At least 10 characters") },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(20.dp))
            Text("States you'll report caves in", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            if (viewModel.states.isEmpty()) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                viewModel.states.forEach { state ->
                    val checked = selectedStates.contains(state.code)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = checked,
                            onCheckedChange = {
                                if (it) selectedStates.add(state.code) else selectedStates.remove(state.code)
                            },
                        )
                        Text(state.name)
                    }
                }
            }

            viewModel.errorMessage?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }

            Spacer(Modifier.height(20.dp))
            Button(
                onClick = { viewModel.submit(username, email, password, selectedStates.toSet()) },
                enabled = !viewModel.isLoading && username.isNotBlank() && email.isNotBlank() && password.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (viewModel.isLoading) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Text("Create account")
                }
            }
        }
    }
}
