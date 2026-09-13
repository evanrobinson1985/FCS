package com.floridacavesurvey.android.data.network

/** Generic screen-level load state shared by every ViewModel in the app. */
sealed class UiState<out T> {
    data object Loading : UiState<Nothing>()
    data class Success<T>(val data: T) : UiState<T>()
    data class Error(val message: String) : UiState<Nothing>()
}

/** Maps a Retrofit [retrofit2.Response] into a friendly error message, pulling
 * the server's own `{ "error": "..." }` body when present (every FCS API
 * error response uses that shape - see server.js) rather than a bare HTTP
 * status code. */
suspend fun <T> safeApiCall(block: suspend () -> T): Result<T> {
    return try {
        Result.success(block())
    } catch (e: retrofit2.HttpException) {
        val errorBody = e.response()?.errorBody()?.string()
        val message = extractErrorMessage(errorBody) ?: "Request failed (${e.code()})"
        Result.failure(ApiException(message, e.code()))
    } catch (e: java.io.IOException) {
        Result.failure(ApiException("Network error - check your connection and try again.", null))
    } catch (e: Exception) {
        Result.failure(ApiException(e.message ?: "Something went wrong", null))
    }
}

private fun extractErrorMessage(errorBody: String?): String? {
    if (errorBody.isNullOrBlank()) return null
    return try {
        val adapter = NetworkModule.moshi.adapter(ErrorResponse::class.java)
        adapter.fromJson(errorBody)?.error
    } catch (e: Exception) {
        null
    }
}

class ApiException(message: String, val httpCode: Int?) : Exception(message)

data class ErrorResponse(val error: String?)
