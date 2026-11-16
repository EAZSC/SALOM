package app.mivo

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class ApiResult(val code: Int, val json: JSONObject?) {
    val ok: Boolean get() = code in 200..299
    val error: String
        get() = json?.optString("error").orEmpty().ifEmpty { if (code == 0) "network" else "http_$code" }
}

class Api(val store: Store) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val refreshLock = Mutex()

    @Volatile
    var onLoggedOut: (() -> Unit)? = null

    private fun raw(method: String, path: String, body: JSONObject?, token: String?): ApiResult {
        val b = Request.Builder().url(BuildConfig.API_URL.trimEnd('/') + path)
        if (token != null) b.header("Authorization", "Bearer $token")
        if (method == "GET") b.get() else b.method(method, (body ?: JSONObject()).toString().toRequestBody(jsonType))
        return try {
            client.newCall(b.build()).execute().use { r ->
                val txt = r.body?.string().orEmpty()
                ApiResult(r.code, runCatching { JSONObject(txt) }.getOrNull())
            }
        } catch (e: Exception) {
            ApiResult(0, null)
        }
    }

    suspend fun call(method: String, path: String, body: JSONObject? = null, auth: Boolean = true): ApiResult =
        withContext(Dispatchers.IO) {
            if (!auth) return@withContext raw(method, path, body, null)
            val seen = store.refresh
            var r = raw(method, path, body, store.access)
            if (r.code == 401 && seen != null) {
                if (refresh(seen)) r = raw(method, path, body, store.access)
            }
            r
        }

    /** Serialised so two parallel 401s never reuse the same refresh token (server treats reuse as theft). */
    private suspend fun refresh(seen: String): Boolean = refreshLock.withLock {
        val cur = store.refresh ?: return@withLock false
        if (cur != seen) return@withLock true
        val r = raw("POST", "/auth/refresh", JSONObject().put("refresh_token", cur), null)
        val j = r.json
        if (r.ok && j != null) {
            store.saveTokens(j)
            true
        } else {
            if (r.code == 401) {
                store.clearSession()
                onLoggedOut?.invoke()
            }
            false
        }
    }
}
