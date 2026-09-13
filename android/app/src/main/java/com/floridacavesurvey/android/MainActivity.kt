package com.floridacavesurvey.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.floridacavesurvey.android.ui.navigation.FcsNavHost
import com.floridacavesurvey.android.ui.theme.FloridaCaveSurveyTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            FloridaCaveSurveyTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    FcsNavHost()
                }
            }
        }
    }
}
