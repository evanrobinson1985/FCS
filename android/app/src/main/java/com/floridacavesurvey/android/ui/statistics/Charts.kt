package com.floridacavesurvey.android.ui.statistics

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.floridacavesurvey.android.data.model.ChartDatum
import com.floridacavesurvey.android.data.model.TimelineSeries

/** Repeating palette for chart slices/bars - cycles once a card has more categories than colors,
 * same approach the website's Chart.js configs use. */
val ChartPalette = listOf(
    Color(0xFF2E4A4F), Color(0xFFC97B2E), Color(0xFF4C7A80), Color(0xFF7B3294),
    Color(0xFFD53E4F), Color(0xFFADCBE3), Color(0xFF1A9641), Color(0xFF2C7FB8),
)

@Composable
fun PieOrDonutWithLegend(
    data: List<ChartDatum>,
    modifier: Modifier = Modifier,
    holeFraction: Float = 0f,
    colors: List<Color> = ChartPalette,
) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        DonutCanvas(data, colors, holeFraction, modifier = Modifier.size(104.dp))
        Spacer(Modifier.width(14.dp))
        ChartLegend(data, colors, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun DonutCanvas(data: List<ChartDatum>, colors: List<Color>, holeFraction: Float, modifier: Modifier) {
    val total = data.sumOf { it.count }.coerceAtLeast(1)
    val isPie = holeFraction <= 0f
    Canvas(modifier) {
        var startAngle = -90f
        val diameter = size.minDimension
        // Pie: one full-size filled circle. Donut: a ring stroked along a circle inset by half
        // its own stroke width, so the ring's outer edge still touches the canvas bounds.
        val strokeWidth = if (isPie) 0f else diameter * (1f - holeFraction) / 2f
        val inset = strokeWidth / 2f
        data.forEachIndexed { i, datum ->
            val sweep = 360f * datum.count / total
            if (sweep <= 0f) return@forEachIndexed
            drawArc(
                color = colors[i % colors.size],
                startAngle = startAngle,
                sweepAngle = sweep,
                useCenter = isPie,
                topLeft = Offset(inset, inset),
                size = androidx.compose.ui.geometry.Size(diameter - strokeWidth, diameter - strokeWidth),
                style = if (isPie) androidx.compose.ui.graphics.drawscope.Fill else Stroke(width = strokeWidth),
            )
            startAngle += sweep
        }
    }
}

@Composable
private fun ChartLegend(data: List<ChartDatum>, colors: List<Color>, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        data.forEachIndexed { i, datum ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(colors[i % colors.size]))
                Spacer(Modifier.width(6.dp))
                Text(datum.label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1)
                Text(datum.count.toString(), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Vertical bars, horizontally scrollable so an unbounded category count (all 67 FL counties, say)
 * never gets crushed - matches the website's uncapped county/state charts. */
@Composable
fun VerticalBarChart(
    data: List<ChartDatum>,
    color: Color,
    modifier: Modifier = Modifier,
    barHeight: androidx.compose.ui.unit.Dp = 120.dp,
) {
    val max = (data.maxOfOrNull { it.count } ?: 0).coerceAtLeast(1)
    Row(
        modifier = modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        data.forEach { datum ->
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(52.dp)) {
                Text(datum.count.toString(), style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.height(2.dp))
                Box(Modifier.height(barHeight), contentAlignment = Alignment.BottomCenter) {
                    Box(
                        Modifier
                            .width(26.dp)
                            .fillMaxHeight(datum.count.toFloat() / max)
                            .background(color, RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp)),
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    datum.label,
                    style = MaterialTheme.typography.labelSmall,
                    fontSize = 9.sp,
                    maxLines = 2,
                    textAlign = TextAlign.Center,
                    lineHeight = 11.sp,
                )
            }
        }
    }
}

/** Horizontal bars stacked vertically - used for Equipment Requirements, already sorted desc. */
@Composable
fun HorizontalBarList(data: List<ChartDatum>, color: Color, modifier: Modifier = Modifier) {
    val max = (data.maxOfOrNull { it.count } ?: 0).coerceAtLeast(1)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        data.forEach { datum ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    datum.label,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.width(92.dp),
                    maxLines = 1,
                )
                Box(Modifier.weight(1f).height(14.dp)) {
                    Box(
                        Modifier
                            .fillMaxHeight()
                            .fillMaxWidth(datum.count.toFloat() / max)
                            .background(color, RoundedCornerShape(3.dp)),
                    )
                }
                Text(
                    datum.count.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }
}

/** "Caves Discovered per Year" (left axis) + "Cumulative Total" (right axis) as two independently
 * scaled polylines sharing an x axis of years - mirrors the website's dual-axis Chart.js line chart. */
@Composable
fun DualAxisLineChart(series: TimelineSeries, colorPerYear: Color, colorCumulative: Color, modifier: Modifier = Modifier) {
    if (series.years.size < 2) {
        Text(
            "Not enough dated caves to chart a timeline yet.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = modifier,
        )
        return
    }
    Column(modifier) {
        Row {
            LegendDot(colorPerYear, "Per year")
            Spacer(Modifier.width(14.dp))
            LegendDot(colorCumulative, "Cumulative")
        }
        Spacer(Modifier.height(6.dp))
        Canvas(Modifier.fillMaxWidth().height(130.dp)) {
            val n = series.years.size
            val stepX = size.width / (n - 1)
            val max1 = (series.perYear.maxOrNull() ?: 0).coerceAtLeast(1)
            val max2 = (series.cumulative.maxOrNull() ?: 0).coerceAtLeast(1)

            fun pathFor(values: List<Int>, max: Int): Path {
                val path = Path()
                values.forEachIndexed { i, v ->
                    val x = i * stepX
                    val y = size.height - (v.toFloat() / max) * size.height
                    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                return path
            }

            drawPath(pathFor(series.perYear, max1), colorPerYear, style = Stroke(width = 4f))
            drawPath(pathFor(series.cumulative, max2), colorCumulative, style = Stroke(width = 4f))
        }
        Spacer(Modifier.height(4.dp))
        val shownYears = if (series.years.size <= 6) {
            series.years
        } else {
            val step = (series.years.size - 1) / 5
            series.years.filterIndexed { i, _ -> i % step.coerceAtLeast(1) == 0 }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            shownYears.forEach { Text(it, style = MaterialTheme.typography.labelSmall, fontSize = 9.sp) }
        }
    }
}

@Composable
private fun LegendDot(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(5.dp))
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}
