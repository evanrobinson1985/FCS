package com.floridacavesurvey.android.ui.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.BuildConfig
import com.floridacavesurvey.android.data.model.SessionUser
import com.floridacavesurvey.android.ui.localAppContainer
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(
    onLoggedIn: (SessionUser) -> Unit,
    onForgotPassword: () -> Unit,
    onCreateAccount: () -> Unit,
) {
    val container = localAppContainer()
    val viewModel: AuthViewModel = viewModel(
        factory = viewModelFactory { initializer { AuthViewModel(container.authRepository) } },
    )

    LaunchedEffect(viewModel.loggedInUser) {
        viewModel.loggedInUser?.let(onLoggedIn)
    }

    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Florida Cave Survey", style = MaterialTheme.typography.titleLarge)
            Text(
                "Webmaster Portal",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(32.dp))

            when (val step = viewModel.step) {
                is LoginStep.Credentials -> CredentialsForm(viewModel, onForgotPassword, onCreateAccount)
                is LoginStep.TwoFactor -> TwoFactorForm(viewModel, step)
            }
        }
    }
}

@Composable
private fun CredentialsForm(viewModel: AuthViewModel, onForgotPassword: () -> Unit, onCreateAccount: () -> Unit) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    if (BuildConfig.SHOW_GOOGLE_SIGN_IN) {
        GoogleSignInSection(viewModel)
        Spacer(Modifier.height(24.dp))
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            HorizontalDivider(modifier = Modifier.weight(1f))
            Text(
                "  or sign in with a password  ",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            HorizontalDivider(modifier = Modifier.weight(1f))
        }
        Spacer(Modifier.height(24.dp))
    }

    OutlinedTextField(
        value = username,
        onValueChange = { username = it; viewModel.clearError() },
        label = { Text("Username") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(
        value = password,
        onValueChange = { password = it; viewModel.clearError() },
        label = { Text("Password") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth(),
    )

    viewModel.errorMessage?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }

    Spacer(Modifier.height(20.dp))
    Button(
        onClick = { viewModel.login(username, password) },
        enabled = !viewModel.isLoading,
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (viewModel.isLoading) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        } else {
            Text("Log In")
        }
    }

    Spacer(Modifier.height(16.dp))
    TextButton(onClick = onForgotPassword) { Text("Forgot password?") }
    TextButton(onClick = onCreateAccount) { Text("Create an account") }
}

@Composable
private fun TwoFactorForm(viewModel: AuthViewModel, step: LoginStep.TwoFactor) {
    var code by remember { mutableStateOf("") }

    Text(step.message, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium)
    Spacer(Modifier.height(20.dp))
    OutlinedTextField(
        value = code,
        onValueChange = { if (it.length <= 6) code = it; viewModel.clearError() },
        label = { Text("6-digit code") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth(),
    )

    viewModel.errorMessage?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }

    Spacer(Modifier.height(20.dp))
    Button(
        onClick = { viewModel.submitTwoFactorCode(code) },
        enabled = !viewModel.isLoading,
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (viewModel.isLoading) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        } else {
            Text("Verify")
        }
    }
    Spacer(Modifier.height(12.dp))
    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
        TextButton(onClick = viewModel::backToCredentials) { Text("Back") }
        TextButton(onClick = viewModel::resendCode) { Text("Resend code") }
    }
}

/** "Continue with Google" - webmaster flavor only (BuildConfig.SHOW_GOOGLE_SIGN_IN). A successful
 * Google sign-in still lands on [LoginStep.TwoFactor]: it replaces the password check, not the
 * emailed code, which is the account's real second factor here (see /api/google-login). */
@Composable
private fun GoogleSignInSection(viewModel: AuthViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var googleError by remember { mutableStateOf<String?>(null) }

    OutlinedButton(
        onClick = {
            googleError = null
            scope.launch {
                requestGoogleIdToken(context)
                    .onSuccess { idToken -> viewModel.loginWithGoogle(idToken) }
                    .onFailure { googleError = it.message ?: "Google sign-in failed." }
            }
        },
        enabled = !viewModel.isLoading,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("Continue with Google")
    }
    googleError?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
}
