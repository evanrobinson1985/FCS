package com.floridacavesurvey.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.SecurityLogEntry
import com.floridacavesurvey.android.ui.common.EmptyState
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer

@Composable
fun SecurityLogsScreen() {
    val container = localAppContainer()
    val viewModel: SecurityLogsViewModel = viewModel(
        factory = viewModelFactory { initializer { SecurityLogsViewModel(container.adminRepository) } },
    )

    UiStateContent(state = viewModel.logs, onRetry = viewModel::load) { logs ->
        if (logs.isEmpty()) {
            EmptyState("No security log entries.")
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(logs) { entry -> LogRow(entry) }
            }
        }
    }
}

@Composable
private fun LogRow(entry: SecurityLogEntry) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row {
            Text(entry.action, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(entry.timestamp, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("${entry.username} · ${entry.ipAddress ?: "unknown"}", style = MaterialTheme.typography.bodyMedium)
        entry.details?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
    HorizontalDivider()
}
