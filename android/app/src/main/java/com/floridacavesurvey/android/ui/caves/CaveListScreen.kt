package com.floridacavesurvey.android.ui.caves

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.CaveFields
import com.floridacavesurvey.android.data.model.CaveRecord
import com.floridacavesurvey.android.data.network.UiState
import com.floridacavesurvey.android.ui.common.EmptyState
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaveListScreen(onOpenCave: (String) -> Unit) {
    val container = localAppContainer()
    val viewModel: CaveListViewModel = viewModel(
        factory = viewModelFactory { initializer { CaveListViewModel(container.caveRepository) } },
    )

    Column(modifier = Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = viewModel.query,
            onValueChange = viewModel::onQueryChanged,
            placeholder = { Text("Search caves by name, ID, or county") },
            leadingIcon = { Icon(Icons.Filled.Search, null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        )

        viewModel.stateCounts?.let { counts ->
            LazyRowStateFilter(
                states = counts.states.map { it.code to it.name },
                selected = viewModel.selectedState,
                onSelected = viewModel::onStateFilterChanged,
            )
        }

        UiStateContent(state = viewModel.state, onRetry = viewModel::load) { caves ->
            if (caves.isEmpty()) {
                EmptyState("No caves match your search.")
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(caves, key = { CaveFields.id(it) ?: it.hashCode().toString() }) { cave ->
                        CaveRow(cave, onClick = { CaveFields.id(cave)?.let(onOpenCave) })
                    }
                }
            }
        }
    }
}

@Composable
private fun LazyRowStateFilter(states: List<Pair<String, String>>, selected: String?, onSelected: (String?) -> Unit) {
    androidx.compose.foundation.lazy.LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(bottom = 8.dp),
    ) {
        item {
            FilterChip(selected = selected == null, onClick = { onSelected(null) }, label = { Text("All") })
        }
        items(states) { (code, name) ->
            FilterChip(selected = selected == code, onClick = { onSelected(if (selected == code) null else code) }, label = { Text(name) })
        }
    }
}

@Composable
private fun CaveRow(cave: CaveRecord, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.secondaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Text(CaveFields.state(cave)?.take(2) ?: "?", style = MaterialTheme.typography.labelLarge)
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(CaveFields.name(cave)?.ifBlank { "(unnamed cave)" } ?: "(unnamed cave)", style = MaterialTheme.typography.titleMedium)
            Text(
                listOfNotNull(CaveFields.id(cave), CaveFields.county(cave)).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    HorizontalDivider()
}
