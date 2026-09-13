# Moshi here uses its reflection-based KotlinJsonAdapterFactory (no
# codegen/kapt), so it needs the model classes' constructors, field names and
# Kotlin metadata intact at runtime to (de)serialize JSON by property name.
-keep class com.floridacavesurvey.android.data.model.** { *; }
-keepclassmembers class com.floridacavesurvey.android.data.model.** { *; }
-keep class kotlin.Metadata { *; }
-keepclassmembers class * {
    @com.squareup.moshi.FromJson <methods>;
    @com.squareup.moshi.ToJson <methods>;
}
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
