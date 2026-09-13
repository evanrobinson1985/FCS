package com.floridacavesurvey.android.data.repository

import com.floridacavesurvey.android.data.model.*
import com.floridacavesurvey.android.data.network.ApiService

class AdminRepository(private val api: ApiService) {

    suspend fun getUsers(): List<AdminUser> = api.getUsers()

    suspend fun changeRole(username: String, newRole: String) =
        api.changeUserRole(ChangeUserRoleRequest(username, newRole))

    suspend fun changeStates(username: String, allowedStates: List<String>) =
        api.changeUserStates(ChangeUserStatesRequest(username, allowedStates))

    suspend fun toggleStatus(username: String, isActive: Boolean) =
        api.toggleUserStatus(ToggleUserStatusRequest(username, isActive))

    suspend fun deleteUser(username: String) = api.deleteUser(DeleteUserRequest(username))

    suspend fun getSecurityLogs(): List<SecurityLogEntry> = api.getSecurityLogs()
}

class SiteConfigRepository(private val api: ApiService) {

    suspend fun getPublicStatus(): SiteConfig = api.getSiteStatus()

    suspend fun getFullConfig(): SiteConfig = api.getSiteConfig()

    suspend fun update(fields: Map<String, Any?>): SiteConfig = api.updateSiteConfig(fields)

    suspend fun getUpdateStatus(): UpdateStatusResponse = api.getUpdateStatus()

    suspend fun updateNow(): UpdateNowResponse = api.updateNow()
}
