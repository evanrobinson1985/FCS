package com.floridacavesurvey.android.ui.auth

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import com.floridacavesurvey.android.BuildConfig
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException

/**
 * Launches Android's Credential Manager "Sign in with Google" sheet and returns the Google ID
 * token to hand to POST /api/google-login (webmaster flavor only - see BuildConfig.
 * SHOW_GOOGLE_SIGN_IN and .env.example's GOOGLE_OAUTH_CLIENT_ID/GOOGLE_WEBMASTER_EMAIL on the
 * server side, which is what actually restricts this to one account).
 *
 * `context` must be an Activity context - Credential Manager needs one to show the picker UI.
 */
suspend fun requestGoogleIdToken(context: Context): Result<String> {
    if (BuildConfig.GOOGLE_WEB_CLIENT_ID.isBlank()) {
        return Result.failure(IllegalStateException("Google sign-in isn't configured for this build (missing googleWebClientId)."))
    }
    return try {
        val option = GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        val response = CredentialManager.create(context).getCredential(context, request)

        val credential = response.credential
        if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            val googleIdTokenCredential = GoogleIdTokenCredential.createFrom(credential.data)
            Result.success(googleIdTokenCredential.idToken)
        } else {
            Result.failure(IllegalStateException("Unexpected credential type from Google sign-in."))
        }
    } catch (e: GoogleIdTokenParsingException) {
        Result.failure(e)
    } catch (e: Exception) {
        Result.failure(e)
    }
}
