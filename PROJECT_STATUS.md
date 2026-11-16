# MIVO — PROJECT_STATUS (1-bosqich: Android test APK)

Sana: 2026-11-16 · Versiya: 0.1.0-test

## Muhim ogohlantirish (halol holat)
- **APK bu yerda build qilinmadi.** Sandbox'da Android SDK va tarmoq yo'q. Kod yozildi, lekin Kotlin/Compose qismi **hali bir marta ham kompilyatsiya qilinmagan**. Birinchi GitHub Actions build'ida kompilyatsiya xatolari chiqishi mumkin — logni menga yuborsangiz tuzataman.
- **Backend ishga tushirilib sinaldi** (Node 22, 10 ta avtomatik test, hammasi PASS) — lekin faqat lokal, xotiradagi bazada. Haqiqiy serverga joylanmagan.
- Server hozircha **ishga tushmagan**: siz hosting tanlab joylashingiz kerak (INSTALL_UZ.md).

## Sizning rejadan farq
- Baza: **SQLite** (Node'ning ichki moduli, qo'shimcha kutubxonasiz → testlarni haqiqatan ishga tushira oldim). PostgreSQL'ga o'tish keyingi bosqichda.
- Realtime: **polling** (har 3 soniya). WebSocket keyin.

## Tuzilma
- `backend/` — Node.js 22 API (nol tashqi dependency), `test/security.test.js`
- `android/` — Kotlin + Jetpack Compose (WebView yo'q), Gradle
- `.github/workflows/build.yml` — backend testlar + debug APK build
- `docs/INSTALL_UZ.md` — o'rnatish yo'riqnomasi

## Ishlaydigan funksiyalar (backend: sinalgan · Android: yozilgan, sinalmagan)
- Ro'yxatdan o'tish / kirish / chiqish, parol siyosati, scrypt hash
- Access (15 daq) + refresh (30 kun) token, rotation va qayta ishlatishni aniqlash
- Oddiy 1:1 chat (idempotent yuborish)
- Secret Chat: ikki tomon roziligi, rad etilsa oddiy chatga tushmaydi, server faqat shifrlangan matn saqlaydi; Android'da Google Tink ECIES (P-256/AES-GCM)
- ASTER hamyon: faqat server hisoblaydi, atomik o'tkazma, tarix
- Username bozori: egalik (extra username olish), sotuvga qo'yish, atomik sotib olish
- Rollar: user / admin / founder; ban, ASTER berish (faqat founder), audit log
- Android: login/register, chatlar, chat ekrani, ASTER, bozor, sozlama; tokenlar Keystore-shifrlangan xotirada; Secret Chat ekranida FLAG_SECURE

## Hali bajarilmagan
Ko'rsating: `NEXT_STEPS.md`. Asosiylari: OTP/2FA, certificate pinning, Play Integrity (server tomonli), APK integrity, root/emulator signali, push (maxfiy matnsiz), forward secrecy, Smart Code Protection, bazani shifrlash/backup, admin UI, akkauntni o'chirish, SAST/DAST/dependency scan, MASVS/ASVS baholash, MIVO logotipi (hozir oddiy "M" vektor), NEW BOT, Liquid Glass UI, Web.

## Xavfsizlik testlari
`SECURITY_REPORT.md` ga qarang.
