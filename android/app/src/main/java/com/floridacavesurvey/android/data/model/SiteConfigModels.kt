package com.floridacavesurvey.android.data.model

/**
 * Covers both GET /api/site-status (public subset) and GET /api/site-config
 * (webmaster-only, superset with lockout/auto-update fields) - unset fields
 * on the public response simply come back null.
 */
data class SiteConfig(
    val maintenanceMode: Boolean = false,
    val maintenanceActive: Boolean = false,
    val maintenanceMessage: String? = null,
    val scheduledMaintenanceStart: String? = null,
    val scheduledMaintenanceEnd: String? = null,
    val bannerEnabled: Boolean = false,
    val bannerMessage: String? = null,
    val bannerHtml: String? = null,
    val bannerColor: String? = null,
    val readOnlyMode: Boolean = false,
    val readOnlyMessage: String? = null,
    val loginLockoutThreshold: Int? = null,
    val loginLockoutMinutes: Int? = null,
    val autoUpdateEnabled: Boolean? = null,
    val autoUpdateTime: String? = null,
)

data class UpdateStatusResponse(
    val gitAvailable: Boolean,
    val branch: String? = null,
    val currentCommit: String? = null,
    val currentCommitShort: String? = null,
    val currentSummary: String? = null,
    val remoteCommit: String? = null,
    val upToDate: Boolean? = null,
    val commitsBehind: Int? = null,
    val pendingCommits: List<PendingCommit>? = null,
    val dirty: Boolean? = null,
    val error: String? = null,
)

data class PendingCommit(val hash: String, val date: String, val subject: String)

data class UpdateNowResponse(
    val updated: Boolean,
    val message: String? = null,
    val branch: String? = null,
    val previousCommit: String? = null,
    val previousCommitShort: String? = null,
    val newCommit: String? = null,
    val newCommitShort: String? = null,
    val currentCommit: String? = null,
    val changedFiles: List<String>? = null,
    val dependenciesInstalled: Boolean? = null,
    val dependencyInstallError: String? = null,
    val restartTriggered: Boolean? = null,
    val error: String? = null,
)
