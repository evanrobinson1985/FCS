package com.floridacavesurvey.android.ui.statistics

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.*
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun StatisticsScreen() {
    val container = localAppContainer()
    val viewModel: StatisticsViewModel = viewModel(
        factory = viewModelFactory { initializer { StatisticsViewModel(container.statisticsRepository) } },
    )

    UiStateContent(state = viewModel.state, onRetry = viewModel::load) { snapshot ->
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Column {
                    Text("Florida Cave Survey Statistics", style = MaterialTheme.typography.titleLarge)
                    Text(
                        "Overview of the cave database, activity, and community contributions.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            item {
                StatCard("Database Summary") {
                    StatRow("Total Caves", snapshot.summary.totalCaves.toString())
                    StatRow("Land Caves", snapshot.summary.landCaves.toString())
                    StatRow("Underwater Caves", snapshot.summary.underwaterCaves.toString())
                    StatRow("Counties Represented", snapshot.summary.countiesRepresented.toString())
                }
            }

            item {
                StatCard("Nationwide Overview") {
                    StatRow("Total Caves (All States)", snapshot.nationwide.totalCavesAllStates.toString())
                    StatRow("States With Data", snapshot.nationwide.statesWithData.toString())
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Always shows every state's total, regardless of which states your account can browse in detail.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            item {
                StatCard("Access Status") {
                    StatRow("Commercial", snapshot.accessStatus.commercial.toString())
                    StatRow("Government Owned", snapshot.accessStatus.governmentOwned.toString())
                    StatRow("Private Property", snapshot.accessStatus.privateProperty.toString())
                    StatRow("Other", snapshot.accessStatus.other.toString())
                }
            }

            item {
                StatCard("Cave Types Distribution") {
                    PieOrDonutWithLegend(snapshot.caveTypes, colors = listOf(Color(0xFF1A9641), Color(0xFF2C7FB8)))
                }
            }

            item {
                StatCard("Caves by State") {
                    if (snapshot.byState.isEmpty()) EmptyNote() else VerticalBarChart(snapshot.byState, Color(0xFF4B86B4))
                }
            }

            item {
                StatCard("Caves by County") {
                    if (snapshot.byCounty.isEmpty()) EmptyNote() else VerticalBarChart(snapshot.byCounty, Color(0xFF4B86B4))
                }
            }

            item {
                StatCard("Caves by Entry Status") {
                    PieOrDonutWithLegend(
                        snapshot.byEntryStatus,
                        holeFraction = 0.55f,
                        colors = listOf(Color(0xFFF46D43), Color(0xFF7B3294), Color(0xFFD53E4F), Color(0xFFADCBE3)),
                    )
                }
            }

            item {
                StatCard("Equipment Requirements") {
                    if (snapshot.equipment.isEmpty()) EmptyNote() else HorizontalBarList(snapshot.equipment, Color(0xFF2A4D69))
                }
            }

            item {
                StatCard("Dimension Statistics") {
                    val d = snapshot.dimensions
                    StatRow("Average Cave Length", "${d.avgLengthFt} ft")
                    StatRow("Longest Cave", "${d.longestCaveName} (${d.longestCaveLengthFt.stripped()} ft)")
                    StatRow("Average Vertical Extent", "${d.avgVerticalFt} ft")
                    StatRow("Deepest Cave", "${d.deepestCaveName} (${d.deepestCaveVerticalFt.stripped()} ft)")
                    StatRow("Maximum Water Depth", "${d.maxWaterDepthFt.stripped()} ft (${d.maxWaterDepthCaveName})")
                }
            }

            item {
                StatCard("Geological Distribution") {
                    if (snapshot.geology.isEmpty()) EmptyNote() else PieOrDonutWithLegend(snapshot.geology, holeFraction = 0.55f)
                }
            }

            item {
                StatCard("Hazard Statistics") {
                    StatRow("Caves with Bad Air", snapshot.hazards.badAir.toString())
                    StatRow("Unstable/Collapse Risk", snapshot.hazards.unstable.toString())
                    StatRow("Caves with Known Casualties", snapshot.hazards.casualties.toString())
                    StatRow("Total Caves with Hazards", snapshot.hazards.totalWithAnyHazard.toString())
                }
            }

            item {
                StatCard("Elevation Distribution") {
                    VerticalBarChart(snapshot.elevation, Color(0xFF4B86B4), barHeight = 100.dp)
                }
            }

            item {
                StatCard("Cave Discovery Timeline") {
                    DualAxisLineChart(snapshot.timeline, Color(0xFF4B86B4), Color(0xFF2A4D69))
                }
            }

            item {
                StatCard("Documentation Coverage") {
                    StatRow("Caves with a Narrative", snapshot.documentation.documented.toString())
                    StatRow("Caves without a Narrative", snapshot.documentation.undocumented.toString())
                    StatRow("Coverage", "${snapshot.documentation.coveragePercent}%")
                }
            }

            item {
                StatCard("Top Contributors") {
                    if (snapshot.topContributors.isEmpty()) {
                        EmptyNote("No contributor activity yet.")
                    } else {
                        ContributorsTable(snapshot.topContributors)
                    }
                }
            }

            item {
                StatCard("Map / Survey Status") {
                    PieOrDonutWithLegend(
                        snapshot.mapStatus,
                        holeFraction = 0.55f,
                        colors = listOf(Color(0xFF2A4D69), Color(0xFF4B86B4), Color(0xFFADCBE3), Color(0xFFE4572E), Color(0xFFF3A712), Color(0xFFA8A8A8), Color(0xFF7B3294)),
                    )
                    Spacer(Modifier.height(6.dp))
                    StatRow("Unmapped Caves", snapshot.unmappedCaves.toString())
                }
            }

            item {
                StatCard("Submission Review Funnel") {
                    val f = snapshot.submissionFunnel
                    StatRow("Pending Review", f.pending.toString())
                    StatRow("Approved", f.approved.toString())
                    StatRow("Rejected", f.rejected.toString())
                    StatRow("Avg. Time to Approval", f.avgTurnaroundDays?.let { "%.1f days".format(it) } ?: "N/A")
                }
            }

            item {
                StatCard("Recent Activity") {
                    if (snapshot.recentActivity.isEmpty()) {
                        EmptyNote("No recent activity found.")
                    } else {
                        ActivityTable(snapshot.recentActivity)
                    }
                }
            }

            item { Spacer(Modifier.height(8.dp)) }
        }
    }
}

private fun Double.stripped(): String = if (this == this.toLong().toDouble()) this.toLong().toString() else this.toString()

@Composable
private fun StatCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun StatRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun EmptyNote(text: String = "No data yet.") {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ContributorsTable(rows: List<ContributorRow>) {
    Column {
        Row(Modifier.fillMaxWidth()) {
            Text("Member", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1.4f))
            Text("Narr.", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(0.7f))
            Text("Subm.", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(0.7f))
            Text("Total", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(0.7f))
        }
        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                Text(row.name, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1.4f), maxLines = 1)
                Text(row.narratives.toString(), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.7f))
                Text(row.submissions.toString(), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.7f))
                Text(row.total.toString(), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(0.7f), fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun ActivityTable(rows: List<ActivityRow>) {
    val formatter = SimpleDateFormat("MMM d, yyyy h:mm a", Locale.US)
    Column {
        rows.forEach { row ->
            Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(row.action, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    Text(formatter.format(Date(row.whenMillis)), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text("${row.user} · ${row.details}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider()
        }
    }
}
