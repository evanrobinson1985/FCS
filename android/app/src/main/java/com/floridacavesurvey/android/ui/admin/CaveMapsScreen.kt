package com.floridacavesurvey.android.ui.admin

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.floridacavesurvey.android.data.model.CaveMapFile
import com.floridacavesurvey.android.data.network.UiState
import com.floridacavesurvey.android.data.network.safeApiCall
import com.floridacavesurvey.android.data.repository.MapRepository
import com.floridacavesurvey.android.ui.common.EmptyState
import com.floridacavesurvey.android.ui.common.UiStateContent
import com.floridacavesurvey.android.ui.localAppContainer
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

class CaveMapsViewModel(private val repo: MapRepository) : ViewModel() {
    var files by mutableStateOf<UiState<List<CaveMapFile>>>(UiState.Loading)
        private set
    var isUploading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    init { load() }

    fun load() {
        viewModelScope.launch {
            files = UiState.Loading
            safeApiCall { repo.getCaveMaps() }
                .onSuccess { files = UiState.Success(it) }
                .onFailure { files = UiState.Error(it.message ?: "Failed to load cave maps") }
        }
    }

    fun upload(uploadFile: File, mimeType: String) {
        viewModelScope.launch {
            isUploading = true
            error = null
            val body = uploadFile.asRequestBody(mimeType.toMediaTypeOrNull())
            val part = MultipartBody.Part.createFormData("mapFiles", uploadFile.name, body)
            safeApiCall { repo.uploadCaveMaps(listOf(part)) }
                .onSuccess { load() }
                .onFailure { error = it.message }
            isUploading = false
        }
    }

    fun delete(type: String, filename: String) {
        viewModelScope.launch {
            safeApiCall { repo.deleteCaveMap(type, filename) }.onSuccess { load() }.onFailure { error = it.message }
        }
    }
}

@Composable
fun CaveMapsScreen() {
    val container = localAppContainer()
    val viewModel: CaveMapsViewModel = viewModel(
        factory = viewModelFactory { initializer { CaveMapsViewModel(container.mapRepository) } },
    )
    val context = LocalContext.current

    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri != null) {
            val cursor = context.contentResolver.query(uri, null, null, null, null)
            var name = "upload_${System.currentTimeMillis()}"
            cursor?.use {
                val idx = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (it.moveToFirst() && idx >= 0) name = it.getString(idx)
            }
            val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
            val dir = File(context.cacheDir, "map_uploads").apply { mkdirs() }
            val outFile = File(dir, name)
            context.contentResolver.openInputStream(uri)?.use { input ->
                outFile.outputStream().use { output -> input.copyTo(output) }
            }
            viewModel.upload(outFile, mime)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(modifier = Modifier.padding(16.dp)) {
            Button(onClick = { pickFile.launch("*/*") }, enabled = !viewModel.isUploading) {
                Icon(Icons.Filled.UploadFile, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(if (viewModel.isUploading) "Uploading…" else "Upload map file")
            }
        }
        viewModel.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }

        UiStateContent(state = viewModel.files, onRetry = viewModel::load) { files ->
            if (files.isEmpty()) {
                EmptyState("No geotiff or shapefile maps uploaded yet.")
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(files, key = { it.id }) { file ->
                        ListItem(
                            headlineContent = { Text(file.name) },
                            supportingContent = { Text(file.type) },
                            trailingContent = {
                                IconButton(onClick = {
                                    val type = if (file.type == "geotiff") "geotiff" else "shapefiles"
                                    viewModel.delete(type, file.name)
                                }) { Icon(Icons.Filled.Delete, contentDescription = "Delete") }
                            },
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}
