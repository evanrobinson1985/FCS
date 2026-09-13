package com.floridacavesurvey.android.data.model

data class NarrativeImage(
    val url: String,
    val alt: String? = null,
    val caption: String? = null,
)

data class NarrativeEntry(
    val id: String,
    val name: String? = null,
    val html: String,
    val user: String,
    val images: List<NarrativeImage>? = null,
    val timestamp: String,
    val lastModified: String? = null,
)

data class SaveNarrativeRequest(
    val id: String,
    val name: String? = null,
    val html: String,
    val images: List<NarrativeImage>? = null,
    val isEditing: Boolean = false,
    val originalTimestamp: String? = null,
)

data class DeleteNarrativeRequest(
    val caveId: String,
    val timestamp: String,
    val logDeletion: Boolean = true,
)

data class DeleteNarrativeResponse(
    val success: Boolean,
    val message: String,
    val remainingNarratives: Int? = null,
)

data class DeleteNarrativeImageRequest(
    val caveId: String,
    val narrativeTimestamp: String,
    val narrativeUser: String,
    val imageIndex: Int,
    val imageUrl: String,
)

data class UploadNarrativeImageResponse(val imageUrl: String)

data class NarrativeLogEntry(
    val caveId: String,
    val caveName: String? = null,
    val user: String,
    val timestamp: String,
    val lastModified: String? = null,
    val isEdited: Boolean = false,
    val isDeleted: Boolean = false,
    val originalUser: String? = null,
    val originalTimestamp: String? = null,
)
