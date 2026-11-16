# MIVO — SECURITY_REPORT (v0.1.0-test)

100% buzilmas tizim yo'q. Bu hisobot faqat **haqiqatan bajarilgan** narsani PASS deb belgilaydi.
Testlar: `cd backend && npm test` (Node 22, 10 test, oxirgi ishga tushirish: 10/10 PASS, lokal, xotiradagi baza).
Qamrov: **server API darajasi**. Telefon, haqiqiy tarmoq va haqiqiy server bilan sinov o'tkazilmagan.

## Majburiy 10 ta test
| # | Tekshiruv | Natija | Izoh |
|---|---|---|---|
| 1 | Boshqa foydalanuvchi chatiga ruxsatsiz kirish | **PASS** | Begona o'qish/yozish/javob → 404 (T1) |
| 2 | Boshqa foydalanuvchi ASTER balansini o'zgartirish | **PASS** | Manfiy/kasr/matn summa, soxta `from_id`/`balance`, mass-assignment, double-spend poygasi (T2) |
| 3 | Oddiy akkauntdan admin huquqi | **PASS** | Barcha `/admin/*` → 403; admin ASTER bera olmaydi, founder'ni ban qila olmaydi; founder faqat serverdagi CLI orqali (T3) |
| 4 | Username'ni ikki marta sotish | **PASS** | Parallel 2 xaridor → 200 + 409; ASTER yig'indisi saqlanadi (T4) |
| 5 | Token o'g'irlanishi / qayta ishlatilishi | **PASS (server)** · client **NOT TESTED** | Refresh rotation, eski refresh qayta ishlatilsa sessiya bekor, logout, muddat (T5). Keystore xotirasi telefonda sinalmagan |
| 6 | OTP va login brute-force | **PASS (login)** · OTP **NOT IMPLEMENTED** | 5 xato → 15 daq blok (parallel urinishda ham), IP limiti, parol siyosati (T6). OTP/2FA yo'q |
| 7 | API ruxsat tekshiruvlari | **PASS** | 21 himoyalangan route tokensiz/yaroqsiz tokenda 401 (T7) |
| 8 | Secret Chat'da server matnni o'qiy olmasligi | **PARTIAL** | Server API ochiq matnni rad etadi, faqat shifrmatn saqlaydi, rozilik/rad etish ishlaydi (T8) · Android shifrlash **NOT TESTED** (APK build qilinmagan) |
| 9 | Internet/server xatosida xabar yo'qolmasligi | **PARTIAL** | Server idempotent (bir xil `client_msg_id` ikki marta saqlanmaydi, T9). Ilova qayta yuborishda bir xil ID ishlatadi · offline navbat (outbox) **YO'Q**, telefonda **NOT TESTED** |
| 10 | APK o'zgartirilsa integrity tekshiruvi | **NOT IMPLEMENTED / NOT TESTED** | Play Integrity 2-bosqichda, backend tasdig'i bilan |

## Qo'shimcha server tekshiruvlari (T7, T10)
SQL injection urinishlari rad etildi / parametrli so'rovlar; 64 KB dan katta tana → 413; noto'g'ri JSON → 400; `application/json` bo'lmasa → 415; xavfsizlik sarlavhalari; parollar scrypt bilan, tokenlar bazada faqat SHA-256 hash.

## Ma'lum zaifliklar va cheklovlar (halol ro'yxat)
- **Secret Chat v0.1:** statik qurilma kalitlari → *forward secrecy yo'q*; yuboruvchi autentifikatsiyasi yo'q; kalit o'zgarishi haqida ogohlantirish yo'q; 1 akkaunt = 1 qurilma. Kod yozilgan, sinalmagan va audit qilinmagan. **Xavfsiz deb reklama qilmang.**
- Bazada oddiy chat matni ochiq saqlanadi; bazani shifrlash/backup/restore **yo'q** (hosting diskini shifrlash tavsiya).
- Certificate pinning **yo'q**; test APK **debug** build (R8/obfuscation faqat release'da).
- Root/emulator signali, Play Integrity, APK integrity **yo'q**.
- OTP/2FA **yo'q**; parolni tiklash **yo'q**.
- Rate limit xotirada (bitta server jarayoni uchun); ko'p nusxada Redis kerak.
- SAST, DAST, dependency scanning, MASVS/ASVS to'liq baholash **bajarilmagan**.
- Push bildirishnoma yo'q (shu sababli matn oshkor bo'lmaydi). Smart Code Protection **yo'q**.
- CSRF: cookie ishlatilmaydi (Bearer token) → mos kelmaydi. SSRF: server tashqi so'rov yubormaydi. XSS: faqat JSON API, ilovada WebView yo'q.
