package com.floridacavesurvey.android.ui.navigation

/**
 * Every screen in the app, mirroring the tabs/pages of the website's
 * webmaster portal (httpdocs/index.html): auth, the cave database + map,
 * narratives, and the admin/webmaster tools.
 */
sealed class Destination(val route: String) {
    data object Login : Destination("login")
    data object TwoFactor : Destination("two_factor")
    data object ForgotPassword : Destination("forgot_password")
    data object ResetPassword : Destination("reset_password?token={token}") {
        fun buildRoute(token: String) = "reset_password?token=${java.net.URLEncoder.encode(token, "UTF-8")}"
        const val ARG_TOKEN = "token"
    }
    data object CreateAccount : Destination("create_account")

    data object Dashboard : Destination("dashboard")

    data object CaveList : Destination("cave_list")
    data object CaveDetail : Destination("cave_detail/{caveId}") {
        fun buildRoute(caveId: String) = "cave_detail/${java.net.URLEncoder.encode(caveId, "UTF-8")}"
        const val ARG_CAVE_ID = "caveId"
    }

    data object MapViewer : Destination("map_viewer")

    data object Statistics : Destination("statistics")

    data object NarrativeList : Destination("narrative_list")
    data object NarrativeDetail : Destination("narrative_detail/{caveId}") {
        fun buildRoute(caveId: String) = "narrative_detail/${java.net.URLEncoder.encode(caveId, "UTF-8")}"
        const val ARG_CAVE_ID = "caveId"
    }
    data object NarrativeEdit : Destination("narrative_edit/{caveId}") {
        fun buildRoute(caveId: String) = "narrative_edit/${java.net.URLEncoder.encode(caveId, "UTF-8")}"
        const val ARG_CAVE_ID = "caveId"
    }

    data object AdminUsers : Destination("admin_users")
    data object AdminSiteConfig : Destination("admin_site_config")
    data object AdminSecurityLogs : Destination("admin_security_logs")
    data object AdminSubmissions : Destination("admin_submissions")
    data object AdminCaveMaps : Destination("admin_cave_maps")

    data object AccountSettings : Destination("account_settings")
}
