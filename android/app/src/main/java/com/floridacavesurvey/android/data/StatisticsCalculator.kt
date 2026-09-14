package com.floridacavesurvey.android.data

import com.floridacavesurvey.android.data.model.*
import java.time.Instant

/**
 * Ports the website's Statistics tab (updateStatistics() and its many
 * createXCard()/updateX() helpers in httpdocs/index.html) field-for-field,
 * including its quirks (unsorted county/geology/map-status charts, "Other"
 * as a remainder rather than a direct filter, first-wins tie-breaking on
 * "longest/deepest" record holders, the YY<50 century heuristic for
 * discovery years). Nothing here calls the network - see StatisticsRepository
 * for the fetches these functions consume.
 */
object StatisticsCalculator {

    fun databaseSummary(caves: List<CaveRecord>): DatabaseSummary {
        val land = caves.count { CaveFields.type(it)?.contains("Land") == true }
        val underwater = caves.count { CaveFields.type(it)?.contains("Underwater") == true }
        val countyPairs = caves.map { cave ->
            val (state, county) = CaveFields.resolveStateAndCounty(cave)
            "${state.orEmpty()}|${county.orEmpty()}"
        }.toSet()
        return DatabaseSummary(caves.size, land, underwater, countyPairs.size)
    }

    fun nationwideOverview(stateCounts: StateCountsResponse): NationwideOverview =
        NationwideOverview(stateCounts.total, stateCounts.states.count { it.count > 0 })

    fun accessStatus(caves: List<CaveRecord>): AccessStatus {
        val commercial = caves.count { CaveFields.entryStatus(it) == "C" }
        val government = caves.count { CaveFields.entryStatus(it) in setOf("G", "K") }
        val private = caves.count { CaveFields.entryStatus(it) in setOf("P", "F", "R") }
        val other = caves.size - commercial - government - private
        return AccessStatus(commercial, government, private, other)
    }

    fun caveTypesChart(summary: DatabaseSummary): List<ChartDatum> = listOf(
        ChartDatum("Land Caves", summary.landCaves),
        ChartDatum("Underwater Caves", summary.underwaterCaves),
    )

    fun entryStatusChart(access: AccessStatus): List<ChartDatum> = listOf(
        ChartDatum("Commercial", access.commercial),
        ChartDatum("Government", access.governmentOwned),
        ChartDatum("Private", access.privateProperty),
        ChartDatum("Other", access.other),
    )

    /** Already sorted count-desc/name-asc and zero-filtered server-side - passed through as-is. */
    fun byStateChart(stateCounts: StateCountsResponse): List<ChartDatum> =
        stateCounts.states.filter { it.count > 0 }.map { ChartDatum(it.name, it.count) }

    /** Insertion order over `caves`, deliberately NOT sorted/capped - matches the website. */
    fun byCountyChart(caves: List<CaveRecord>, states: List<StateInfo>): List<ChartDatum> {
        val countyNameLookup = states.flatMap { state ->
            state.counties.orEmpty().map { county -> (state.code to county.code) to county.name }
        }.toMap()
        val counts = LinkedHashMap<String, Int>()
        for (cave in caves) {
            val (state, county) = CaveFields.resolveStateAndCounty(cave)
            if (county.isNullOrBlank()) continue
            val displayName = countyNameLookup[(state.orEmpty()) to county] ?: county
            val label = if (!state.isNullOrBlank()) "$displayName ($state)" else displayName
            counts[label] = (counts[label] ?: 0) + 1
        }
        return counts.map { (label, count) -> ChartDatum(label, count) }
    }

    /** Multi-select tally (one cave can add to several bars), zero-count codes dropped, sorted desc. */
    fun equipmentChart(caves: List<CaveRecord>): List<ChartDatum> {
        val counts = LinkedHashMap<String, Int>()
        EQUIPMENT_SHORT_LABELS.keys.forEach { counts[it] = 0 }
        for (cave in caves) {
            for (code in CaveFields.equipment(cave)) {
                if (counts.containsKey(code)) counts[code] = counts.getValue(code) + 1
            }
        }
        return counts.filter { it.value > 0 }
            .map { (code, count) -> ChartDatum(EQUIPMENT_SHORT_LABELS[code] ?: code, count) }
            .sortedByDescending { it.count }
    }

    fun dimensionStats(caves: List<CaveRecord>): DimensionStats {
        val withLength = caves.mapNotNull { cave -> CaveFields.length(cave)?.toDoubleOrNull()?.let { cave to it } }
        val avgLength = if (withLength.isEmpty()) 0 else Math.round(withLength.sumOf { it.second } / withLength.size).toInt()
        val longest = withLength.fold<Pair<CaveRecord, Double>, Pair<CaveRecord, Double>?>(null) { best, cur ->
            if (best == null || cur.second > best.second) cur else best
        }

        val withVertical = caves.mapNotNull { cave -> CaveFields.vertical(cave)?.toDoubleOrNull()?.let { cave to it } }
        val avgVertical = if (withVertical.isEmpty()) 0 else Math.round(withVertical.sumOf { it.second } / withVertical.size).toInt()
        val deepest = withVertical.fold<Pair<CaveRecord, Double>, Pair<CaveRecord, Double>?>(null) { best, cur ->
            if (best == null || cur.second > best.second) cur else best
        }

        val withWater = caves.mapNotNull { cave -> CaveFields.waterDepth(cave)?.toDoubleOrNull()?.let { cave to it } }
        val deepestWater = withWater.fold<Pair<CaveRecord, Double>, Pair<CaveRecord, Double>?>(null) { best, cur ->
            if (best == null || cur.second > best.second) cur else best
        }

        return DimensionStats(
            avgLengthFt = avgLength,
            longestCaveName = longest?.let { CaveFields.name(it.first) } ?: "None",
            longestCaveLengthFt = longest?.second ?: 0.0,
            avgVerticalFt = avgVertical,
            deepestCaveName = deepest?.let { CaveFields.name(it.first) } ?: "None",
            deepestCaveVerticalFt = deepest?.second ?: 0.0,
            maxWaterDepthFt = deepestWater?.second ?: 0.0,
            maxWaterDepthCaveName = deepestWater?.let { CaveFields.name(it.first) } ?: "None",
        )
    }

    /** Insertion order, unrecognized non-empty codes shown under their own raw code (not folded into Unknown). */
    fun geologyChart(caves: List<CaveRecord>): List<ChartDatum> {
        val counts = LinkedHashMap<String, Int>()
        for (cave in caves) {
            val code = CaveFields.geology(cave).orEmpty()
            val label = GEOLOGY_LABELS[code] ?: code.ifBlank { "Unknown" }
            counts[label] = (counts[label] ?: 0) + 1
        }
        return counts.map { (label, count) -> ChartDatum(label, count) }
    }

    fun hazardStats(caves: List<CaveRecord>): HazardStats {
        var badAir = 0
        var unstable = 0
        var casualties = 0
        var anyHazard = 0
        for (cave in caves) {
            val hazards = CaveFields.hazards(cave)
            val isBadAir: Boolean
            val isUnstable: Boolean
            val isCasualties: Boolean
            if (hazards != null) {
                isBadAir = hazards["badAir"] == true
                isUnstable = hazards["unstable"] == true
                isCasualties = hazards["casualties"] == true
            } else {
                val text = CaveFields.hazardousConditions(cave)?.lowercase().orEmpty()
                isBadAir = "air" in text || "oxygen" in text
                isUnstable = "unstable" in text || "collapse" in text
                isCasualties = "casualt" in text || "death" in text
            }
            if (isBadAir) badAir++
            if (isUnstable) unstable++
            if (isCasualties) casualties++
            if (isBadAir || isUnstable || isCasualties) anyHazard++
        }
        return HazardStats(badAir, unstable, casualties, anyHazard)
    }

    /** Fixed 7 buckets, 50ft wide except the open-ended last one; no lower bound (negatives land in bucket 1). */
    fun elevationChart(caves: List<CaveRecord>): List<ChartDatum> {
        val buckets = linkedMapOf(
            "0-50 ft" to 0, "51-100 ft" to 0, "101-150 ft" to 0, "151-200 ft" to 0,
            "201-250 ft" to 0, "251-300 ft" to 0, "301+ ft" to 0,
        )
        for (cave in caves) {
            val elevation = CaveFields.elevation(cave)?.toDoubleOrNull() ?: continue
            val key = when {
                elevation <= 50 -> "0-50 ft"
                elevation <= 100 -> "51-100 ft"
                elevation <= 150 -> "101-150 ft"
                elevation <= 200 -> "151-200 ft"
                elevation <= 250 -> "201-250 ft"
                elevation <= 300 -> "251-300 ft"
                else -> "301+ ft"
            }
            buckets[key] = buckets.getValue(key) + 1
        }
        return buckets.map { (label, count) -> ChartDatum(label, count) }
    }

    /** cave.date is "YYMM"; YY<50 -> 20YY else 19YY. Years sorted lexicographically (= numerically, same width). */
    fun discoveryTimeline(caves: List<CaveRecord>): TimelineSeries {
        val perYear = sortedMapOf<String, Int>()
        for (cave in caves) {
            val date = CaveFields.dateCode(cave)
            if (date.isNullOrEmpty() || date.length < 2) continue
            val yy = date.substring(0, 2).toIntOrNull() ?: continue
            val year = (if (yy < 50) 2000 + yy else 1900 + yy).toString()
            perYear[year] = (perYear[year] ?: 0) + 1
        }
        val years = perYear.keys.toList()
        val counts = years.map { perYear.getValue(it) }
        var running = 0
        val cumulative = counts.map { running += it; running }
        return TimelineSeries(years, counts, cumulative)
    }

    fun documentationCoverage(caves: List<CaveRecord>, documentedCaveIds: List<String>): DocumentationCoverage {
        val documentedSet = documentedCaveIds.toSet()
        val total = caves.size
        val documented = caves.count { CaveFields.id(it) in documentedSet }
        val undocumented = total - documented
        val pct = if (total > 0) Math.round(documented * 100.0 / total).toInt() else 0
        return DocumentationCoverage(documented, undocumented, pct)
    }

    /** Sorted desc by total, capped to 8; ties keep first-encountered order (narratives processed before submissions). */
    fun topContributors(narratives: List<NarrativeLogEntry>, submissions: List<Submission>): List<ContributorRow> {
        data class Counts(var narratives: Int = 0, var submissions: Int = 0)
        val byName = LinkedHashMap<String, Counts>()
        for (entry in narratives) {
            if (entry.isDeleted) continue
            val name = entry.user
            if (name.isBlank()) continue
            byName.getOrPut(name) { Counts() }.narratives++
        }
        for (submission in submissions) {
            val name = submission.submittedBy
            if (name.isNullOrBlank()) continue
            byName.getOrPut(name) { Counts() }.submissions++
        }
        return byName.map { (name, c) -> ContributorRow(name, c.narratives, c.submissions) }
            .sortedByDescending { it.total }
            .take(8)
    }

    /** Insertion order, unrecognized non-empty codes shown under their own raw code. */
    fun mapStatusChart(caves: List<CaveRecord>): List<ChartDatum> {
        val counts = LinkedHashMap<String, Int>()
        for (cave in caves) {
            val code = CaveFields.mapType(cave).orEmpty()
            val label = MAP_TYPE_LABELS[code] ?: code.ifBlank { "Unknown" }
            counts[label] = (counts[label] ?: 0) + 1
        }
        return counts.map { (label, count) -> ChartDatum(label, count) }
    }

    /** Exactly mapType == "U" - distinct from the chart's "Unknown" bucket (missing mapType). */
    fun unmappedCaveCount(caves: List<CaveRecord>): Int = caves.count { CaveFields.mapType(it) == "U" }

    fun submissionFunnel(submissions: List<Submission>): SubmissionFunnel {
        val pending = submissions.count { it.status != "approved" && it.status != "rejected" }
        val approved = submissions.count { it.status == "approved" }
        val rejected = submissions.count { it.status == "rejected" }
        val turnaroundDays = submissions
            .filter { it.status == "approved" && it.submittedAt != null && it.approvedDate != null }
            .mapNotNull { submission ->
                val submitted = parseInstant(submission.submittedAt)
                val approvedAt = parseInstant(submission.approvedDate)
                if (submitted == null || approvedAt == null) return@mapNotNull null
                val days = (approvedAt.toEpochMilli() - submitted.toEpochMilli()) / 86_400_000.0
                days.takeIf { it >= 0 }
            }
        val avg = if (turnaroundDays.isEmpty()) null else turnaroundDays.average()
        return SubmissionFunnel(pending, approved, rejected, avg)
    }

    /** Sorted newest-first, capped to 10 - see StatisticsSpec's note that this card never renders
     * on the live website today (a missing element id), but the underlying logic here is correct. */
    fun recentActivity(submissions: List<Submission>): List<ActivityRow> {
        val rows = mutableListOf<ActivityRow>()
        for (submission in submissions) {
            val caveLabel = submission.caveName ?: submission.caveId
            val submittedAt = parseInstant(submission.submittedAt)
            if (submittedAt != null) {
                rows += ActivityRow(
                    whenMillis = submittedAt.toEpochMilli(),
                    action = if (submission.type == "new_cave") "New Cave Proposed" else "Cave Edit Proposed",
                    user = submission.submittedBy ?: "Unknown",
                    details = "Proposed \"$caveLabel\"",
                )
            }
            if (submission.status == "approved") {
                val approvedAt = parseInstant(submission.approvedDate)
                if (approvedAt != null) {
                    val idSuffix = submission.assignedCaveId?.let { " (ID $it)" }.orEmpty()
                    rows += ActivityRow(
                        whenMillis = approvedAt.toEpochMilli(),
                        action = "Submission Approved",
                        user = submission.approvedBy ?: "Unknown",
                        details = "Approved \"$caveLabel\"$idSuffix",
                    )
                }
            } else if (submission.status == "rejected") {
                val rejectedAt = parseInstant(submission.rejectedDate)
                if (rejectedAt != null) {
                    rows += ActivityRow(
                        whenMillis = rejectedAt.toEpochMilli(),
                        action = "Submission Rejected",
                        user = submission.rejectedBy ?: "Unknown",
                        details = "Rejected \"$caveLabel\"",
                    )
                }
            }
        }
        return rows.sortedByDescending { it.whenMillis }.take(10)
    }

    private fun parseInstant(value: String?): Instant? {
        if (value.isNullOrBlank()) return null
        return try {
            Instant.parse(value)
        } catch (e: Exception) {
            null
        }
    }
}
