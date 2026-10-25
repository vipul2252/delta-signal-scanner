# Delta Signal Scanner (Phase 1)

Har 15 minute Delta Exchange ke saare perpetual futures check karke Telegram par alert bhejta hai.
**Delta API key nahi chahiye** (sirf public data padhta hai, koi trade nahi lagata).

| Signal | Kya dekhta hai |
|---|---|
| Funding | Funding rate bahut zyada +/− ya coin ke apne normal se bahut door |
| OI / Price | 6 ghante me price aur Open Interest ka mel (kamzor rally, naya paisa, longs ka nikalna) |
| Liquidation | OI history se andaza: kahan longs/shorts ki liquidation jama hai, price uske paas hai to alert |
| Unlock | `unlocks.csv` me likhe unlock agle 7 din me hain to warning |

2 ya zyada signal ek saath mile → alert. Roz subah 8 baje (IST) summary.

---

## Setup (ek baar, ~15 minute)

### 1. Telegram bot
1. Telegram me **@BotFather** → `/newbot` → token copy karein.
2. Apne naye bot ko ek message bhejein (jaise `hi`).
3. Browser me kholein: `https://api.telegram.org/bot<TOKEN>/getUpdates` → `"chat":{"id": ...}` wala number = **CHAT_ID**.
   (Group me alerts chahiye to bot ko group me add karke wahan message bhejein; group ID `-100...` se shuru hoga.)

### 2. Supabase
1. Naya project banayein (ya purana use karein).
2. **SQL Editor** → `schema.sql` ka poora content paste → **Run**.
3. **Project Settings → API** se copy karein:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_KEY` (ye secret hai, kahin public mat karna)

### 3. GitHub
1. Naya repo banayein aur ye saari files upload karein (`.github/workflows/scanner.yml` folder ke saath).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**, ye 4 daalein:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. **Actions** tab → workflow enable karein → **Delta Signal Scanner → Run workflow** → mode `test` → Telegram par "✅ connected" aana chahiye.
4. Phir ek baar mode `scan` se chalayein. Uske baad ye har 15 minute khud chalega.

> **Public ya private repo?** Public repo me GitHub Actions free/unlimited hai (secrets phir bhi chhupe rehte hain).
> Private repo me sirf 2,000 minute/mahina free hain — 15 minute wala schedule ~2,900 minute khayega.
> Private rakhna hai to `scanner.yml` me `*/15` ko `*/30` kar dein.

---

## Pehle din kya umeed rakhein
- **Turant:** Funding extreme + Unlock signals.
- **~6 ghante baad:** OI/Price signal (6h purana data chahiye).
- **~8 ghante baad:** Funding ka "normal se door" (z-score) check.
- **~1 din baad:** Liquidation zones behtar banenge.

## Settings badalna (optional)
Repo → Settings → Secrets and variables → Actions → **Variables** tab:

| Variable | Default | Matlab |
|---|---|---|
| `MIN_VOLUME_USD` | 50000 | Isse kam 24h volume wale coin skip |
| `MIN_SCORE` | 2 | Kitne signal par alert |
| `FUNDING_ABS` | 0.03 | Funding % jisse upar "extreme" |
| `EXCLUDE_SYMBOLS` | — | Jaise `XAUTUSD,PAXGUSD,TSLAXUSD` (stocks/gold hatane ke liye) |

## Unlock list (`unlocks.csv`)
CryptoRank / Tokenomist se dates dekh kar line jodein:
```
symbol,date,pct_supply,note
JUP,2026-11-01,1.2,monthly unlock
```
`symbol` = coin ka naam (USD ke bina).

## Aage (Phase 2/3)
- Unlock data apne aap laana (CryptoRank API)
- Exchange inflow (Arkham/Dune paid API)

---
⚠️ Ye sirf data aur andaza hai, pakka signal nahi. Liquidation zones ek andaza hain (asli positions exchange nahi batata).
Trade ka faisla aapka — kam leverage aur stop-loss hamesha.
