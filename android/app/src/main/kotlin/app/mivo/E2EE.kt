package app.mivo

import android.util.Base64
import com.google.crypto.tink.CleartextKeysetHandle
import com.google.crypto.tink.HybridDecrypt
import com.google.crypto.tink.HybridEncrypt
import com.google.crypto.tink.JsonKeysetReader
import com.google.crypto.tink.JsonKeysetWriter
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.hybrid.HybridConfig
import java.io.ByteArrayOutputStream

/**
 * Secret Chat crypto: Google Tink ECIES (P-256 + HKDF + AES-128-GCM). No home-made crypto.
 * Each message is encrypted twice (for the recipient and for the sender), the server stores ciphertext only.
 * LIMITS (v0.1): static device keys -> no forward secrecy, no sender authentication, no key-change warning,
 * one device per account. Do not advertise as secure before review (see SECURITY_REPORT.md).
 */
object E2EE {
    private var ready = false

    private fun init() {
        if (!ready) {
            HybridConfig.register()
            ready = true
        }
    }

    private fun toJson(h: KeysetHandle): String {
        val o = ByteArrayOutputStream()
        CleartextKeysetHandle.write(h, JsonKeysetWriter.withOutputStream(o))
        return o.toString("UTF-8")
    }

    private fun fromJson(s: String): KeysetHandle = CleartextKeysetHandle.read(JsonKeysetReader.withString(s))
    private fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)

    private fun priv(store: Store, uid: Long): KeysetHandle {
        init()
        store.privateKey(uid)?.let { return fromJson(it) }
        val h = KeysetHandle.generateNew(KeyTemplates.get("ECIES_P256_HKDF_HMAC_SHA256_AES128_GCM"))
        store.setPrivateKey(uid, toJson(h))
        return h
    }

    /** Public key as base64(JSON keyset) - safe to upload to the server. */
    fun ownPublic(store: Store, uid: Long): String =
        b64(toJson(priv(store, uid).publicKeysetHandle).toByteArray(Charsets.UTF_8))

    fun encrypt(pubB64: String, text: String): String {
        init()
        val pub = fromJson(String(Base64.decode(pubB64, Base64.NO_WRAP), Charsets.UTF_8))
        val enc = pub.getPrimitive(HybridEncrypt::class.java)
        return b64(enc.encrypt(text.toByteArray(Charsets.UTF_8), ByteArray(0)))
    }

    fun decrypt(store: Store, uid: Long, ctB64: String): String = try {
        val dec = priv(store, uid).getPrimitive(HybridDecrypt::class.java)
        String(dec.decrypt(Base64.decode(ctB64, Base64.NO_WRAP), ByteArray(0)), Charsets.UTF_8)
    } catch (e: Exception) {
        "🔒 Xabarni ochib bo'lmadi"
    }
}
