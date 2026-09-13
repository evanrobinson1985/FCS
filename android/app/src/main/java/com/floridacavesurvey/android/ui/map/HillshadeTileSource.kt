package com.floridacavesurvey.android.ui.map

import com.floridacavesurvey.android.BuildConfig
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import org.osmdroid.util.MapTileIndex

/**
 * Points osmdroid at GET /api/sqlite-hillshades/tiles/:filename/:z/:x/:y (server.js). Auth uses
 * the server's documented `?token=` query-param fallback rather than a header, since osmdroid's
 * built-in tile downloader issues plain GETs with no way to attach custom headers per-request.
 */
class HillshadeTileSource(
    private val filename: String,
    private val jwt: String,
    minZoom: Int,
    maxZoom: Int,
) : OnlineTileSourceBase(
    "FcsHillshade-$filename",
    minZoom,
    maxZoom,
    256,
    ".png",
    arrayOf(BuildConfig.API_BASE_URL),
) {
    override fun getTileURLString(pMapTileIndex: Long): String {
        val z = MapTileIndex.getZoom(pMapTileIndex)
        val x = MapTileIndex.getX(pMapTileIndex)
        val y = MapTileIndex.getY(pMapTileIndex)
        return "${BuildConfig.API_BASE_URL}api/sqlite-hillshades/tiles/$filename/$z/$x/$y?token=$jwt"
    }
}
