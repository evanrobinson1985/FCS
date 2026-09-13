package com.floridacavesurvey.android.data.repository

import com.floridacavesurvey.android.data.model.CreateSubmissionRequest
import com.floridacavesurvey.android.data.model.CreateSubmissionResponse
import com.floridacavesurvey.android.data.model.Submission
import com.floridacavesurvey.android.data.model.SubmissionDecisionRequest
import com.floridacavesurvey.android.data.model.SubmissionDecisionResponse
import com.floridacavesurvey.android.data.network.ApiService

class SubmissionRepository(private val api: ApiService) {

    suspend fun getPending(): List<Submission> = api.getPendingSubmissions()

    suspend fun getApproved(): List<Submission> = api.getApprovedSubmissions()

    suspend fun create(
        type: String,
        caveId: String,
        caveName: String?,
        county: String?,
        proposedData: Map<String, Any?>,
    ): CreateSubmissionResponse =
        api.createSubmission(CreateSubmissionRequest(type, caveId, caveName, county, proposedData))

    suspend fun approve(id: String): SubmissionDecisionResponse =
        api.decideSubmission(id, SubmissionDecisionRequest(status = "approved"))

    suspend fun reject(id: String, reason: String?): SubmissionDecisionResponse =
        api.decideSubmission(id, SubmissionDecisionRequest(status = "rejected", rejectionReason = reason))

    suspend fun delete(id: String) = api.deleteSubmission(id)
}
