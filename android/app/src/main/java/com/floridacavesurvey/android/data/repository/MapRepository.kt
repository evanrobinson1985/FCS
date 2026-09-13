package com.floridacavesurvey.android.data.repository

import com.floridacavesurvey.android.data.model.*
import com.floridacavesurvey.android.data.network.ApiService
import okhttp3.MultipartBody

class MapRepository(private val api: ApiService) {

    suspend fun getCaveMaps(): List<CaveMapFile> = api.getCaveMaps()

    suspend fun getCaveMapsCollection(): List<CaveMapCollectionFile> = api.getCaveMapsCollection()

    suspend fun uploadCaveMaps(parts: List<MultipartBody.Part>): UploadCaveMapsResponse = api.uploadCaveMaps(parts)

    suspend fun deleteCaveMap(type: String, filename: String) = api.deleteCaveMap(type, filename)

    suspend fun getHillshadeList(): List<HillshadeFile> = api.getHillshadeList()

    suspend fun getHillshadeBounds(filename: String): HillshadeBounds = api.getHillshadeBounds(filename)
}
