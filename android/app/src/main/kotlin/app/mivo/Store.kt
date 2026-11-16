package app.mivo

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/** Tokens and E2EE private keys live only in Keystore-backed EncryptedSharedPreferences. */
class Store(ctx: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        ctx, "mivo_secure",
        MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    val access: String? get() = prefs.getString("access", null)
    val refresh: String? get() = prefs.getString("refresh", null)

    @Synchronized
    fun saveTokens(j: JSONObject) {
        prefs.edit()
            .putString("access", j.getString("access_token"))
            .putString("refresh", j.getString("refresh_token"))
            .apply()
    }

    @Synchronized
    fun clearSession() {
        prefs.edit().remove("access").remove("refresh").apply()
    }

    fun privateKey(userId: Long): String? = prefs.getString("sk_$userId", null)
    fun setPrivateKey(userId: Long, json: String) {
        prefs.edit().putString("sk_$userId", json).apply()
    }
}
