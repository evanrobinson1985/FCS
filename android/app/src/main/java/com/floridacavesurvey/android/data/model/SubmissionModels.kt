package com.floridacavesurvey.android.data.model

data class LatLng(val lat: Double, val lng: Double)

/**
 * A cave-database proposal from a member, reviewed by an admin/webmaster.
 * `proposedData`/`currentCaveData` stay as raw maps for the same reason
 * [CaveRecord] does - they hold partial or full cave-record fields with the
 * same aliasing quirks.
 */
data class Submission(
    val submissionId: String,
    val type: String,
    val caveId: String,
    val caveName: String? = null,
    val caveType: String? = null,
    val state: String? = null,
    val county: String? = null,
    val proposedData: Map<String, Any?>? = null,
    val currentCaveData: Map<String, Any?>? = null,
    val originalCoordinates: LatLng? = null,
    val submittedBy: String? = null,
    val submittedAt: String? = null,
    val status: String = "pending",
    val approvedBy: String? = null,
    val approvedDate: String? = null,
    val assignedCaveId: String? = null,
    val rejectedBy: String? = null,
    val rejectedDate: String? = null,
    val rejectionReason: String? = null,
)

data class CreateSubmissionRequest(
    val type: String,
    val caveId: String,
    val caveName: String? = null,
    val county: String? = null,
    val proposedData: Map<String, Any?>,
)

data class CreateSubmissionResponse(val message: String, val submission: Submission)

data class SubmissionDecisionRequest(
    val status: String,
    val rejectionReason: String? = null,
)

data class SubmissionDecisionResponse(val message: String, val submission: Submission)
