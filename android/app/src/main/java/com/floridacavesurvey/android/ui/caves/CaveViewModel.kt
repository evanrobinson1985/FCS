package com.floridacavesurvey.android.ui.caves

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.floridacavesurvey.android.data.model.CaveFields
import com.floridacavesurvey.android.data.model.CaveRecord
import com.floridacavesurvey.android.data.model.StateCountsResponse
import com.floridacavesurvey.android.data.network.UiState
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.CaveRepository
import kotlinx.coroutines.launch

class CaveListViewModel(private val repo: CaveRepository) : ViewModel() {

    var state by mutableStateOf<UiState<List<CaveRecord>>>(UiState.Loading)
        private set
    var stateCounts by mutableStateOf<StateCountsResponse?>(null)
        private set
    var query by mutableStateOf("")
        private set
    var selectedState by mutableStateOf<String?>(null)
        private set

    private var allCaves: List<CaveRecord> = emptyList()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            state = UiState.Loading
            safeApiCall { repo.getCaveDatabase() }
                .onSuccess {
                    allCaves = it
                    applyFilter()
                }
                .onFailure { state = UiState.Error(it.message ?: "Failed to load caves") }

            safeApiCall { repo.getStateCounts() }.onSuccess { stateCounts = it }
        }
    }

    fun onQueryChanged(newQuery: String) {
        query = newQuery
        applyFilter()
    }

    fun onStateFilterChanged(newState: String?) {
        selectedState = newState
        applyFilter()
    }

    private fun applyFilter() {
        state = UiState.Success(repo.filter(allCaves, query, selectedState))
    }
}

class CaveDetailViewModel(private val repo: CaveRepository, private val caveId: String) : ViewModel() {

    var state by mutableStateOf<UiState<CaveRecord>>(UiState.Loading)
        private set
    var saveInFlight by mutableStateOf(false)
        private set
    var saveError by mutableStateOf<String?>(null)
        private set

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            state = UiState.Loading
            safeApiCall { repo.getCaveDatabase() }
                .onSuccess { caves ->
                    val match = caves.find { CaveFields.id(it) == caveId }
                    state = if (match != null) UiState.Success(match) else UiState.Error("Cave $caveId not found.")
                }
                .onFailure { state = UiState.Error(it.message ?: "Failed to load cave") }
        }
    }

    /** Direct save - only reachable for admin/webmaster; members go through submissions instead. */
    fun saveEdits(edits: Map<String, Any?>, onSaved: () -> Unit) {
        val current = (state as? UiState.Success)?.data ?: return
        val merged = CaveFields.withEdits(current, edits)
        viewModelScope.launch {
            saveInFlight = true
            saveError = null
            safeApiCall { repo.updateCave(merged) }
                .onSuccess {
                    state = UiState.Success(merged)
                    onSaved()
                }
                .onFailure { saveError = it.message }
            saveInFlight = false
        }
    }
}
