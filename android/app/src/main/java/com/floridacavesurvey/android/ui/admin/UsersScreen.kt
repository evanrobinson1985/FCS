package com.floridacavesurvey.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.AdminUser
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsersScreen() {
    val container = localAppContainer()
    val viewModel: UsersViewModel = viewModel(
        factory = viewModelFactory { initializer { UsersViewModel(container.adminRepository, container.caveRepository) } },
    )
    var editingStatesFor by remember { mutableStateOf<AdminUser?>(null) }

    Column(modifier = Modifier.fillMaxSize()) {
        viewModel.actionError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
        }
        UiStateContent(state = viewModel.users, onRetry = viewModel::load) { users ->
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(users, key = { it.id }) { user ->
                    UserRow(
                        user = user,
                        onApprove = { viewModel.approve(user.username) },
                        onDeactivate = { viewModel.deactivate(user.username) },
                        onChangeRole = { viewModel.changeRole(user.username, it) },
                        onEditStates = { editingStatesFor = user },
                        onDelete = { viewModel.deleteUser(user.username) },
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    val editing = editingStatesFor
    if (editing != null) {
        StateAssignmentDialog(
            user = editing,
            allStates = viewModel.states.map { it.code to it.name },
            onDismiss = { editingStatesFor = null },
            onSave = { selected -> viewModel.changeStates(editing.username, selected); editingStatesFor = null },
        )
    }
}

@Composable
private fun UserRow(
    user: AdminUser,
    onApprove: () -> Unit,
    onDeactivate: () -> Unit,
    onChangeRole: (String) -> Unit,
    onEditStates: () -> Unit,
    onDelete: () -> Unit,
) {
    var roleMenuExpanded by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(user.username, fontWeight = FontWeight.SemiBold)
                Text(
                    listOfNotNull(user.email, user.status).joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            AssistChip(onClick = { if (!user.isWebmaster) roleMenuExpanded = true }, label = { Text(user.role) })
            DropdownMenu(expanded = roleMenuExpanded, onDismissRequest = { roleMenuExpanded = false }) {
                listOf("member", "admin", "webmaster").forEach { role ->
                    DropdownMenuItem(text = { Text(role) }, onClick = { onChangeRole(role); roleMenuExpanded = false })
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (user.status != "active") {
                TextButton(onClick = onApprove) { Text("Activate") }
            } else if (!user.isWebmaster) {
                TextButton(onClick = onDeactivate) { Text("Deactivate") }
            }
            if (!user.isWebmaster) {
                TextButton(onClick = onEditStates) { Text("States") }
                TextButton(onClick = { confirmDelete = true }) { Text("Delete") }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete ${user.username}?") },
            text = { Text("This cannot be undone.") },
            confirmButton = { TextButton(onClick = { onDelete(); confirmDelete = false }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun StateAssignmentDialog(
    user: AdminUser,
    allStates: List<Pair<String, String>>,
    onDismiss: () -> Unit,
    onSave: (List<String>) -> Unit,
) {
    val selected = remember { mutableStateListOf(*user.allowedStates.orEmpty().toTypedArray()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("States for ${user.username}") },
        text = {
            Column {
                allStates.forEach { (code, name) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = selected.contains(code),
                            onCheckedChange = { if (it) selected.add(code) else selected.remove(code) },
                        )
                        Text(name)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onSave(selected.toList()) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
