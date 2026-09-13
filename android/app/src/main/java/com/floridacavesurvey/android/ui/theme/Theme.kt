package com.floridacavesurvey.android.ui.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LightColors = lightColorScheme(
    primary = CaveGreen,
    onPrimary = SurfaceLight,
    secondary = AmberAccent,
    onSecondary = SurfaceLight,
    background = SurfaceLight,
    surface = SurfaceLight,
    error = ErrorRed,
    tertiary = LimestoneTanDark,
)

private val DarkColors = darkColorScheme(
    primary = CaveGreenLight,
    onPrimary = SurfaceDark,
    secondary = AmberAccent,
    onSecondary = SurfaceDark,
    background = CaveGreenDark,
    surface = SurfaceDark,
    error = ErrorRed,
    tertiary = LimestoneTan,
)

@Composable
fun FloridaCaveSurveyTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        val activity = view.context as? Activity
        if (activity != null) {
            activity.window.statusBarColor = colorScheme.primary.toArgb()
            WindowCompat.getInsetsController(activity.window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = FcsTypography,
        content = content,
    )
}
