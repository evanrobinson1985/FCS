package com.floridacavesurvey.android.data.model

/**
 * A cave-database record, kept as a raw `Map<String, Any?>` rather than a
 * fixed data class. The server (§9.3 of api-reference.md) has ~40 fields,
 * several written under two or three different aliased keys at once
 * (`lat`/`latitude`, `length`/`caveLength`, `waterDepth`/`water`/
 * `maxWaterDepth`, `pitch`/`deepestPitch`), plus a long tail of import-only
 * fields. A typed data class would either lose those on round-trip (load,
 * edit one field, save) or need to duplicate every aliased pair by hand. A
 * Map round-trips every field untouched and the accessors below just read
 * whichever alias is present; [withEdits] rebuilds the map with both
 * aliases of every pair kept in sync, matching what the web client does.
 */
typealias CaveRecord = Map<String, Any?>

object CaveFields {
    fun id(cave: CaveRecord): String? = cave["id"] as? String
    fun name(cave: CaveRecord): String? = cave["name"] as? String
    fun state(cave: CaveRecord): String? = cave["state"] as? String
    fun county(cave: CaveRecord): String? = cave["county"] as? String
    fun type(cave: CaveRecord): String? = cave["type"] as? String
    fun notes(cave: CaveRecord): String? = cave["notes"] as? String

    fun latitude(cave: CaveRecord): Double? =
        (cave["latitude"] as? Number)?.toDouble() ?: (cave["lat"] as? Number)?.toDouble()

    fun longitude(cave: CaveRecord): Double? =
        (cave["longitude"] as? Number)?.toDouble() ?: (cave["lng"] as? Number)?.toDouble()

    fun length(cave: CaveRecord): String? =
        (cave["length"] ?: cave["caveLength"])?.toString()

    fun vertical(cave: CaveRecord): String? =
        (cave["vertical"] ?: cave["verticalExtent"])?.toString()

    fun waterDepth(cave: CaveRecord): String? =
        (cave["waterDepth"] ?: cave["water"] ?: cave["maxWaterDepth"])?.toString()

    fun pitch(cave: CaveRecord): String? =
        (cave["pitch"] ?: cave["deepestPitch"])?.toString()

    @Suppress("UNCHECKED_CAST")
    fun equipment(cave: CaveRecord): List<String> = (cave["equipment"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()

    @Suppress("UNCHECKED_CAST")
    fun exploration(cave: CaveRecord): List<String> = (cave["exploration"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()

    @Suppress("UNCHECKED_CAST")
    fun hazards(cave: CaveRecord): Map<String, Any?>? = cave["hazards"] as? Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    fun entrances(cave: CaveRecord): List<Map<String, Any?>> = (cave["entrances"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> } ?: emptyList()

    // Statistics-only accessors (see StatisticsCalculator, ported field-for-field
    // from the website's updateStatistics() and friends).
    fun entryStatus(cave: CaveRecord): String? = cave["entryStatus"] as? String
    fun geology(cave: CaveRecord): String? = cave["geology"] as? String
    fun elevation(cave: CaveRecord): String? = cave["elevation"]?.toString()
    fun mapType(cave: CaveRecord): String? = cave["mapType"] as? String
    fun hazardousConditions(cave: CaveRecord): String? = cave["hazardousConditions"] as? String
    /** Raw "YYMM" discovery-date code, per the website's Cave Discovery Timeline chart. */
    fun dateCode(cave: CaveRecord): String? = cave["date"] as? String

    private val LEGACY_FLORIDA_ID_RE = Regex("^F([A-Z]{2})\\d+$")

    /**
     * Mirrors resolveCaveStateAndCounty() in both index.html and server.js: prefers the
     * explicit state/county fields, and only backfills whichever one is missing from a legacy
     * Florida cave ID (F + 2-letter county code + digits) - never overwrites an explicit value.
     */
    fun resolveStateAndCounty(cave: CaveRecord): Pair<String?, String?> {
        var resolvedState = state(cave)
        var resolvedCounty = county(cave)
        val id = id(cave)
        if ((resolvedState.isNullOrBlank() || resolvedCounty.isNullOrBlank()) && id != null) {
            val match = LEGACY_FLORIDA_ID_RE.find(id)
            if (match != null) {
                if (resolvedState.isNullOrBlank()) resolvedState = "FL"
                if (resolvedCounty.isNullOrBlank()) resolvedCounty = match.groupValues[1]
            }
        }
        return resolvedState to resolvedCounty
    }

    fun lastUpdated(cave: CaveRecord): String? = cave["lastUpdated"] as? String
    fun updatedBy(cave: CaveRecord): String? = cave["updatedBy"] as? String

    /**
     * Merges [edits] into [cave] and mirrors every aliased pair so any other
     * client (web included) reading only one spelling still sees the change,
     * matching `saveUpdatedCaveData()` in index.html. Only mirrors a pair
     * when its canonical key is present in [edits].
     */
    fun withEdits(cave: CaveRecord, edits: Map<String, Any?>): CaveRecord {
        val merged = cave.toMutableMap()
        merged.putAll(edits)
        (edits["latitude"] ?: edits["lat"])?.let { merged["latitude"] = it; merged["lat"] = it }
        (edits["longitude"] ?: edits["lng"])?.let { merged["longitude"] = it; merged["lng"] = it }
        edits["length"]?.let { merged["caveLength"] = it }
        edits["vertical"]?.let { merged["verticalExtent"] = it }
        edits["waterDepth"]?.let { merged["water"] = it; merged["maxWaterDepth"] = it }
        edits["pitch"]?.let { merged["deepestPitch"] = it }
        return merged
    }

    fun emptyNew(state: String, county: String): CaveRecord = mapOf(
        "state" to state,
        "county" to county,
        "name" to "",
        "latitude" to null,
        "longitude" to null,
        "lat" to null,
        "lng" to null,
        "equipment" to emptyList<String>(),
        "exploration" to emptyList<String>(),
    )
}

/** action="updateSingle" or action="createNew" body for POST /api/save-cave-database. */
data class SaveCaveActionRequest(val action: String, val cave: CaveRecord)

data class SaveCaveResponse(val message: String, val caveId: String? = null)

data class UpdateCaveLocationRequest(val id: String, val latitude: Double, val longitude: Double)

/** Checkbox code -> display label, since server.js only stores the bare letter code. */
val EQUIPMENT_LABELS = linkedMapOf(
    "B" to "Boat or flotation",
    "D" to "Diving gear",
    "H" to "Handline",
    "K" to "Kneepads",
    "L" to "Ladder",
    "N" to "Normal speleo gear",
    "R" to "Rope",
    "S" to "Shovel/dig/blasting",
    "W" to "Wetsuit",
    "X" to "Other special equipment",
)

val EXPLORATION_LABELS = linkedMapOf(
    "B" to "Blind Pit",
    "C" to "Climb or Bolt",
    "D" to "Possible Dig",
    "E" to "Explosive Application",
    "N" to "No Chance",
    "S" to "Extend Penetration",
    "T" to "Too Tight",
    "W" to "Water Too High",
)

val LOCATION_ACCURACY_LABELS = linkedMapOf(
    "D" to "5 ft (lidar)",
    "E" to "10 ft",
    "F" to "20 ft",
    "G" to "30 ft",
    "H" to "55 ft",
    "I" to "100 ft",
    "J" to "200 ft",
    "K" to "300 ft",
    "L" to "550 ft",
    "M" to "1000 ft",
    "N" to "Mapped",
    "U" to "Unknown",
)

// --- Statistics-only label maps (distinct short forms from the website's
// Statistics tab - deliberately different wording than EQUIPMENT_LABELS
// above, which is the longer edit-form phrasing for the same codes) -------

val EQUIPMENT_SHORT_LABELS = linkedMapOf(
    "B" to "Boat/Flotation",
    "D" to "Diving Gear",
    "H" to "Handline",
    "K" to "Kneepads",
    "L" to "Ladder",
    "N" to "Normal Gear",
    "R" to "Rope",
    "S" to "Shovel/Dig",
    "W" to "Wetsuit",
    "X" to "Special Equipment",
)

val GEOLOGY_LABELS = linkedMapOf(
    "HA" to "Hawthorne",
    "CH" to "Chattahoochee",
    "SU" to "Suwannee",
    "MA" to "Marianna",
    "CR" to "Crystal River",
    "OC" to "Ocala Limestone",
    "" to "Unknown",
)

val MAP_TYPE_LABELS = linkedMapOf(
    "K" to "Knotted Line & Compass",
    "M" to "Mixed Methods",
    "P" to "Pace & Compass",
    "S" to "Sketch",
    "T" to "Tape/Compass/Inclinometer",
    "U" to "Unmapped",
    "" to "Unknown",
)
