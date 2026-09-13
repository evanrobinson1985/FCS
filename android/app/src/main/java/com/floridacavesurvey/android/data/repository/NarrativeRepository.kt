package com.floridacavesurvey.android.data.repository

import com.floridacavesurvey.android.data.model.*
import com.floridacavesurvey.android.data.network.ApiService
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

class NarrativeRepository(private val api: ApiService) {

    suspend fun getCavesWithNarratives(): List<String> = api.getCavesWithNarratives()

    suspend fun getNarrative(caveId: String): List<NarrativeEntry> = api.getNarrative(caveId)

    suspend fun createNarrative(caveId: String, caveName: String?, html: String, images: List<NarrativeImage>) =
        api.saveNarrative(SaveNarrativeRequest(id = caveId, name = caveName, html = html, images = images, isEditing = false))

    suspend fun updateNarrative(caveId: String, caveName: String?, html: String, images: List<NarrativeImage>, originalTimestamp: String) =
        api.saveNarrative(
            SaveNarrativeRequest(
                id = caveId,
                name = caveName,
                html = html,
                images = images,
                isEditing = true,
                originalTimestamp = originalTimestamp,
            ),
        )

    suspend fun deleteNarrative(caveId: String, timestamp: String) =
        api.deleteNarrative(DeleteNarrativeRequest(caveId, timestamp))

    suspend fun deleteNarrativeImage(caveId: String, narrativeTimestamp: String, narrativeUser: String, imageIndex: Int, imageUrl: String) =
        api.deleteNarrativeImage(DeleteNarrativeImageRequest(caveId, narrativeTimestamp, narrativeUser, imageIndex, imageUrl))

    suspend fun uploadImage(file: File, mimeType: String): String {
        val body = file.asRequestBody(mimeType.toMediaTypeOrNull())
        val part = MultipartBody.Part.createFormData("image", file.name, body)
        return api.uploadNarrativeImage(part).imageUrl
    }

    suspend fun getAllNarrativesLog(): List<NarrativeLogEntry> = api.getAllNarrativesLog()
}
