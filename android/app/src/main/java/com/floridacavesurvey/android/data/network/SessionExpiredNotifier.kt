package com.floridacavesurvey.android.data.network

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Bridges a 401/403 ("Invalid or expired session") response, which can
 * surface from any repository call, back up to the navigation layer so it
 * can drop the user back on the login screen. A SharedFlow rather than a
 * thrown exception because it needs to reach a completely different part of
 * the UI tree than whichever screen happened to trigger it.
 */
object SessionExpiredNotifier {
    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = _events.asSharedFlow()

    fun notify() {
        _events.tryEmit(Unit)
    }
}
