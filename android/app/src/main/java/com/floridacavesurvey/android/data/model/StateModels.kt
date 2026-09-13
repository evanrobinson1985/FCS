package com.floridacavesurvey.android.data.model

data class CountyInfo(
    val code: String,
    val name: String,
)

data class StateInfo(
    val code: String,
    val name: String,
    val caveIdPrefix: String? = null,
    val counties: List<CountyInfo>? = null,
)

data class StateCount(
    val code: String,
    val name: String,
    val count: Int,
)

data class StateCountsResponse(
    val total: Int,
    val states: List<StateCount>,
)
