package app.mivo

import android.app.Activity
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

private val ErrColor = Color(0xFFFF6B6B)

@Composable
private fun ErrLine(t: String?) {
    if (t != null) Text(t, color = ErrColor, fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp))
}

// ---------------------------------------------------------------- Chats list
@Composable
fun ChatsTab(api: Api, onOpen: (Conv) -> Unit) {
    var items by remember { mutableStateOf<List<Conv>>(emptyList()) }
    var err by remember { mutableStateOf<String?>(null) }
    var dialog by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        while (true) {
            val r = api.call("GET", "/conversations")
            val j = r.json
            if (r.ok && j != null) {
                val a = j.getJSONArray("items")
                items = (0 until a.length()).map { parseConv(a.getJSONObject(it)) }
                err = null
            } else err = errText(r.error)
            delay(5000)
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Chatlar", fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Button(onClick = { dialog = true }) { Text("+ Yangi") }
        }
        ErrLine(err)
        if (items.isEmpty() && err == null) Text("Hali chat yo'q. «+ Yangi» orqali username bo'yicha chat boshlang.", modifier = Modifier.padding(top = 16.dp))
        LazyColumn(Modifier.fillMaxSize()) {
            items(items, key = { it.id }) { c ->
                Column(Modifier.fillMaxWidth().clickable { onOpen(c) }.padding(vertical = 12.dp)) {
                    Text("${if (c.kind == "secret") "🔒 " else ""}@${c.peer}", fontSize = 17.sp, fontWeight = FontWeight.Medium)
                    val sub = when {
                        c.status == "pending" && c.requestedByMe -> "Kutilmoqda: ikkinchi tomon roziligi"
                        c.status == "pending" -> "Secret chat so'rovi - javob kutilmoqda"
                        c.status == "rejected" -> "Rad etilgan"
                        c.kind == "secret" -> "Secret chat"
                        else -> "Oddiy chat"
                    }
                    Text(sub, fontSize = 12.sp, color = Color.Gray)
                }
                HorizontalDivider(color = Color(0xFF1A2236))
            }
        }
    }

    if (dialog) NewChatDialog(api, onDismiss = { dialog = false }) { dialog = false; onOpen(it) }
}

@Composable
private fun NewChatDialog(api: Api, onDismiss: () -> Unit, onCreated: (Conv) -> Unit) {
    var u by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Yangi chat") },
        text = {
            Column {
                OutlinedTextField(u, { u = it.lowercase().trim().removePrefix("@") }, label = { Text("Username") }, singleLine = true)
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                    Switch(checked = secret, onCheckedChange = { secret = it })
                    Spacer(Modifier.width(8.dp))
                    Text("Secret chat (E2EE, ikkinchi tomon rozi bo'lishi kerak)", fontSize = 13.sp)
                }
                ErrLine(err)
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && u.length >= 4, onClick = {
                scope.launch {
                    busy = true; err = null
                    val r = api.call("POST", "/conversations", JSONObject().put("username", u).put("kind", if (secret) "secret" else "normal"))
                    val j = r.json
                    if (r.ok && j != null) onCreated(Conv(j.getLong("id"), j.getString("kind"), j.getString("status"), j.getString("peer"), j.getString("status") == "pending"))
                    else err = errText(r.error)
                    busy = false
                }
            }) { Text("Boshlash") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Bekor") } }
    )
}

// ---------------------------------------------------------------- Chat
class Msg(val id: Long, val mine: Boolean, val text: String)

@Composable
fun ChatScreen(api: Api, me: Me, start: Conv, onBack: () -> Unit) {
    var conv by remember { mutableStateOf(start) }
    val msgs: SnapshotStateList<Msg> = remember { mutableStateListOf() }
    var input by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<String, String>?>(null) } // text -> client id (kept across retries)
    var last by remember { mutableStateOf(0L) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val act = LocalContext.current as? Activity
    val listState = rememberLazyListState()

    BackHandler(onBack = onBack)

    // Secret chat screens block screenshots / recents thumbnails.
    DisposableEffect(conv.kind) {
        if (conv.kind == "secret") act?.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { act?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }

    LaunchedEffect(start.id) {
        while (true) {
            val r = api.call("GET", "/conversations/${start.id}/messages?after=$last")
            val j = r.json
            if (r.ok && j != null) {
                conv = parseConv(j.getJSONObject("conversation"))
                val a = j.getJSONArray("items")
                for (i in 0 until a.length()) {
                    val o = a.getJSONObject(i)
                    val text = if (conv.kind == "secret") E2EE.decrypt(api.store, me.id, o.getString("cipher")) else o.getString("body")
                    msgs.add(Msg(o.getLong("id"), o.getBoolean("mine"), text))
                    last = o.getLong("id")
                }
                if (a.length() > 0) listState.animateScrollToItem(msgs.size - 1)
            }
            delay(3000)
        }
    }

    fun respond(accept: Boolean) {
        scope.launch {
            val r = api.call("POST", "/conversations/${conv.id}/respond", JSONObject().put("accept", accept))
            if (r.ok) conv = conv.copy(status = r.json?.optString("status") ?: conv.status) else err = errText(r.error)
        }
    }

    fun send() {
        val text = input.trim()
        if (text.isEmpty() || sending) return
        val id = pending?.takeIf { it.first == text }?.second ?: UUID.randomUUID().toString()
        pending = text to id
        sending = true; err = null
        scope.launch {
            val body = JSONObject().put("client_msg_id", id)
            var failure: String? = null
            if (conv.kind == "secret") {
                val pk = api.call("GET", "/users/${conv.peer}/key")
                val pj = pk.json
                if (!pk.ok || pj == null) failure = errText(pk.error)
                else try {
                    body.put("cipher_recipient", E2EE.encrypt(pj.getString("pubkey"), text))
                    body.put("cipher_sender", E2EE.encrypt(E2EE.ownPublic(api.store, me.id), text))
                } catch (e: Exception) {
                    failure = "Shifrlashda xatolik"
                }
            } else body.put("body", text)
            if (failure == null) {
                val r = api.call("POST", "/conversations/${conv.id}/messages", body)
                if (!r.ok) failure = errText(r.error)
            }
            if (failure == null) { input = ""; pending = null } else err = "Yuborilmadi (qayta bosing, xabar takrorlanmaydi): $failure"
            sending = false
        }
    }

    Column(Modifier.fillMaxSize().imePadding().padding(horizontal = 12.dp)) {
        Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("←") }
            Text("${if (conv.kind == "secret") "🔒 " else ""}@${conv.peer}", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        when {
            conv.status == "pending" && !conv.requestedByMe -> Column {
                Text("@${conv.peer} siz bilan Secret chat ochmoqchi. Roziligingiz kerak.")
                Row { Button(onClick = { respond(true) }) { Text("Qabul") }; Spacer(Modifier.width(8.dp)); OutlinedButton(onClick = { respond(false) }) { Text("Rad etish") } }
            }
            conv.status == "pending" -> Text("Ikkinchi tomon rozi bo'lishini kutyapmiz...", color = Color.Gray)
            conv.status == "rejected" -> Text("Secret chat rad etilgan. Xabarlar oddiy chatga yuborilmaydi.", color = ErrColor)
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
            items(msgs, key = { it.id }) { m ->
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = if (m.mine) Arrangement.End else Arrangement.Start) {
                    Text(
                        m.text, modifier = Modifier.widthIn(max = 280.dp)
                            .background(if (m.mine) Color(0xFF14447A) else Color(0xFF151C2E), RoundedCornerShape(14.dp)).padding(10.dp)
                    )
                }
            }
        }
        ErrLine(err)
        if (conv.status == "active") {
            Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(input, { input = it.take(4000) }, modifier = Modifier.weight(1f), placeholder = { Text("Xabar") }, maxLines = 4)
                Spacer(Modifier.width(8.dp))
                Button(onClick = { send() }, enabled = !sending && input.isNotBlank()) { Text("➤") }
            }
        }
    }
}

// ---------------------------------------------------------------- Wallet
@Composable
fun WalletTab(api: Api, me: Me, onRefresh: () -> Unit) {
    class Tx(val dir: String, val peer: String, val amount: Long, val kind: String)
    var history by remember { mutableStateOf<List<Tx>>(emptyList()) }
    var to by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<String, String>?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun loadHistory() {
        val r = api.call("GET", "/wallet/history")
        val j = r.json
        if (r.ok && j != null) {
            val a = j.getJSONArray("items")
            history = (0 until a.length()).map { val o = a.getJSONObject(it); Tx(o.getString("dir"), o.getString("peer"), o.getLong("amount"), o.getString("kind")) }
        }
    }
    LaunchedEffect(Unit) { while (true) { loadHistory(); onRefresh(); delay(10000) } }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("ASTER hamyon", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text("${me.balance} ASTER", fontSize = 34.sp, color = Accent, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(to, { to = it.lowercase().trim().removePrefix("@") }, label = { Text("Kimga (username)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(
            amount, { amount = it.filter { c -> c.isDigit() }.take(10) }, label = { Text("Miqdor") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth()
        )
        ErrLine(err)
        info?.let { Text(it, color = Accent, fontSize = 13.sp) }
        Button(
            enabled = !busy && to.length >= 4 && amount.isNotEmpty(),
            onClick = {
                val amt = amount.toLongOrNull() ?: return@Button
                val key = "$to|$amt"
                val id = pending?.takeIf { it.first == key }?.second ?: UUID.randomUUID().toString()
                pending = key to id
                scope.launch {
                    busy = true; err = null; info = null
                    val r = api.call("POST", "/wallet/transfer", JSONObject().put("to_username", to).put("amount", amt).put("client_tx_id", id))
                    if (r.ok) { pending = null; info = "Yuborildi"; amount = ""; loadHistory(); onRefresh() } else err = errText(r.error)
                    busy = false
                }
            }
        ) { Text("Yuborish") }
        Spacer(Modifier.height(12.dp))
        Text("Tarix", fontWeight = FontWeight.Bold)
        LazyColumn {
            items(history.size) { i ->
                val t = history[i]
                Text("${if (t.dir == "out") "−" else "+"}${t.amount}  ${if (t.dir == "out") "→" else "←"} @${t.peer}  (${t.kind})", modifier = Modifier.padding(vertical = 4.dp))
            }
        }
    }
}

// ---------------------------------------------------------------- Marketplace
@Composable
fun MarketTab(api: Api, me: Me, onRefresh: () -> Unit) {
    class Listing(val id: Long, val username: String, val price: Long, val seller: String, val mine: Boolean)
    var items by remember { mutableStateOf<List<Listing>>(emptyList()) }
    var claim by remember { mutableStateOf("") }
    var sellName by remember { mutableStateOf<String?>(null) }
    var price by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        val r = api.call("GET", "/market")
        val j = r.json
        if (r.ok && j != null) {
            val a = j.getJSONArray("items")
            items = (0 until a.length()).map { val o = a.getJSONObject(it); Listing(o.getLong("id"), o.getString("username"), o.getLong("price"), o.getString("seller"), o.getBoolean("mine")) }
        } else err = errText(r.error)
    }
    LaunchedEffect(Unit) { while (true) { load(); delay(8000) } }

    LazyColumn(Modifier.fillMaxSize().padding(16.dp)) {
        item {
            Text("Username bozori", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("Balans: ${me.balance} ASTER", color = Accent)
            ErrLine(err)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(claim, { claim = it.lowercase().trim().removePrefix("@") }, label = { Text("Yangi username olish") }, singleLine = true, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Button(enabled = claim.length >= 4, onClick = {
                    scope.launch {
                        err = null
                        val r = api.call("POST", "/usernames/claim", JSONObject().put("username", claim))
                        if (r.ok) { claim = ""; onRefresh() } else err = errText(r.error)
                    }
                }) { Text("Olish") }
            }
            Spacer(Modifier.height(12.dp))
            Text("Mening usernamelarim", fontWeight = FontWeight.Bold)
        }
        items(me.names.size) { i ->
            val n = me.names[i]
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("@${n.name}${if (n.primary) "  (asosiy)" else ""}${if (n.listed) "  · sotuvda" else ""}", modifier = Modifier.weight(1f))
                if (!n.primary && !n.listed) TextButton(onClick = { sellName = n.name; price = "" }) { Text("Sotish") }
            }
        }
        item { Spacer(Modifier.height(12.dp)); Text("Sotuvdagilar", fontWeight = FontWeight.Bold) }
        items(items.size) { i ->
            val l = items[i]
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("@${l.username}", fontSize = 16.sp)
                    Text("${l.price} ASTER · sotuvchi @${l.seller}", fontSize = 12.sp, color = Color.Gray)
                }
                if (l.mine) TextButton(onClick = {
                    scope.launch { val r = api.call("POST", "/market/${l.id}/cancel", JSONObject()); if (r.ok) { load(); onRefresh() } else err = errText(r.error) }
                }) { Text("Bekor") }
                else Button(onClick = {
                    scope.launch { err = null; val r = api.call("POST", "/market/${l.id}/buy", JSONObject()); if (r.ok) { load(); onRefresh() } else { err = errText(r.error); load() } }
                }) { Text("Sotib olish") }
            }
        }
    }

    val sn = sellName
    if (sn != null) AlertDialog(
        onDismissRequest = { sellName = null },
        title = { Text("@$sn narxi") },
        text = { OutlinedTextField(price, { price = it.filter { c -> c.isDigit() }.take(10) }, label = { Text("ASTER") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)) },
        confirmButton = {
            TextButton(enabled = price.isNotEmpty(), onClick = {
                val p = price.toLongOrNull() ?: return@TextButton
                scope.launch {
                    val r = api.call("POST", "/market/list", JSONObject().put("username", sn).put("price", p))
                    if (r.ok) { sellName = null; load(); onRefresh() } else err = errText(r.error)
                }
            }) { Text("Sotuvga qo'yish") }
        },
        dismissButton = { TextButton(onClick = { sellName = null }) { Text("Bekor") } }
    )
}
