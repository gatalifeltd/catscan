// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
package org.catscan.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private enum class Screen { Onboarding, Settings, Game }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                var screen by rememberSaveable { mutableStateOf(Screen.Onboarding) }
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.White)
                        // Maestro `id:` selectors match Compose testTags only with this flag.
                        .semantics { testTagsAsResourceId = true }
                        .systemBarsPadding(),
                ) {
                    when (screen) {
                        Screen.Onboarding -> Onboarding { screen = Screen.Settings }
                        Screen.Settings -> Settings { screen = Screen.Game }
                        Screen.Game -> Game()
                    }
                }
            }
        }
    }
}

@Composable
private fun Onboarding(onNext: () -> Unit) {
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.onboarding_title), color = Color.Black, style = MaterialTheme.typography.headlineLarge)
        // FAULTS plants a raw string key, the defect catscan must report. It is the body, not the large title,
        // because Vision reads a title's "." as a space, which only a catalog run maps back.
        val body = if (BuildConfig.FAULTS) "onboarding.body" else stringResource(R.string.onboarding_body)
        Text(body, color = Color.Black)
        Button(onClick = onNext, modifier = Modifier.testTag("next")) {
            Text(stringResource(R.string.onboarding_next))
        }
    }
}

@Composable
private fun Settings(onPlay: () -> Unit) {
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(
            stringResource(R.string.settings_title),
            color = Color.Black,
            style = MaterialTheme.typography.headlineLarge,
        )
        val label = stringResource(R.string.settings_notifications)
        if (BuildConfig.FAULTS) {
            // FAULTS plants a tail ellipsis: the German compound cannot fit in 150dp.
            Text(
                label,
                color = Color.Black,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.width(150.dp).testTag("notifications-label"),
            )
        } else {
            Text(
                label,
                color = Color.Black,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.fillMaxWidth().testTag("notifications-label"),
            )
        }
        Button(onClick = onPlay, modifier = Modifier.testTag("play")) {
            Text(stringResource(R.string.settings_play))
        }
    }
}

@Composable
private fun Game() {
    val measurer = rememberTextMeasurer()
    val complete = stringResource(R.string.game_complete)
    val score = stringResource(R.string.game_score)
    // Drawn text with no semantics: only OCR on the screenshot can read it.
    Canvas(
        modifier = Modifier
            .fillMaxSize()
            .testTag("game")
            .background(Color(0xFF0D1B4D))
            .clearAndSetSemantics {},
    ) {
        val big = TextStyle(color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Bold)
        val small = TextStyle(color = Color.White, fontSize = 24.sp)
        val margin = 24.dp.toPx()
        drawText(measurer, complete, topLeft = Offset(margin, size.height / 3), style = big)
        drawText(measurer, score, topLeft = Offset(margin, size.height / 3 + 72.dp.toPx()), style = small)
    }
}
