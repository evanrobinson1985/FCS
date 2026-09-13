package com.floridacavesurvey.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.SiteConfig
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer

@Composable
fun SiteConfigScreen() {
    val container = localAppContainer()
    val viewModel: SiteConfigViewModel = viewModel(
        factory = viewModelFactory { initializer { SiteConfigViewModel(container.siteConfigRepository) } },
    )

    UiStateContent(state = viewModel.config, onRetry = viewModel::load) { config ->
        SiteConfigForm(config, viewModel.isSaving, viewModel.saveError, viewModel::update)
    }
}

@Composable
private fun SiteConfigForm(config: SiteConfig, isSaving: Boolean, saveError: String?, onUpdate: (Map<String, Any?>) -> Unit) {
    var maintenanceMode by remember(config) { mutableStateOf(config.maintenanceMode) }
    var maintenanceMessage by remember(config) { mutableStateOf(config.maintenanceMessage.orEmpty()) }
    var bannerEnabled by remember(config) { mutableStateOf(config.bannerEnabled) }
    var bannerMessage by remember(config) { mutableStateOf(config.bannerMessage.orEmpty()) }
    var readOnlyMode by remember(config) { mutableStateOf(config.readOnlyMode) }
    var readOnlyMessage by remember(config) { mutableStateOf(config.readOnlyMessage.orEmpty()) }
    var lockoutThreshold by remember(config) { mutableStateOf((config.loginLockoutThreshold ?: 5).toString()) }
    var lockoutMinutes by remember(config) { mutableStateOf((config.loginLockoutMinutes ?: 15).toString()) }
    var autoUpdateEnabled by remember(config) { mutableStateOf(config.autoUpdateEnabled ?: false) }
    var autoUpdateTime by remember(config) { mutableStateOf(config.autoUpdateTime ?: "03:00") }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        ConfigSection("Maintenance mode") {
            ToggleRow("Site under maintenance", maintenanceMode) { maintenanceMode = it }
            OutlinedTextField(
                value = maintenanceMessage,
                onValueChange = { maintenanceMessage = it },
                label = { Text("Message shown to visitors") },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = { onUpdate(mapOf("maintenanceMode" to maintenanceMode, "maintenanceMessage" to maintenanceMessage)) }) {
                Text("Save maintenance settings")
            }
        }

        ConfigSection("Site banner") {
            ToggleRow("Show banner", bannerEnabled) { bannerEnabled = it }
            OutlinedTextField(
                value = bannerMessage,
                onValueChange = { bannerMessage = it },
                label = { Text("Banner message") },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = { onUpdate(mapOf("bannerEnabled" to bannerEnabled, "bannerMessage" to bannerMessage)) }) {
                Text("Save banner settings")
            }
        }

        ConfigSection("Read-only mode") {
            ToggleRow("Block member writes", readOnlyMode) { readOnlyMode = it }
            OutlinedTextField(
                value = readOnlyMessage,
                onValueChange = { readOnlyMessage = it },
                label = { Text("Message shown when blocked") },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = { onUpdate(mapOf("readOnlyMode" to readOnlyMode, "readOnlyMessage" to readOnlyMessage)) }) {
                Text("Save read-only settings")
            }
        }

        ConfigSection("Login lockout policy") {
            Row {
                OutlinedTextField(
                    value = lockoutThreshold,
                    onValueChange = { lockoutThreshold = it },
                    label = { Text("Failed attempts (3-20)") },
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                OutlinedTextField(
                    value = lockoutMinutes,
                    onValueChange = { lockoutMinutes = it },
                    label = { Text("Lockout minutes (1-1440)") },
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(8.dp))
            Button(onClick = {
                val threshold = lockoutThreshold.toIntOrNull()
                val minutes = lockoutMinutes.toIntOrNull()
                if (threshold != null && minutes != null) {
                    onUpdate(mapOf("loginLockoutThreshold" to threshold, "loginLockoutMinutes" to minutes))
                }
            }) { Text("Save lockout policy") }
        }

        ConfigSection("Auto-update") {
            ToggleRow("Automatically pull updates daily", autoUpdateEnabled) { autoUpdateEnabled = it }
            OutlinedTextField(
                value = autoUpdateTime,
                onValueChange = { autoUpdateTime = it },
                label = { Text("Time (HH:MM, server local time)") },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = { onUpdate(mapOf("autoUpdateEnabled" to autoUpdateEnabled, "autoUpdateTime" to autoUpdateTime)) }) {
                Text("Save auto-update settings")
            }
        }

        saveError?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        if (isSaving) {
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun ConfigSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
