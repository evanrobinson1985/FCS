package com.floridacavesurvey.android.data.model

/** One labeled slice/bar shared by every chart card - order is significant and already
 * matches each card's spec (sorted, insertion-order, or fixed, as documented per card). */
data class ChartDatum(val label: String, val count: Int)

data class DatabaseSummary(
    val totalCaves: Int,
    val landCaves: Int,
    val underwaterCaves: Int,
    val countiesRepresented: Int,
)

data class NationwideOverview(
    val totalCavesAllStates: Int,
    val statesWithData: Int,
)

data class AccessStatus(
    val commercial: Int,
    val governmentOwned: Int,
    val privateProperty: Int,
    val other: Int,
) {
    val total get() = commercial + governmentOwned + privateProperty + other
}

data class DimensionStats(
    val avgLengthFt: Int,
    val longestCaveName: String,
    val longestCaveLengthFt: Double,
    val avgVerticalFt: Int,
    val deepestCaveName: String,
    val deepestCaveVerticalFt: Double,
    val maxWaterDepthFt: Double,
    val maxWaterDepthCaveName: String,
)

data class HazardStats(
    val badAir: Int,
    val unstable: Int,
    val casualties: Int,
    val totalWithAnyHazard: Int,
)

data class DocumentationCoverage(
    val documented: Int,
    val undocumented: Int,
    val coveragePercent: Int,
)

data class ContributorRow(
    val name: String,
    val narratives: Int,
    val submissions: Int,
) {
    val total get() = narratives + submissions
}

data class SubmissionFunnel(
    val pending: Int,
    val approved: Int,
    val rejected: Int,
    val avgTurnaroundDays: Double?,
)

data class ActivityRow(
    val whenMillis: Long,
    val action: String,
    val user: String,
    val details: String,
)

data class TimelineSeries(
    val years: List<String>,
    val perYear: List<Int>,
    val cumulative: List<Int>,
)

data class UnmappedCaveCount(val unmapped: Int)

/** Everything the Statistics screen needs, fetched and computed once per visit - mirrors
 * updateStatistics() on the website, which recomputes fresh every time the tab is opened. */
data class StatisticsSnapshot(
    val summary: DatabaseSummary,
    val nationwide: NationwideOverview,
    val accessStatus: AccessStatus,
    val caveTypes: List<ChartDatum>,
    val byState: List<ChartDatum>,
    val byCounty: List<ChartDatum>,
    val byEntryStatus: List<ChartDatum>,
    val equipment: List<ChartDatum>,
    val dimensions: DimensionStats,
    val geology: List<ChartDatum>,
    val hazards: HazardStats,
    val elevation: List<ChartDatum>,
    val timeline: TimelineSeries,
    val documentation: DocumentationCoverage,
    val topContributors: List<ContributorRow>,
    val mapStatus: List<ChartDatum>,
    val unmappedCaves: Int,
    val submissionFunnel: SubmissionFunnel,
    val recentActivity: List<ActivityRow>,
)
