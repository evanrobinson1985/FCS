package com.floridacavesurvey.android.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Terrain
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.NavType
import androidx.navigation.navArgument
import com.floridacavesurvey.android.data.model.CaveRecord
import com.floridacavesurvey.android.data.model.SessionUser
import com.floridacavesurvey.android.ui.admin.*
import com.floridacavesurvey.android.ui.auth.*
import com.floridacavesurvey.android.ui.caves.CaveDetailScreen
import com.floridacavesurvey.android.ui.caves.CaveListScreen
import com.floridacavesurvey.android.ui.caves.ProposeCaveEditScreen
import com.floridacavesurvey.android.ui.localAppContainer
import com.floridacavesurvey.android.ui.map.MapScreen
import com.floridacavesurvey.android.ui.narratives.NarrativeDetailScreen
import com.floridacavesurvey.android.ui.narratives.NarrativeEditScreen
import com.floridacavesurvey.android.ui.narratives.NarrativeListScreen
import com.floridacavesurvey.android.ui.statistics.StatisticsScreen
import kotlinx.coroutines.flow.collect

private data class BottomTab(val destination: Destination, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val MEMBER_TABS = listOf(
    BottomTab(Destination.CaveList, "Caves", Icons.Filled.Terrain),
    BottomTab(Destination.MapViewer, "Map", Icons.Filled.Map),
    BottomTab(Destination.Statistics, "Stats", Icons.Filled.BarChart),
    BottomTab(Destination.NarrativeList, "Narratives", Icons.Filled.MenuBook),
    BottomTab(Destination.AccountSettings, "Account", Icons.Filled.AccountCircle),
)

private val WEBMASTER_EXTRA_TAB = BottomTab(Destination.AdminUsers, "Admin", Icons.Filled.AdminPanelSettings)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FcsNavHost() {
    val container = localAppContainer()
    val session by container.tokenStore.session.collectAsState()
    val navController = rememberNavController()

    // A 401/403 anywhere in the app drops the user back on the login screen (see SessionInterceptor).
    LaunchedEffect(Unit) {
        com.floridacavesurvey.android.data.network.SessionExpiredNotifier.events.collect {
            navController.navigate(Destination.Login.route) {
                popUpTo(0)
            }
        }
    }

    if (session == null) {
        AuthGraph(navController)
    } else {
        MainAppScaffold(navController, session!!.user)
    }
}

@Composable
private fun AuthGraph(navController: androidx.navigation.NavHostController) {
    NavHost(navController = navController, startDestination = Destination.Login.route) {
        composable(Destination.Login.route) {
            LoginScreen(
                onLoggedIn = { /* session flow flips FcsNavHost over automatically */ },
                onForgotPassword = { navController.navigate(Destination.ForgotPassword.route) },
                onCreateAccount = { navController.navigate(Destination.CreateAccount.route) },
            )
        }
        composable(Destination.ForgotPassword.route) {
            ForgotPasswordScreen(
                onBack = { navController.popBackStack() },
                onHaveResetToken = { navController.navigate(Destination.ResetPassword.buildRoute("")) },
            )
        }
        composable(Destination.CreateAccount.route) {
            CreateAccountScreen(onBack = { navController.popBackStack() })
        }
        composable(
            Destination.ResetPassword.route,
            arguments = listOf(navArgument(Destination.ResetPassword.ARG_TOKEN) { type = NavType.StringType; defaultValue = "" }),
        ) { entry ->
            val token = entry.arguments?.getString(Destination.ResetPassword.ARG_TOKEN).orEmpty()
            ResetPasswordScreen(initialToken = token, onBack = { navController.popBackStack() }, onDone = { navController.popBackStack() })
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainAppScaffold(navController: androidx.navigation.NavHostController, user: SessionUser) {
    val tabs = if (user.isWebmasterOrAdmin) MEMBER_TABS + WEBMASTER_EXTRA_TAB else MEMBER_TABS
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination

    Scaffold(
        bottomBar = {
            val isTopLevel = tabs.any { currentRoute?.hierarchy?.any { d -> d.route == it.destination.route } == true }
            if (isTopLevel) {
                NavigationBar {
                    tabs.forEach { tab ->
                        NavigationBarItem(
                            selected = currentRoute?.hierarchy?.any { it.route == tab.destination.route } == true,
                            onClick = {
                                navController.navigate(tab.destination.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(tab.icon, contentDescription = tab.label) },
                            label = { Text(tab.label) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Destination.CaveList.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(Destination.CaveList.route) {
                CaveListScreen(onOpenCave = { navController.navigate(Destination.CaveDetail.buildRoute(it)) })
            }
            composable(
                Destination.CaveDetail.route,
                arguments = listOf(navArgument(Destination.CaveDetail.ARG_CAVE_ID) { type = NavType.StringType }),
            ) { entry ->
                val caveId = entry.arguments?.getString(Destination.CaveDetail.ARG_CAVE_ID).orEmpty()
                var proposeEditTarget by remember { mutableStateOf<CaveRecord?>(null) }
                val target = proposeEditTarget
                if (target != null) {
                    ProposeCaveEditScreen(cave = target, onBack = { proposeEditTarget = null })
                } else {
                    CaveDetailScreen(
                        caveId = java.net.URLDecoder.decode(caveId, "UTF-8"),
                        canEdit = user.isWebmasterOrAdmin,
                        onBack = { navController.popBackStack() },
                        onViewNarrative = { navController.navigate(Destination.NarrativeDetail.buildRoute(it)) },
                        onProposeEdit = { proposeEditTarget = it },
                    )
                }
            }

            composable(Destination.MapViewer.route) {
                MapScreen(onOpenCave = { navController.navigate(Destination.CaveDetail.buildRoute(it)) })
            }

            composable(Destination.Statistics.route) {
                StatisticsScreen()
            }

            composable(Destination.NarrativeList.route) {
                NarrativeListScreen(onOpenCaveNarrative = { navController.navigate(Destination.NarrativeDetail.buildRoute(it)) })
            }
            composable(
                Destination.NarrativeDetail.route,
                arguments = listOf(navArgument(Destination.NarrativeDetail.ARG_CAVE_ID) { type = NavType.StringType }),
            ) { entry ->
                val caveId = java.net.URLDecoder.decode(entry.arguments?.getString(Destination.NarrativeDetail.ARG_CAVE_ID).orEmpty(), "UTF-8")
                NarrativeDetailScreen(
                    caveId = caveId,
                    currentUsername = user.username,
                    isModerator = user.isWebmasterOrAdmin,
                    onBack = { navController.popBackStack() },
                    onWriteOrEdit = { navController.navigate(Destination.NarrativeEdit.buildRoute(caveId)) },
                )
            }
            composable(
                Destination.NarrativeEdit.route,
                arguments = listOf(navArgument(Destination.NarrativeEdit.ARG_CAVE_ID) { type = NavType.StringType }),
            ) { entry ->
                val caveId = java.net.URLDecoder.decode(entry.arguments?.getString(Destination.NarrativeEdit.ARG_CAVE_ID).orEmpty(), "UTF-8")
                NarrativeEditScreen(caveId = caveId, onBack = { navController.popBackStack() }, onSaved = { navController.popBackStack() })
            }

            composable(Destination.AccountSettings.route) {
                AccountSettingsScreen(
                    onBack = { navController.popBackStack() },
                    onLoggedOut = { /* session flip handles navigation */ },
                )
            }

            if (user.isWebmasterOrAdmin) {
                composable(Destination.AdminUsers.route) { AdminScaffold(navController, "Users") { UsersScreen() } }
                composable(Destination.AdminSubmissions.route) { AdminScaffold(navController, "Submissions") { SubmissionsScreen() } }
                composable(Destination.AdminCaveMaps.route) { AdminScaffold(navController, "Cave Maps") { CaveMapsScreen() } }
                if (user.role == "webmaster") {
                    composable(Destination.AdminSiteConfig.route) { AdminScaffold(navController, "Site Config") { SiteConfigScreen() } }
                    composable(Destination.AdminSecurityLogs.route) { AdminScaffold(navController, "Security Logs") { SecurityLogsScreen() } }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AdminScaffold(navController: androidx.navigation.NavHostController, title: String, content: @Composable () -> Unit) {
    Scaffold(topBar = {
        TopAppBar(title = { Text(title) }, actions = { AdminSectionMenu(navController) })
    }) { padding ->
        androidx.compose.foundation.layout.Box(modifier = Modifier.padding(padding)) { content() }
    }
}

@Composable
private fun AdminSectionMenu(navController: androidx.navigation.NavHostController) {
    var expanded by remember { mutableStateOf(false) }
    IconButton(onClick = { expanded = true }) { Icon(Icons.Filled.AdminPanelSettings, contentDescription = "Admin sections") }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        DropdownMenuItem(text = { Text("Users") }, onClick = { expanded = false; navController.navigate(Destination.AdminUsers.route) })
        DropdownMenuItem(text = { Text("Submissions") }, onClick = { expanded = false; navController.navigate(Destination.AdminSubmissions.route) })
        DropdownMenuItem(text = { Text("Cave Maps") }, onClick = { expanded = false; navController.navigate(Destination.AdminCaveMaps.route) })
        DropdownMenuItem(text = { Text("Site Config") }, onClick = { expanded = false; navController.navigate(Destination.AdminSiteConfig.route) })
        DropdownMenuItem(text = { Text("Security Logs") }, onClick = { expanded = false; navController.navigate(Destination.AdminSecurityLogs.route) })
    }
}
