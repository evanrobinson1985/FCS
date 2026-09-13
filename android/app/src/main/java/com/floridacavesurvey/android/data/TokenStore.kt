package com.floridacavesurvey.android.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.floridacavesurvey.android.data.model.SessionUser
import com.squareup.moshi.Moshi
import com.squareup.moshi.adapter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds the session JWT and the decoded user it belongs to. Backed by
 * EncryptedSharedPreferences (not plain SharedPreferences/DataStore) since a
 * leaked JWT is a full account takeover for up to its 8h server-side expiry.
 */
class TokenStore(context: Context) {

    private val moshi = Moshi.Builder().build()
    private val userAdapter = moshi.adapter<SessionUser>()

    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "fcs_secure_session",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val _session = MutableStateFlow(loadFromPrefs())
    val session: StateFlow<Session?> = _session.asStateFlow()

    val currentToken: String?
        get() = _session.value?.token

    private fun loadFromPrefs(): Session? {
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        val userJson = prefs.getString(KEY_USER, null) ?: return null
        val user = runCatching { userAdapter.fromJson(userJson) }.getOrNull() ?: return null
        return Session(token, user)
    }

    fun save(token: String, user: SessionUser) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_USER, userAdapter.toJson(user))
            .apply()
        _session.value = Session(token, user)
    }

    fun updateUser(transform: (SessionUser) -> SessionUser) {
        val current = _session.value ?: return
        save(current.token, transform(current.user))
    }

    fun clear() {
        prefs.edit().clear().apply()
        _session.value = null
    }

    data class Session(val token: String, val user: SessionUser)

    private companion object {
        const val KEY_TOKEN = "jwt"
        const val KEY_USER = "user"
    }
}
