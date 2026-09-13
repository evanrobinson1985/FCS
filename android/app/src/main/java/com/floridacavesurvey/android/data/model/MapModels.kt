package com.floridacavesurvey.android.data.model

data class CaveMapFile(
    val id: String,
    val name: String,
    val type: String, // "geotiff" | "shapefile"
    val url: String,
    val baseUrl: String? = null,
    val size: Long? = null,
    val dateAdded: String? = null,
)

data class CaveMapCollectionFile(
    val filename: String,
    val name: String,
    val url: String,
    val size: Long? = null,
    val dateAdded: String? = null,
)

data class UploadCaveMapsResponse(val message: String, val files: List<String>)

data class HillshadeFile(
    val name: String,
    val size: Long? = null,
    val modified: String? = null,
)

data class HillshadeBounds(
    val bounds: List<List<Double>>, // [[lat1,lng1],[lat2,lng2]]
    val minZoom: Int,
    val maxZoom: Int,
    val method: String? = null,
    val tileCount: Int? = null,
) {
    /** South-West / North-East corners, the shape osmdroid's BoundingBox wants. */
    val southWest: Pair<Double, Double>? get() = bounds.getOrNull(0)?.let { it[0] to it[1] }
    val northEast: Pair<Double, Double>? get() = bounds.getOrNull(1)?.let { it[0] to it[1] }
}
