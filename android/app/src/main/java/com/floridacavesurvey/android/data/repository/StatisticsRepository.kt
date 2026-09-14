package com.floridacavesurvey.android.data.repository

import com.floridacavesurvey.android.data.StatisticsCalculator
import com.floridacavesurvey.android.data.model.StatisticsSnapshot
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * Fetches everything the Statistics tab needs and computes the whole snapshot fresh, same as
 * the website re-running updateStatistics() every time that tab is opened - nothing here is
 * cached across calls.
 */
class StatisticsRepository(
    private val caveRepository: CaveRepository,
    private val narrativeRepository: NarrativeRepository,
    private val submissionRepository: SubmissionRepository,
) {
    suspend fun loadSnapshot(): StatisticsSnapshot = coroutineScope {
        val cavesDeferred = async { caveRepository.getCaveDatabase() }
        val stateCountsDeferred = async { caveRepository.getStateCounts() }
        val statesDeferred = async { caveRepository.getStates() }
        val documentedDeferred = async { narrativeRepository.getCavesWithNarratives() }
        val narrativesLogDeferred = async { narrativeRepository.getAllNarrativesLog() }
        val submissionsDeferred = async { submissionRepository.getPending() }

        val caves = cavesDeferred.await()
        val stateCounts = stateCountsDeferred.await()
        val states = statesDeferred.await()
        val documented = documentedDeferred.await()
        val narrativesLog = narrativesLogDeferred.await()
        val submissions = submissionsDeferred.await()

        val summary = StatisticsCalculator.databaseSummary(caves)
        val access = StatisticsCalculator.accessStatus(caves)

        StatisticsSnapshot(
            summary = summary,
            nationwide = StatisticsCalculator.nationwideOverview(stateCounts),
            accessStatus = access,
            caveTypes = StatisticsCalculator.caveTypesChart(summary),
            byState = StatisticsCalculator.byStateChart(stateCounts),
            byCounty = StatisticsCalculator.byCountyChart(caves, states),
            byEntryStatus = StatisticsCalculator.entryStatusChart(access),
            equipment = StatisticsCalculator.equipmentChart(caves),
            dimensions = StatisticsCalculator.dimensionStats(caves),
            geology = StatisticsCalculator.geologyChart(caves),
            hazards = StatisticsCalculator.hazardStats(caves),
            elevation = StatisticsCalculator.elevationChart(caves),
            timeline = StatisticsCalculator.discoveryTimeline(caves),
            documentation = StatisticsCalculator.documentationCoverage(caves, documented),
            topContributors = StatisticsCalculator.topContributors(narrativesLog, submissions),
            mapStatus = StatisticsCalculator.mapStatusChart(caves),
            unmappedCaves = StatisticsCalculator.unmappedCaveCount(caves),
            submissionFunnel = StatisticsCalculator.submissionFunnel(submissions),
            recentActivity = StatisticsCalculator.recentActivity(submissions),
        )
    }
}
