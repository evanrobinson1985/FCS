package com.floridacavesurvey.android.ui.map

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.CaveFields
import com.floridacavesurvey.android.data.network.UiState
import com.floridacavesurvey.android.ui.localAppContainer
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker

private val FLORIDA_CENTER = GeoPoint(28.5, -82.0)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MapScreen(onOpenCave: (String) -> Unit) {
    val container = localAppContainer()
    val viewModel: MapViewModel = viewModel(
        factory = viewModelFactory {
            initializer { MapViewModel(container.mapRepository, container.caveRepository, container.tokenStore) }
        },
    )
    var showLayerPicker by remember { mutableStateOf(false) }
    val jwt = viewModel.tokenStore.currentToken

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                MapView(context).apply {
                    setTileSource(TileSourceFactory.MAPNIK)
                    setMultiTouchControls(true)
                    controller.setZoom(7.0)
                    controller.setCenter(FLORIDA_CENTER)
                }
            },
            update = { mapView ->
                // Base layer: hillshade overlay if one's selected, else plain OSM.
                val hillshade = viewModel.selectedHillshade
                val bounds = viewModel.selectedBounds
                if (hillshade != null && jwt != null) {
                    mapView.setTileSource(HillshadeTileSource(hillshade.name, jwt, bounds?.minZoom ?: 0, bounds?.maxZoom ?: 18))
                    bounds?.let {
                        val sw = it.southWest
                        val ne = it.northEast
                        if (sw != null && ne != null) {
                            mapView.zoomToBoundingBox(BoundingBox(ne.first, ne.second, sw.first, sw.second), true, 32)
                        }
                    }
                } else {
                    mapView.setTileSource(TileSourceFactory.MAPNIK)
                }

                // Cave markers.
                mapView.overlays.removeAll { it is Marker }
                val caveList = (viewModel.caves as? UiState.Success)?.data.orEmpty()
                caveList.forEach { cave ->
                    val lat = CaveFields.latitude(cave)
                    val lng = CaveFields.longitude(cave)
                    if (lat != null && lng != null) {
                        val marker = Marker(mapView)
                        marker.position = GeoPoint(lat, lng)
                        marker.title = CaveFields.name(cave)
                        marker.snippet = CaveFields.id(cave)
                        marker.setOnMarkerClickListener { m, _ ->
                            CaveFields.id(cave)?.let(onOpenCave)
                            m.showInfoWindow()
                            true
                        }
                        mapView.overlays.add(marker)
                    }
                }
                mapView.invalidate()
            },
        )

        FloatingActionButton(
            onClick = { showLayerPicker = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) {
            Icon(Icons.Filled.Layers, contentDescription = "Choose hillshade layer")
        }

        if (showLayerPicker) {
            HillshadeLayerSheet(
                files = viewModel.hillshadeFiles,
                selected = viewModel.selectedHillshade,
                onSelect = { viewModel.selectHillshade(it); showLayerPicker = false },
                onDismiss = { showLayerPicker = false },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HillshadeLayerSheet(
    files: List<com.floridacavesurvey.android.data.model.HillshadeFile>,
    selected: com.floridacavesurvey.android.data.model.HillshadeFile?,
    onSelect: (com.floridacavesurvey.android.data.model.HillshadeFile?) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(16.dp).padding(bottom = 24.dp)) {
            Text("Hillshade layer", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(8.dp))
            ListItem(
                headlineContent = { Text("Standard map (no hillshade)") },
                leadingContent = { RadioButton(selected = selected == null, onClick = { onSelect(null) }) },
                modifier = Modifier.clickableRow { onSelect(null) },
            )
            files.forEach { file ->
                ListItem(
                    headlineContent = { Text(file.name) },
                    leadingContent = { RadioButton(selected = selected?.name == file.name, onClick = { onSelect(file) }) },
                    modifier = Modifier.clickableRow { onSelect(file) },
                )
            }
        }
    }
}

private fun Modifier.clickableRow(onClick: () -> Unit): Modifier =
    this.then(androidx.compose.foundation.clickable(onClick = onClick))
