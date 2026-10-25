"""
Delta Exchange Signal Scanner
-----------------------------
Har run par:
  1. Delta Exchange ki public API se saare perpetual futures ka data leta hai (API key nahi chahiye)
  2. Supabase me snapshot save karta hai
  3. Har coin ko 4 signals par check karta hai:
       - Funding rate extreme
       - Open Interest vs Price (6 ghante)
       - Liquidation zones (andaza, OI history se)
       - Token unlock (unlocks.csv se)
  4. Score >= MIN_SCORE ho to Telegram par alert bhejta hai

Chalane ka tarika:
  python scanner.py          -> scan + alerts
  python scanner.py summary  -> roz ki summary
  python scanner.py test     -> Telegram test message

Ye tool sirf data aur alert deta hai. Trade ka faisla aapka hai.
"""

import csv
import html
import math
import os
import statistics
import sys
import datetime as dt

import requests

# ----------------------------------------------------------------------
# Settings (GitHub Secrets / Variables se badal sakte hain)
# ----------------------------------------------------------------------
DELTA_URL = os.getenv(
    "DELTA_URL",
    "https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures",
)
DELTA_TRADE_URL = "https://www.delta.exchange/app/futures/trade/{u}/{s}"

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
TG_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.getenv("TELEGRAM_CHAT_ID", "")


def _f(name, default):
    v = os.getenv(name)
    return float(v) if v not in (None, "") else default


MIN_VOLUME_USD = _f("MIN_VOLUME_USD", 50_000)   # isse kam 24h volume wale coin skip
MIN_SCORE = int(_f("MIN_SCORE", 2))             # kitne signal milne par alert
FUNDING_ABS = _f("FUNDING_ABS", 0.03)           # % me, isse zyada = extreme
FUNDING_Z = _f("FUNDING_Z", 2.5)                # coin ke apne history se kitna door
PRICE_MOVE = _f("PRICE_MOVE", 3.0)              # 6h price change % threshold
OI_MOVE = _f("OI_MOVE", 8.0)                    # 6h OI change % threshold
LIQ_NEAR = _f("LIQ_NEAR", 3.0)                  # price zone se kitne % door ho to signal
LIQ_MIN_SHARE = _f("LIQ_MIN_SHARE", 0.20)       # us side ke naye OI ka kam se kam hissa zone me
UNLOCK_DAYS = _f("UNLOCK_DAYS", 7)              # agle kitne din ke unlock dekhne hain
COOLDOWN_H = _f("COOLDOWN_H", 4)                # ek coin ka alert dobara kitne ghante baad
HISTORY_DAYS = _f("HISTORY_DAYS", 3)            # signals ke liye kitni history padhni hai
RETENTION_DAYS = _f("RETENTION_DAYS", 14)       # Supabase me kitne din ka data rakhna hai
LEVERAGES = [10, 20, 25, 50]                    # liquidation andaze ke liye aam leverage
EXCLUDE = {s.strip().upper() for s in os.getenv("EXCLUDE_SYMBOLS", "").split(",") if s.strip()}

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
UNLOCKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unlocks.csv")


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def num(x, default=0.0):
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def pct(a, b):
    """a se b tak % badlav"""
    return (b / a - 1) * 100 if a else 0.0


def fmt_price(p):
    if p == 0:
        return "0"
    if p >= 100:
        return f"{p:,.2f}"
    if p >= 1:
        return f"{p:.4f}"
    digits = max(4, -int(math.floor(math.log10(abs(p)))) + 3)
    return f"{p:.{digits}f}"


def fmt_usd(v):
    a = abs(v)
    s = "-" if v < 0 else ""
    if a >= 1e9:
        return f"{s}${a/1e9:.2f}B"
    if a >= 1e6:
        return f"{s}${a/1e6:.2f}M"
    if a >= 1e3:
        return f"{s}${a/1e3:.1f}K"
    return f"{s}${a:.0f}"


def parse_ts(s):
    return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))


# ----------------------------------------------------------------------
# Delta Exchange (public API, key nahi chahiye)
# ----------------------------------------------------------------------
def fetch_tickers():
    r = requests.get(DELTA_URL, timeout=30, headers={"User-Agent": "delta-signal-scanner"})
    r.raise_for_status()
    out = []
    for t in r.json().get("result", []):
        if t.get("contract_type") != "perpetual_futures":
            continue
        sym = t.get("symbol", "")
        if sym.upper() in EXCLUDE:
            continue
        vol = num(t.get("turnover_usd"))
        if vol < MIN_VOLUME_USD:
            continue
        out.append({
            "symbol": sym,
            "underlying": t.get("underlying_asset_symbol") or sym.replace("USD", ""),
            "mark_price": num(t.get("mark_price")),
            "funding_rate": num(t.get("funding_rate")),     # % me (0.01 = 0.01%)
            "oi_usd": num(t.get("oi_value_usd")),
            "oi_change_6h_usd": num(t.get("oi_change_usd_6h")),
            "volume_usd": vol,
            "change_24h": num(t.get("mark_change_24h") or t.get("ltp_change_24h")),
        })
    return out


# ----------------------------------------------------------------------
# Supabase (REST API)
# ----------------------------------------------------------------------
class SupabaseStore:
    def __init__(self, url, key):
        if not url or not key:
            raise SystemExit("SUPABASE_URL aur SUPABASE_SERVICE_KEY set karo (GitHub Secrets).")
        self.base = f"{url}/rest/v1"
        self.h = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def _req(self, method, path, **kw):
        headers = {**self.h, **kw.pop("headers", {})}
        r = requests.request(method, f"{self.base}/{path}", headers=headers, timeout=60, **kw)
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {method} {path}: {r.status_code} {r.text[:300]}")
        return r

    def save_snapshots(self, ts, rows):
        data = [{
            "ts": ts.isoformat(),
            "symbol": x["symbol"],
            "mark_price": x["mark_price"],
            "funding_rate": x["funding_rate"],
            "oi_usd": x["oi_usd"],
            "oi_change_6h_usd": x["oi_change_6h_usd"],
            "volume_usd": x["volume_usd"],
            "change_24h": x["change_24h"],
        } for x in rows]
        for i in range(0, len(data), 500):
            self._req("POST", "delta_snapshots", json=data[i:i + 500], headers={"Prefer": "return=minimal"})

    def history(self, since):
        rows, offset, page = [], 0, 1000
        while True:
            r = self._req("GET", "delta_snapshots", params={
                "select": "symbol,ts,mark_price,funding_rate,oi_usd",
                "ts": f"gte.{since.isoformat()}",
                "order": "ts.asc,id.asc",
                "limit": page,
                "offset": offset,
            })
            batch = r.json()
            rows.extend(batch)
            if len(batch) < page:
                break
            offset += page
        by_sym = {}
        for x in rows:
            by_sym.setdefault(x["symbol"], []).append({
                "ts": parse_ts(x["ts"]),
                "mark_price": num(x["mark_price"]),
                "funding_rate": num(x["funding_rate"]),
                "oi_usd": num(x["oi_usd"]),
            })
        return by_sym

    def get_alerts(self):
        r = self._req("GET", "delta_alerts", params={"select": "symbol,last_ts,last_score"})
        return {x["symbol"]: (parse_ts(x["last_ts"]), int(x["last_score"])) for x in r.json()}

    def save_alerts(self, items):
        if not items:
            return
        data = [{"symbol": s, "last_ts": t.isoformat(), "last_score": sc} for s, t, sc in items]
        self._req("POST", "delta_alerts", params={"on_conflict": "symbol"}, json=data,
                  headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def cleanup(self, before):
        self._req("DELETE", "delta_snapshots", params={"ts": f"lt.{before.isoformat()}"},
                  headers={"Prefer": "return=minimal"})


# ----------------------------------------------------------------------
# Unlock list (unlocks.csv: symbol,date,pct_supply,note)
# ----------------------------------------------------------------------
def load_unlocks(path=UNLOCKS_FILE):
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                sym = row["symbol"].strip().upper()
                day = dt.date.fromisoformat(row["date"].strip())
            except (KeyError, ValueError, AttributeError):
                continue
            out.setdefault(sym, []).append({
                "date": day,
                "pct": num(row.get("pct_supply")),
                "note": (row.get("note") or "").strip(),
            })
    return out


# ----------------------------------------------------------------------
# Signals - har function (hit, text, bias) deta hai
# bias: -1 = neeche ka risk, +1 = upar ka risk, 0 = neutral
# ----------------------------------------------------------------------
def sig_funding(cur, hist):
    f = cur["funding_rate"]
    vals = [h["funding_rate"] for h in hist]
    z = None
    if len(vals) >= 30:
        sd = statistics.pstdev(vals)
        if sd > 0:
            z = (f - statistics.mean(vals)) / sd
    hit = abs(f) >= FUNDING_ABS or (z is not None and abs(z) >= FUNDING_Z and abs(f) >= FUNDING_ABS / 3)
    if not hit:
        return False, "", 0
    ztxt = f", normal se {abs(z):.1f}σ door" if z is not None else ""
    if f > 0:
        return True, f"Funding <b>+{f:.4f}%</b>{ztxt} → zyada log LONG, neeche jhatka (long squeeze) ho sakta hai", -1
    return True, f"Funding <b>{f:.4f}%</b>{ztxt} → zyada log SHORT, upar short squeeze ho sakta hai", +1


def _point_near(hist, target, tol_min=45):
    best = None
    for h in hist:
        d = abs((h["ts"] - target).total_seconds()) / 60
        if d <= tol_min and (best is None or d < best[0]):
            best = (d, h)
    return best[1] if best else None


def sig_oi_price(cur, hist, now):
    old = _point_near(hist, now - dt.timedelta(hours=6))
    if not old or not old["oi_usd"] or not old["mark_price"]:
        return False, "", 0, None
    p = pct(old["mark_price"], cur["mark_price"])
    o = pct(old["oi_usd"], cur["oi_usd"])
    info = (p, o)
    base = f"6h: Price {p:+.1f}%, OI {o:+.1f}%"
    if p >= PRICE_MOVE and o <= -OI_MOVE:
        return True, f"{base} → rally shorts ke band hone se aayi hai, naye buyers kam (kamzor rally)", -1, info
    if p >= PRICE_MOVE and o >= OI_MOVE:
        return True, f"{base} → naya paisa aa raha hai (longs badh rahe)", +1, info
    if p <= -PRICE_MOVE and o >= OI_MOVE:
        return True, f"{base} → naye shorts khul rahe hain; funding negative hua to squeeze ka risk", -1, info
    if p <= -PRICE_MOVE and o <= -OI_MOVE:
        return True, f"{base} → longs band/liquidate ho rahe hain, selling thak sakti hai", +1, info
    return False, "", 0, info


def liquidation_zones(cur, hist):
    """
    Andaza: jab bhi OI badha, us price par naye positions khule maan lo.
    Har leverage ke liye long liq = p*(1-0.9/L), short liq = p*(1+0.9/L).
    Zones ko 0.5% bins me jodkar sabse bhari zone (upar aur neeche) nikaalte hain.
    """
    price = cur["mark_price"]
    if price <= 0 or len(hist) < 8:
        return None
    pts = hist + [{"mark_price": price, "oi_usd": cur["oi_usd"]}]
    bins, total_new = {}, 0.0
    for a, b in zip(pts, pts[1:]):
        d = b["oi_usd"] - a["oi_usd"]
        if d <= 0:
            continue
        p = (a["mark_price"] + b["mark_price"]) / 2
        if p <= 0:
            continue
        total_new += d
        w = d / (len(LEVERAGES) * 2)
        for L in LEVERAGES:
            for side, z in (("long", p * (1 - 0.9 / L)), ("short", p * (1 + 0.9 / L))):
                k = round(math.log(z / price) / math.log(1.005))
                key = (side, k)
                bins[key] = bins.get(key, 0) + w
    if total_new <= 0:
        return None
    res = {}
    for side in ("long", "short"):
        cands = [(w, k) for (s, k), w in bins.items() if s == side]
        # long liq price ke neeche, short liq price ke upar honi chahiye
        cands = [(w, k) for w, k in cands if (k < 0 if side == "long" else k > 0)]
        if not cands:
            continue
        w, k = max(cands)
        lvl = price * (1.005 ** k)
        res[side] = {"price": lvl, "dist": pct(price, lvl), "usd": w, "share": w / (total_new / 2)}
    res["new_oi"] = total_new
    return res


def sig_liq(cur, hist):
    z = liquidation_zones(cur, hist)
    if not z:
        return False, "", 0, None
    best = None
    for side in ("long", "short"):
        s = z.get(side)
        if s and abs(s["dist"]) <= LIQ_NEAR and s["share"] >= LIQ_MIN_SHARE:
            if best is None or abs(s["dist"]) < abs(best[1]["dist"]):
                best = (side, s)
    if not best:
        return False, "", 0, z
    side, s = best
    if side == "long":
        return True, (f"Long liquidation zone ~<b>${fmt_price(s['price'])}</b> ({s['dist']:+.1f}%), "
                      f"~{fmt_usd(s['usd'])} positions → price neeche shikaar karne ja sakta hai (andaza)"), -1, z
    return True, (f"Short liquidation zone ~<b>${fmt_price(s['price'])}</b> ({s['dist']:+.1f}%), "
                  f"~{fmt_usd(s['usd'])} positions → price upar shikaar karne ja sakta hai (andaza)"), +1, z


def sig_unlock(cur, unlocks, today):
    items = unlocks.get(cur["underlying"].upper()) or unlocks.get(cur["symbol"].upper()) or []
    soon = [u for u in items if 0 <= (u["date"] - today).days <= UNLOCK_DAYS]
    if not soon:
        return False, "", 0
    u = min(soon, key=lambda x: x["date"])
    days = (u["date"] - today).days
    when = "aaj" if days == 0 else f"{days} din baad"
    size = f" {u['pct']:.2f}% supply" if u["pct"] else ""
    note = f" ({html.escape(u['note'])})" if u["note"] else ""
    return True, f"Token unlock {when} ({u['date']:%d %b}){size}{note} → selling pressure aa sakta hai", -1


def analyse(cur, hist, unlocks, now):
    sigs = []
    hit, txt, b = sig_funding(cur, hist)
    if hit:
        sigs.append(("Funding", txt, b))
    hit, txt, b, _ = sig_oi_price(cur, hist, now)
    if hit:
        sigs.append(("OI/Price", txt, b))
    hit, txt, b, _ = sig_liq(cur, hist)
    if hit:
        sigs.append(("Liquidation", txt, b))
    hit, txt, b = sig_unlock(cur, unlocks, now.astimezone(IST).date())
    if hit:
        sigs.append(("Unlock", txt, b))
    return sigs


# ----------------------------------------------------------------------
# Telegram
# ----------------------------------------------------------------------
def send_telegram(text):
    if not TG_TOKEN or not TG_CHAT:
        print("[telegram skip]\n" + text)
        return
    chunks, buf = [], ""
    for block in text.split("\n\n"):
        if len(buf) + len(block) + 2 > 3800:
            chunks.append(buf)
            buf = ""
        buf += ("\n\n" if buf else "") + block
    if buf:
        chunks.append(buf)
    for c in chunks:
        r = requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", json={
            "chat_id": TG_CHAT, "text": c, "parse_mode": "HTML", "disable_web_page_preview": True,
        }, timeout=30)
        if r.status_code != 200:
            print("Telegram error:", r.status_code, r.text[:300])


def alert_block(cur, sigs):
    bias = sum(b for _, _, b in sigs)
    head = "🔻 Neeche ka risk" if bias < 0 else ("🔺 Upar ka risk" if bias > 0 else "⚖️ Mixed")
    link = DELTA_TRADE_URL.format(u=cur["underlying"], s=cur["symbol"])
    lines = [
        f"⚠️ <b><a href=\"{link}\">{html.escape(cur['symbol'])}</a></b> — Score {len(sigs)}/4 · {head}",
        f"Price ${fmt_price(cur['mark_price'])} ({cur['change_24h']:+.1f}% 24h) · "
        f"OI {fmt_usd(cur['oi_usd'])} · Vol {fmt_usd(cur['volume_usd'])}",
    ]
    lines += [f"• <i>{name}:</i> {txt}" for name, txt, _ in sigs]
    return "\n".join(lines)


# ----------------------------------------------------------------------
# Modes
# ----------------------------------------------------------------------
def run_scan(store):
    now = now_utc()
    tickers = fetch_tickers()
    print(f"{len(tickers)} coins (volume >= {fmt_usd(MIN_VOLUME_USD)})")
    hist = store.history(now - dt.timedelta(days=HISTORY_DAYS))
    store.save_snapshots(now, tickers)
    unlocks = load_unlocks()
    last = store.get_alerts()

    blocks, sent = [], []
    for cur in tickers:
        sigs = analyse(cur, hist.get(cur["symbol"], []), unlocks, now)
        score = len(sigs)
        if score < MIN_SCORE:
            continue
        prev = last.get(cur["symbol"])
        if prev:
            hours = (now - prev[0]).total_seconds() / 3600
            if hours < COOLDOWN_H and score <= prev[1]:
                continue
        blocks.append((score, cur["volume_usd"], alert_block(cur, sigs)))
        sent.append((cur["symbol"], now, score))

    if blocks:
        blocks.sort(key=lambda x: (-x[0], -x[1]))
        t = now.astimezone(IST).strftime("%d %b %H:%M IST")
        send_telegram(f"📡 <b>Delta Signals</b> · {t}\n\n" + "\n\n".join(b for _, _, b in blocks)
                      + "\n\n<i>Sirf data hai, trade ka faisla aapka. Stop-loss zaroor lagayein.</i>")
        store.save_alerts(sent)
    print(f"alerts: {len(blocks)}")

    if now.minute < 15 and now.hour == 0:
        store.cleanup(now - dt.timedelta(days=RETENTION_DAYS))


def run_summary(store):
    now = now_utc()
    tickers = fetch_tickers()
    hist = store.history(now - dt.timedelta(days=HISTORY_DAYS))
    unlocks = load_unlocks()
    today = now.astimezone(IST).date()

    def row(x, extra):
        return f"{html.escape(x['symbol'])} {extra}"

    by_f = sorted(tickers, key=lambda x: x["funding_rate"])
    pos = [row(x, f"+{x['funding_rate']:.4f}%") for x in reversed(by_f[-5:]) if x["funding_rate"] > 0]
    neg = [row(x, f"{x['funding_rate']:.4f}%") for x in by_f[:5] if x["funding_rate"] < 0]

    oi_moves = []
    for x in tickers:
        _, _, _, info = sig_oi_price(x, hist.get(x["symbol"], []), now)
        if info:
            oi_moves.append((info[1], info[0], x))
    oi_moves.sort(key=lambda t: -abs(t[0]))
    oi_lines = [row(x, f"OI {o:+.1f}% · Price {p:+.1f}%") for o, p, x in oi_moves[:5]]

    syms = {x["underlying"].upper() for x in tickers} | {x["symbol"].upper() for x in tickers}
    up = []
    for s, items in unlocks.items():
        for u in items:
            d = (u["date"] - today).days
            if 0 <= d <= UNLOCK_DAYS and s in syms:
                up.append((u["date"], s, u))
    up.sort()
    unlock_lines = [f"{s} — {d:%d %b}" + (f" · {u['pct']:.2f}% supply" if u["pct"] else "") for d, s, u in up]

    t = now.astimezone(IST).strftime("%d %b %Y")
    parts = [f"🗞 <b>Daily Summary</b> · {t}"]
    parts.append("<b>Sabse zyada positive funding (longs bhaari):</b>\n" + ("\n".join(pos) or "—"))
    parts.append("<b>Sabse zyada negative funding (shorts bhaari):</b>\n" + ("\n".join(neg) or "—"))
    parts.append("<b>6h me sabse bada OI badlav:</b>\n" + ("\n".join(oi_lines) or "— (abhi history kam hai)"))
    parts.append(f"<b>Agle {int(UNLOCK_DAYS)} din ke unlocks:</b>\n" + ("\n".join(unlock_lines) or "— (unlocks.csv update karein)"))
    send_telegram("\n\n".join(parts))
    store.cleanup(now - dt.timedelta(days=RETENTION_DAYS))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "scan"
    if mode == "test":
        send_telegram("✅ Delta scanner connected! Alerts yahan aayenge.")
        return
    store = SupabaseStore(SUPABASE_URL, SUPABASE_KEY)
    if mode == "summary":
        run_summary(store)
    else:
        run_scan(store)


if __name__ == "__main__":
    main()
