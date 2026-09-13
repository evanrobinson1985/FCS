package com.floridacavesurvey.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.Submission
import com.floridacavesurvey.android.ui.common.EmptyState
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer

@Composable
fun SubmissionsScreen() {
    val container = localAppContainer()
    val viewModel: SubmissionsViewModel = viewModel(
        factory = viewModelFactory { initializer { SubmissionsViewModel(container.submissionRepository) } },
    )
    var rejectingId by remember { mutableStateOf<String?>(null) }

    UiStateContent(state = viewModel.pending, onRetry = viewModel::load) { submissions ->
        if (submissions.isEmpty()) {
            EmptyState("No pending submissions.")
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(submissions, key = { it.submissionId }) { submission ->
                    SubmissionCard(
                        submission = submission,
                        onApprove = { viewModel.approve(submission.submissionId) },
                        onReject = { rejectingId = submission.submissionId },
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    val rejecting = rejectingId
    if (rejecting != null) {
        var reason by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { rejectingId = null },
            title = { Text("Reject submission") },
            text = {
                OutlinedTextField(value = reason, onValueChange = { reason = it }, label = { Text("Reason (optional)") })
            },
            confirmButton = {
                TextButton(onClick = { viewModel.reject(rejecting, reason.ifBlank { null }); rejectingId = null }) { Text("Reject") }
            },
            dismissButton = { TextButton(onClick = { rejectingId = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SubmissionCard(submission: Submission, onApprove: () -> Unit, onReject: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Text(submission.caveName ?: submission.caveId, fontWeight = FontWeight.SemiBold)
        Text(
            "${submission.type} · by ${submission.submittedBy ?: "unknown"} · ${listOfNotNull(submission.state, submission.county).joinToString(", ")}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        submission.proposedData?.forEach { (key, value) ->
            if (value != null && value.toString().isNotBlank()) {
                Text("$key: $value", style = MaterialTheme.typography.bodySmall)
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onApprove) { Text("Approve") }
            OutlinedButton(onClick = onReject) { Text("Reject") }
        }
    }
}
