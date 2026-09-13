package com.floridacavesurvey.android.ui.caves

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.*
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaveDetailScreen(
    caveId: String,
    canEdit: Boolean,
    onBack: () -> Unit,
    onViewNarrative: (String) -> Unit,
    onProposeEdit: (CaveRecord) -> Unit,
) {
    val container = localAppContainer()
    val viewModel: CaveDetailViewModel = viewModel(
        factory = viewModelFactory { initializer { CaveDetailViewModel(container.caveRepository, caveId) } },
    )
    var showEditSheet by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(caveId) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) } },
                actions = {
                    val cave = (viewModel.state as? com.floridacavesurvey.android.data.network.UiState.Success)?.data
                    if (cave != null) {
                        IconButton(onClick = {
                            if (canEdit) showEditSheet = true else onProposeEdit(cave)
                        }) { Icon(Icons.Filled.Edit, contentDescription = if (canEdit) "Edit" else "Propose edit") }
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            UiStateContent(state = viewModel.state, onRetry = viewModel::load) { cave ->
                CaveDetailContent(cave, onViewNarrative = { onViewNarrative(caveId) })
            }

            val cave = (viewModel.state as? com.floridacavesurvey.android.data.network.UiState.Success)?.data
            if (showEditSheet && cave != null) {
                CaveQuickEditSheet(
                    cave = cave,
                    saving = viewModel.saveInFlight,
                    error = viewModel.saveError,
                    onDismiss = { showEditSheet = false },
                    onSave = { edits -> viewModel.saveEdits(edits) { showEditSheet = false } },
                )
            }
        }
    }
}

@Composable
private fun CaveDetailContent(cave: CaveRecord, onViewNarrative: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text(CaveFields.name(cave)?.ifBlank { "(unnamed cave)" } ?: "(unnamed cave)", style = MaterialTheme.typography.titleLarge)
        Text(
            listOfNotNull(CaveFields.state(cave), CaveFields.county(cave)).joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(16.dp))
        SectionCard("Overview") {
            DetailRow("Type", CaveFields.type(cave))
            DetailRow("Latitude", CaveFields.latitude(cave)?.toString())
            DetailRow("Longitude", CaveFields.longitude(cave)?.toString())
            DetailRow("Length", CaveFields.length(cave))
            DetailRow("Vertical extent", CaveFields.vertical(cave))
            DetailRow("Water depth", CaveFields.waterDepth(cave))
            DetailRow("Deepest pitch", CaveFields.pitch(cave))
        }

        val hazards = CaveFields.hazards(cave)
        if (hazards != null) {
            Spacer(Modifier.height(12.dp))
            SectionCard("Hazards") {
                DetailRow("Bad air", (hazards["badAir"] as? Boolean)?.let { if (it) "Yes" else "No" })
                DetailRow("Unstable", (hazards["unstable"] as? Boolean)?.let { if (it) "Yes" else "No" })
                DetailRow("Casualties", (hazards["casualties"] as? Boolean)?.let { if (it) "Yes" else "No" })
                DetailRow("Notes", hazards["notes"] as? String)
            }
        }

        val equipment = CaveFields.equipment(cave)
        if (equipment.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            SectionCard("Equipment needed") {
                Text(equipment.joinToString(", ") { code -> EQUIPMENT_LABELS[code] ?: code })
            }
        }

        val exploration = CaveFields.exploration(cave)
        if (exploration.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            SectionCard("Exploration potential") {
                Text(exploration.joinToString(", ") { code -> EXPLORATION_LABELS[code] ?: code })
            }
        }

        if (!CaveFields.notes(cave).isNullOrBlank()) {
            Spacer(Modifier.height(12.dp))
            SectionCard("Notes") { Text(CaveFields.notes(cave)!!) }
        }

        Spacer(Modifier.height(20.dp))
        OutlinedButton(onClick = onViewNarrative, modifier = Modifier.fillMaxWidth()) {
            Text("View narratives & photos")
        }

        Spacer(Modifier.height(12.dp))
        SectionCard("Record info") {
            DetailRow("Last updated", CaveFields.lastUpdated(cave))
            DetailRow("Updated by", CaveFields.updatedBy(cave))
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String?) {
    if (value.isNullOrBlank()) return
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, modifier = Modifier.weight(0.4f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, modifier = Modifier.weight(0.6f))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CaveQuickEditSheet(
    cave: CaveRecord,
    saving: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSave: (Map<String, Any?>) -> Unit,
) {
    var name by remember { mutableStateOf(CaveFields.name(cave).orEmpty()) }
    var notes by remember { mutableStateOf(CaveFields.notes(cave).orEmpty()) }
    var latitude by remember { mutableStateOf(CaveFields.latitude(cave)?.toString().orEmpty()) }
    var longitude by remember { mutableStateOf(CaveFields.longitude(cave)?.toString().orEmpty()) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(16.dp).padding(bottom = 32.dp)) {
            Text("Edit cave", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Row {
                OutlinedTextField(value = latitude, onValueChange = { latitude = it }, label = { Text("Latitude") }, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                OutlinedTextField(value = longitude, onValueChange = { longitude = it }, label = { Text("Longitude") }, modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(value = notes, onValueChange = { notes = it }, label = { Text("Notes") }, minLines = 3, modifier = Modifier.fillMaxWidth())

            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }

            Spacer(Modifier.height(16.dp))
            Button(
                onClick = {
                    val edits = mutableMapOf<String, Any?>("name" to name, "notes" to notes)
                    latitude.toDoubleOrNull()?.let { edits["latitude"] = it }
                    longitude.toDoubleOrNull()?.let { edits["longitude"] = it }
                    onSave(edits)
                },
                enabled = !saving,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (saving) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Save")
            }
        }
    }
}
