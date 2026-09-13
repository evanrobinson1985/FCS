package com.floridacavesurvey.android.data.repository

import com.floridacavesurvey.android.data.model.CaveFields
import com.floridacavesurvey.android.data.model.CaveRecord
import com.floridacavesurvey.android.data.model.SaveCaveActionRequest
import com.floridacavesurvey.android.data.model.SaveCaveResponse
import com.floridacavesurvey.android.data.model.StateCountsResponse
import com.floridacavesurvey.android.data.model.StateInfo
import com.floridacavesurvey.android.data.model.UpdateCaveLocationRequest
import com.floridacavesurvey.android.data.network.ApiService

class CaveRepository(private val api: ApiService) {

    suspend fun getCaveDatabase(): List<CaveRecord> = api.getCaveDatabase()

    suspend fun getStateCounts(): StateCountsResponse = api.getStateCounts()

    suspend fun getStates(): List<StateInfo> = api.getStates()

    suspend fun updateCave(cave: CaveRecord): SaveCaveResponse =
        api.updateCave(SaveCaveActionRequest("updateSingle", cave))

    suspend fun createCave(cave: CaveRecord): SaveCaveResponse =
        api.createCave(SaveCaveActionRequest("createNew", cave))

    suspend fun updateCaveLocation(id: String, latitude: Double, longitude: Double) =
        api.updateCaveLocation(UpdateCaveLocationRequest(id, latitude, longitude))

    /** Client-side search across the fields a member is most likely to filter by. */
    fun filter(caves: List<CaveRecord>, query: String, state: String?): List<CaveRecord> {
        val q = query.trim().lowercase()
        return caves.filter { cave ->
            (state == null || CaveFields.state(cave).equals(state, ignoreCase = true)) &&
                (
                    q.isEmpty() ||
                        CaveFields.name(cave)?.lowercase()?.contains(q) == true ||
                        CaveFields.id(cave)?.lowercase()?.contains(q) == true ||
                        CaveFields.county(cave)?.lowercase()?.contains(q) == true
                    )
        }
    }
}
