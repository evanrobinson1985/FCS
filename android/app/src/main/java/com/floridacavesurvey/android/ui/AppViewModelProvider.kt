package com.floridacavesurvey.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.floridacavesurvey.android.FcsApplication
import com.floridacavesurvey.android.data.AppContainer

/** Resolves the process-wide [AppContainer] from any composable, for building ViewModel factories inline. */
@Composable
fun localAppContainer(): AppContainer {
    val context = LocalContext.current
    return (context.applicationContext as FcsApplication).container
}
