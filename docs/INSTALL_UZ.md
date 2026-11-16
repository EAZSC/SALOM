# O'rnatish yo'riqnomasi (faqat telefon bilan)

## 1. Backend'ni ishga tushirish
Backend Node.js 22 va **doimiy disk** talab qiladi (SQLite fayl). Doimiy diski yo'q bepul hostinglar (masalan Render free) bazani o'chirib yuboradi — ishlatmang.
Misol: **Fly.io** (Dockerfile tayyor, `backend/` papkasida):
1. `fly launch` (Dockerfile'ni topadi), `fly volume create data --size 1`, `fly.toml` ga `[mounts] source="data" destination="/data"` qo'shing, `fly deploy`.
2. Manzil `https://<nom>.fly.dev` bo'ladi (HTTPS majburiy).
3. Birinchi akkaunt ilovadan ro'yxatdan o'tgach, founder qilish: `fly ssh console -C "node /app/scripts/make-founder.js username"`. Tarmoq orqali founder yaratib bo'lmaydi.
4. ASTER berish: founder akkaunt bilan `POST /admin/grant` (hozircha admin UI yo'q).

## 2. Kodni GitHub'ga yuklash (Android, Termux)
```
pkg install git unzip
unzip mivo.zip -d mivo && cd mivo
git init && git add . && git commit -m "MIVO v0.1"
git branch -M main
git remote add origin https://github.com/<login>/mivo.git
git push -u origin main    # parol o'rniga Personal Access Token
```
GitHub'da: repo → Settings → Secrets and variables → Actions → **Variables** → `MIVO_API_URL` = server manzilingiz (oxirida `/`siz).

## 3. APK olish
Repo → Actions → «Build MIVO» → Run workflow. Tugagach, **Artifacts → mivo-debug-apk** ni yuklab oling.

## 4. Telefonga o'rnatish
APK'ni oching → «Noma'lum manbalardan o'rnatishga ruxsat» → O'rnatish. Bu debug-imzoli **test** APK; Play Store uchun emas.

## 5. Tekshirish ro'yxati
Ikki akkaunt (ikki qurilma yoki ikki marta ro'yxatdan o'tish emas — Secret Chat uchun har biri o'z telefonida) → oddiy chat → Secret Chat (so'rov/qabul/rad) → ASTER o'tkazma → username olish/sotish/sotib olish.
