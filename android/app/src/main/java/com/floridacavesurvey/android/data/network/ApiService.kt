package com.floridacavesurvey.android.data.network

import com.floridacavesurvey.android.data.model.*
import okhttp3.MultipartBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.*

/**
 * Mirrors the FCS server's REST API exactly as cataloged from server.js -
 * see the project's api-reference notes. Two things worth remembering while
 * reading this file: (1) narrative routes are NOT under /api (matches the
 * server's own inconsistency, not a typo here); (2) DELETE /api/delete-user
 * sends a JSON body, which OkHttp supports but is unusual for DELETE.
 */
interface ApiService {

    // --- Auth & 2FA ------------------------------------------------------

    @POST("api/login")
    suspend fun login(@Body body: LoginRequest): LoginResult

    /** Passwordless sign-in for one pre-designated account, restricted server-side by email
     * (see GOOGLE_WEBMASTER_EMAIL in server.js) - returns the same pending-2FA shape as a normal
     * login always does for this route, never a completed session on its own. Webmaster flavor
     * only; answers 503 if the server isn't configured for it. */
    @POST("api/google-login")
    suspend fun googleLogin(@Body body: GoogleLoginRequest): LoginResult

    @POST("api/verify-2fa")
    suspend fun verifyTwoFactor(@Body body: VerifyTwoFactorRequest): LoginResult

    @POST("api/resend-2fa")
    suspend fun resendTwoFactor(@Body body: ResendTwoFactorRequest): ResendTwoFactorResponse

    @POST("api/toggle-2fa")
    suspend fun toggleTwoFactor(@Body body: ToggleTwoFactorRequest): ToggleTwoFactorResponse

    @POST("api/forgot-password")
    suspend fun forgotPassword(@Body body: ForgotPasswordRequest): SimpleSuccessResponse

    @POST("api/reset-password")
    suspend fun resetPassword(@Body body: ResetPasswordRequest): SimpleSuccessResponse

    @POST("api/change-password")
    suspend fun changePassword(@Body body: ChangePasswordRequest): SimpleSuccessResponse

    @POST("api/create-account")
    suspend fun createAccount(@Body body: CreateAccountRequest): SimpleSuccessResponse

    // --- Cave database -----------------------------------------------------

    @GET("api/cave-database")
    suspend fun getCaveDatabase(): List<CaveRecord>

    @GET("api/cave-database/state-counts")
    suspend fun getStateCounts(): StateCountsResponse

    @POST("api/save-cave-database")
    suspend fun updateCave(@Body body: SaveCaveActionRequest): SaveCaveResponse

    @POST("api/save-cave-database")
    suspend fun createCave(@Body body: SaveCaveActionRequest): SaveCaveResponse

    @POST("api/save-cave-database")
    suspend fun replaceCaveDatabase(@Body caves: List<CaveRecord>): SaveCaveResponse

    @POST("api/update-cave-location")
    suspend fun updateCaveLocation(@Body body: UpdateCaveLocationRequest): SimpleSuccessResponse

    @GET("api/states")
    suspend fun getStates(): List<StateInfo>

    @Multipart
    @POST("api/cave-database/import")
    suspend fun importCaveDatabase(
        @Part importFile: MultipartBody.Part,
        @Part("state") state: okhttp3.RequestBody,
    ): CaveImportResponse

    // --- Submissions ---------------------------------------------------

    @GET("api/pending-submissions")
    suspend fun getPendingSubmissions(): List<Submission>

    @GET("api/approved-submissions")
    suspend fun getApprovedSubmissions(): List<Submission>

    @POST("api/pending-submissions")
    suspend fun createSubmission(@Body body: CreateSubmissionRequest): CreateSubmissionResponse

    @PATCH("api/pending-submissions/{id}")
    suspend fun decideSubmission(
        @Path("id") id: String,
        @Body body: SubmissionDecisionRequest,
    ): SubmissionDecisionResponse

    @DELETE("api/pending-submissions/{id}")
    suspend fun deleteSubmission(@Path("id") id: String): SimpleSuccessResponse

    // --- Cave maps & hillshades ------------------------------------------

    @GET("api/cave-maps/list")
    suspend fun getCaveMaps(): List<CaveMapFile>

    @GET("api/cave-maps/validate/{type}/{filename}")
    suspend fun validateShapefile(
        @Path("type") type: String,
        @Path("filename") filename: String,
    ): ResponseBody

    @GET("api/cave-maps-collection/list")
    suspend fun getCaveMapsCollection(): List<CaveMapCollectionFile>

    @Streaming
    @GET("api/cave-maps-collection/download/{filename}")
    suspend fun downloadCaveMapCollectionFile(@Path("filename") filename: String): ResponseBody

    @Multipart
    @POST("api/cave-maps/upload")
    suspend fun uploadCaveMaps(@Part mapFiles: List<MultipartBody.Part>): UploadCaveMapsResponse

    @DELETE("api/cave-maps/{type}/{filename}")
    suspend fun deleteCaveMap(
        @Path("type") type: String,
        @Path("filename") filename: String,
    ): SimpleSuccessResponse

    @GET("api/sqlite-hillshades/list")
    suspend fun getHillshadeList(): List<HillshadeFile>

    @GET("api/sqlite-hillshades/bounds/{filename}")
    suspend fun getHillshadeBounds(@Path("filename") filename: String): HillshadeBounds

    @Streaming
    @GET("api/sqlite-hillshades/tiles/{filename}/{z}/{x}/{y}")
    suspend fun getHillshadeTile(
        @Path("filename") filename: String,
        @Path("z") z: Int,
        @Path("x") x: Int,
        @Path("y") y: Int,
    ): Response<ResponseBody>

    // --- Narratives (NOT under /api - matches the server) -----------------

    @GET("get-narrative")
    suspend fun getNarrative(@Query("id") caveId: String): List<NarrativeEntry>

    @GET("get-caves-with-narratives")
    suspend fun getCavesWithNarratives(): List<String>

    @POST("save-narrative")
    suspend fun saveNarrative(@Body body: SaveNarrativeRequest): SimpleSuccessResponse

    @HTTP(method = "DELETE", path = "delete-narrative", hasBody = true)
    suspend fun deleteNarrative(@Body body: DeleteNarrativeRequest): DeleteNarrativeResponse

    @HTTP(method = "DELETE", path = "delete-narrative-image", hasBody = true)
    suspend fun deleteNarrativeImage(@Body body: DeleteNarrativeImageRequest): SimpleSuccessResponse

    @Multipart
    @POST("upload-narrative-image")
    suspend fun uploadNarrativeImage(@Part image: MultipartBody.Part): UploadNarrativeImageResponse

    @Streaming
    @GET("download-narrative-image/{filename}")
    suspend fun downloadNarrativeImage(@Path("filename") filename: String): ResponseBody

    @GET("get-all-narratives-log")
    suspend fun getAllNarrativesLog(): List<NarrativeLogEntry>

    // --- Admin / users (webmaster only) -----------------------------------

    @GET("api/users")
    suspend fun getUsers(): List<AdminUser>

    @POST("api/change-user-role")
    suspend fun changeUserRole(@Body body: ChangeUserRoleRequest): SimpleSuccessResponse

    @POST("api/change-user-states")
    suspend fun changeUserStates(@Body body: ChangeUserStatesRequest): SimpleSuccessResponse

    @POST("api/toggle-user-status")
    suspend fun toggleUserStatus(@Body body: ToggleUserStatusRequest): SimpleSuccessResponse

    @HTTP(method = "DELETE", path = "api/delete-user", hasBody = true)
    suspend fun deleteUser(@Body body: DeleteUserRequest): SimpleSuccessResponse

    @GET("api/security-logs")
    suspend fun getSecurityLogs(): List<SecurityLogEntry>

    // --- Site config / status / deploy ------------------------------------

    @GET("api/site-status")
    suspend fun getSiteStatus(): SiteConfig

    @GET("api/site-config")
    suspend fun getSiteConfig(): SiteConfig

    /** Partial update - only include the keys actually being changed (see api-reference §7). */
    @POST("api/site-config")
    suspend fun updateSiteConfig(@Body body: Map<String, @JvmSuppressWildcards Any?>): SiteConfig

    @GET("api/update-status")
    suspend fun getUpdateStatus(): UpdateStatusResponse

    @POST("api/update-now")
    suspend fun updateNow(): UpdateNowResponse

    @Streaming
    @GET("api/backup-now")
    suspend fun backupNow(): ResponseBody
}

data class CaveImportResponse(
    val message: String,
    val imported: Int,
    val total: Int,
    val report: List<CaveImportRow>? = null,
)

data class CaveImportRow(
    val row: Int,
    val status: String,
    val caveId: String? = null,
    val name: String? = null,
    val reason: String? = null,
)
