# NEXT_STEPS

## Darhol (sizning tasdig'ingizgacha)
1. Backend'ni hostingga joylash (docs/INSTALL_UZ.md), `MIVO_API_URL` ni GitHub variable qilib berish.
2. GitHub Actions'da APK build — xato chiqsa logni yuboring, tuzataman.
3. APK'ni telefonga o'rnatib sinash: ro'yxatdan o'tish, ikki akkaunt, chat, Secret Chat, ASTER, bozor.
4. Natijalarni yuboring → FAIL/NOT TESTED larni yopamiz.

## 1-bosqich qoldiqlari (tasdiqdan oldin yoki keyin)
- OTP/2FA, parolni tiklash, akkauntni o'chirish
- Certificate pinning (haqiqiy domen + zaxira pin), root/emulator signali
- Offline xabar navbati (outbox), WebSocket
- Secret Chat: forward secrecy (Double Ratchet / Signal protokoli kutubxonasi), kalit tekshiruvi, audit
- PostgreSQL + shifrlangan backup/restore
- Admin paneli, MIVO logotipi, NEW BOT, Liquid Glass UI, Web
- SAST/DAST/dependency scan

## 2-bosqich (faqat tasdiqdan keyin): Google Play — AAB, signing, Billing, Play Integrity, Privacy/Data Safety
## 3-bosqich (faqat tasdiqdan keyin): iOS — Swift/SwiftUI, Keychain, APNs, IAP
