package com.floridacavesurvey.android.ui.caves

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
import com.floridacavesurvey.android.data.model.CaveFields
import com.floridacavesurvey.android.data.model.CaveRecord
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.SubmissionRepository
import com.floridacavesurvey.android.ui.localAppContainer
import kotlinx.coroutines.launch

class ProposeCaveEditViewModel(private val repo: SubmissionRepository) : ViewModel() {
    var isLoading by mutableStateOf(false)
        private set
    var succeeded by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    fun submit(caveId: String, caveName: String?, county: String?, proposedData: Map<String, Any?>) {
        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            safeApiCall { repo.create("edit_cave", caveId, caveName, county, proposedData) }
                .onSuccess { succeeded = true }
                .onFailure { errorMessage = it.message }
            isLoading = false
        }
    }
}

/** A member's proposed change to an existing cave record - goes to the admin/webmaster review
 * queue (GET /api/pending-submissions) rather than writing the cave database directly. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProposeCaveEditScreen(cave: CaveRecord, onBack: () -> Unit) {
    val container = localAppContainer()
    val viewModel: ProposeCaveEditViewModel = viewModel(
        factory = viewModelFactory { initializer { ProposeCaveEditViewModel(container.submissionRepository) } },
    )
    var name by remember { mutableStateOf(CaveFields.name(cave).orEmpty()) }
    var notes by remember { mutableStateOf(CaveFields.notes(cave).orEmpty()) }
    var latitude by remember { mutableStateOf(CaveFields.latitude(cave)?.toString().orEmpty()) }
    var longitude by remember { mutableStateOf(CaveFields.longitude(cave)?.toString().orEmpty()) }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Propose an edit") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) } },
        )
    }) { padding ->
        Column(modifier = Modifier.padding(padding).padding(16.dp).fillMaxWidth()) {
            if (viewModel.succeeded) {
                Text("Thanks - your proposed edit was submitted for review.")
                Spacer(Modifier.height(16.dp))
                Button(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Done") }
                return@Column
            }

            Text("Changes are reviewed by an administrator before they're applied.", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Row {
                OutlinedTextField(value = latitude, onValueChange = { latitude = it }, label = { Text("Latitude") }, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                OutlinedTextField(value = longitude, onValueChange = { longitude = it }, label = { Text("Longitude") }, modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(value = notes, onValueChange = { notes = it }, label = { Text("Notes") }, minLines = 3, modifier = Modifier.fillMaxWidth())

            viewModel.errorMessage?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }

            Spacer(Modifier.height(16.dp))
            Button(
                onClick = {
                    val proposed = mutableMapOf<String, Any?>("name" to name, "notes" to notes)
                    latitude.toDoubleOrNull()?.let { proposed["latitude"] = it }
                    longitude.toDoubleOrNull()?.let { proposed["longitude"] = it }
                    viewModel.submit(CaveFields.id(cave) ?: return@Button, name, CaveFields.county(cave), proposed)
                },
                enabled = !viewModel.isLoading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (viewModel.isLoading) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Submit for review")
            }
        }
    }
}
