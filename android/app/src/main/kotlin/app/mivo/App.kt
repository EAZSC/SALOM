package app.mivo

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.json.JSONObject

val Accent = Color(0xFF4DA3FF)
val Bg = Color(0xFF05070D)

@Composable
fun MivoTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = Color(0xFF0D1220), onPrimary = Color.Black),
        content = { Surface(Modifier.fillMaxSize(), color = Bg) { content() } }
    )
}

data class NameItem(val name: String, val primary: Boolean, val listed: Boolean)
data class Me(val id: Long, val username: String, val role: String, val balance: Long, val names: List<NameItem>)
data class Conv(val id: Long, val kind: String, val status: String, val peer: String, val requestedByMe: Boolean)

fun parseMe(j: JSONObject): Me {
    val a = j.getJSONArray("usernames")
    val names = (0 until a.length()).map {
        val o = a.getJSONObject(it)
        NameItem(o.getString("name"), o.getBoolean("primary"), o.getBoolean("listed"))
    }
    return Me(j.getLong("id"), j.getString("username"), j.getString("role"), j.getLong("balance"), names)
}

fun parseConv(o: JSONObject) =
    Conv(o.getLong("id"), o.getString("kind"), o.getString("status"), o.getString("peer"), o.optBoolean("requested_by_me"))

fun errText(code: String): String = when (code) {
    "network" -> "Internet yoki server bilan aloqa yo'q"
    "invalid_credentials" -> "Username yoki parol noto'g'ri"
    "account_locked" -> "Juda ko'p urinish. 15 daqiqadan keyin qayta urining"
    "rate_limited" -> "Juda ko'p so'rov. Biroz kuting"
    "username_taken" -> "Bu username band"
    "invalid_username" -> "Username: 4–20 belgi, lotin kichik harf, raqam yoki _, harf bilan boshlansin"
    "weak_password" -> "Parol kuchsiz: kamida 10 belgi, harf va raqam bo'lsin (yoki 16+ belgi)"
    "insufficient_funds" -> "ASTER yetarli emas"
    "user_not_found" -> "Foydalanuvchi topilmadi"
    "no_key", "peer_no_key" -> "Secret chat uchun ikkala tomon ilovaga kamida bir marta kirgan bo'lishi kerak"
    "rejected" -> "Secret chat rad etilgan"
    "not_available" -> "Bu endi mavjud emas"
    "limit_reached" -> "Limitga yetdi"
    "already_listed" -> "Allaqachon sotuvda"
    "primary_not_sellable" -> "Asosiy username sotilmaydi"
    "banned" -> "Akkaunt bloklangan"
    "not_active" -> "Chat hali faol emas"
    else -> "Xatolik: $code"
}

@Composable
fun AppRoot(api: Api, store: Store) {
    var me by remember { mutableStateOf<Me?>(null) }
    var booting by remember { mutableStateOf(store.refresh != null) }
    var bootErr by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { api.onLoggedOut = { me = null } }

    LaunchedEffect(attempt) {
        if (store.refresh != null && me == null) {
            booting = true
            val r = api.call("GET", "/me")
            val j = r.json
            if (r.ok && j != null) me = parseMe(j)
            else if (r.code == 0) bootErr = errText("network")
            booting = false
        }
    }

    // Publish this device's E2EE public key once logged in.
    LaunchedEffect(me?.id) {
        val m = me ?: return@LaunchedEffect
        runCatching {
            val pub = E2EE.ownPublic(store, m.id)
            api.call("PUT", "/keys", JSONObject().put("pubkey", pub))
        }
    }

    suspend fun reloadMe() {
        val r = api.call("GET", "/me")
        val j = r.json
        if (r.ok && j != null) me = parseMe(j)
    }

    val current = me
    when {
        booting -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        current == null && bootErr != null -> Column(
            Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(bootErr ?: "")
            Spacer(Modifier.height(12.dp))
            Button(onClick = { bootErr = null; attempt++ }) { Text("Qayta urinish") }
            TextButton(onClick = { store.clearSession(); bootErr = null }) { Text("Boshqa akkaunt bilan kirish") }
        }
        current == null -> AuthScreen(api) { me = it }
        else -> MainScreen(api, current, onRefresh = { scope.launch { reloadMe() } }, onLogout = {
            scope.launch {
                api.call("POST", "/auth/logout", JSONObject())
                store.clearSession()
                me = null
            }
        })
    }
}

@Composable
fun AuthScreen(api: Api, onAuthed: (Me) -> Unit) {
    var register by remember { mutableStateOf(false) }
    var u by remember { mutableStateOf("") }
    var p by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("MIVO", fontSize = 42.sp, fontWeight = FontWeight.Bold, color = Accent)
        Text(if (register) "Yangi akkaunt yaratish" else "Hisobga kirish")
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = u, onValueChange = { u = it.lowercase().trim() }, label = { Text("Username") },
            singleLine = true, modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = p, onValueChange = { p = it }, label = { Text("Parol") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth()
        )
        err?.let { Spacer(Modifier.height(8.dp)); Text(it, color = Color(0xFFFF6B6B)) }
        Spacer(Modifier.height(16.dp))
        Button(
            enabled = !busy && u.length >= 4 && p.isNotEmpty(),
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                scope.launch {
                    busy = true; err = null
                    val r = api.call("POST", if (register) "/auth/register" else "/auth/login",
                        JSONObject().put("username", u).put("password", p), auth = false)
                    val rj = r.json
                    if (r.ok && rj != null) {
                        api.store.saveTokens(rj)
                        val m = api.call("GET", "/me")
                        val mj = m.json
                        if (m.ok && mj != null) onAuthed(parseMe(mj)) else err = errText(m.error)
                    } else err = errText(r.error)
                    busy = false
                }
            }
        ) { Text(if (busy) "..." else if (register) "Ro'yxatdan o'tish" else "Kirish") }
        TextButton(onClick = { register = !register; err = null }) {
            Text(if (register) "Akkauntim bor - kirish" else "Akkaunt yo'q - ro'yxatdan o'tish")
        }
    }
}

@Composable
fun MainScreen(api: Api, me: Me, onRefresh: () -> Unit, onLogout: () -> Unit) {
    var tab by remember { mutableStateOf(0) }
    var open by remember { mutableStateOf<Conv?>(null) }
    val opened = open
    if (opened != null) {
        ChatScreen(api, me, opened, onBack = { open = null })
        return
    }
    Scaffold(
        containerColor = Bg,
        bottomBar = {
            NavigationBar {
                listOf("💬" to "Chatlar", "◈" to "ASTER", "🏷" to "Bozor", "⚙" to "Sozlama").forEachIndexed { i, (ic, label) ->
                    NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = { Text(ic) }, label = { Text(label) })
                }
            }
        }
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (tab) {
                0 -> ChatsTab(api) { open = it }
                1 -> WalletTab(api, me, onRefresh)
                2 -> MarketTab(api, me, onRefresh)
                else -> SettingsTab(me, onLogout)
            }
        }
    }
}

@Composable
fun SettingsTab(me: Me, onLogout: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Text("Sozlamalar", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(16.dp))
        Text("Username: @${me.username}")
        Text("Rol: ${me.role}")
        Text("Server: ${BuildConfig.API_URL}")
        Text("Versiya: ${BuildConfig.VERSION_NAME}")
        Spacer(Modifier.height(8.dp))
        Text("Secret chat kaliti shu qurilmada saqlanadi (1 akkaunt = 1 qurilma).", fontSize = 12.sp)
        Spacer(Modifier.height(24.dp))
        OutlinedButton(onClick = onLogout) { Text("Chiqish") }
    }
}
