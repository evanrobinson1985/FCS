package com.floridacavesurvey.android.ui.statistics

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.floridacavesurvey.android.data.model.StatisticsSnapshot
import com.floridacavesurvey.android.data.network.UiState
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.StatisticsRepository
import kotlinx.coroutines.launch

/** Recomputes fresh on every load() - same as the website re-running updateStatistics() on every
 * visit to the Statistics tab rather than caching. */
class StatisticsViewModel(private val repo: StatisticsRepository) : ViewModel() {

    var state by mutableStateOf<UiState<StatisticsSnapshot>>(UiState.Loading)
        private set

    init { load() }

    fun load() {
        viewModelScope.launch {
            state = UiState.Loading
            safeApiCall { repo.loadSnapshot() }
                .onSuccess { state = UiState.Success(it) }
                .onFailure { state = UiState.Error(it.message ?: "Failed to load statistics") }
        }
    }
}
