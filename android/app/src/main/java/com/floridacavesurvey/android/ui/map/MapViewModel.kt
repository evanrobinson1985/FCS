package com.floridacavesurvey.android.ui.map

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.floridacavesurvey.android.data.TokenStore
import com.floridacavesurvey.android.data.model.CaveRecord
import com.floridacavesurvey.android.data.model.HillshadeBounds
import com.floridacavesurvey.android.data.model.HillshadeFile
import com.floridacavesurvey.android.data.network.UiState
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.CaveRepository
import com.floridacavesurvey.android.data.repository.MapRepository
import kotlinx.coroutines.launch

class MapViewModel(
    private val mapRepo: MapRepository,
    private val caveRepo: CaveRepository,
    val tokenStore: TokenStore,
) : ViewModel() {

    var hillshadeFiles by mutableStateOf<List<HillshadeFile>>(emptyList())
        private set
    var selectedHillshade by mutableStateOf<HillshadeFile?>(null)
        private set
    var selectedBounds by mutableStateOf<HillshadeBounds?>(null)
        private set
    var caves by mutableStateOf<UiState<List<CaveRecord>>>(UiState.Loading)
        private set

    init {
        viewModelScope.launch {
            safeApiCall { mapRepo.getHillshadeList() }.onSuccess { hillshadeFiles = it }
            safeApiCall { caveRepo.getCaveDatabase() }
                .onSuccess { caves = UiState.Success(it) }
                .onFailure { caves = UiState.Error(it.message ?: "Failed to load caves") }
        }
    }

    fun selectHillshade(file: HillshadeFile?) {
        selectedHillshade = file
        selectedBounds = null
        if (file != null) {
            viewModelScope.launch {
                safeApiCall { mapRepo.getHillshadeBounds(file.name) }.onSuccess { selectedBounds = it }
            }
        }
    }
}
