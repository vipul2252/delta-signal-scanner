// Delta Exchange Signal Scanner — Supabase Edge Function
// pg_cron har 1 minute call karta hai. Har call par:
//   1. Delta public API se saare perpetual futures (API key nahi chahiye)
//   2. Har 5 minute ek snapshot Supabase me save
//   3. Signals: Funding extreme, OI vs Price (6h), Liquidation zones (andaza), Token unlock
//   4. Score >= MIN_SCORE -> Telegram alert (har coin par cooldown)
//   5. Roz ~8 AM IST summary
// Sirf data/alert. Trade ka faisla user ka.

import { SOXL, type Candle as SCandle, backtest as soxlBacktest, dailyTrendAt, entryAt, session, stochRsi } from "./soxl.ts";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG_CHAT = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

const envNum = (k: string, d: number) => {
  const v = Deno.env.get(k);
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

const CFG = {
  DELTA_URL: Deno.env.get("DELTA_URL") ??
    "https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures",
  MIN_VOLUME_USD: envNum("MIN_VOLUME_USD", 50_000),
  MIN_SCORE: envNum("MIN_SCORE", 2),
  FUNDING_ABS: envNum("FUNDING_ABS", 0.03),   // % (0.01 = 0.01%)
  FUNDING_Z: envNum("FUNDING_Z", 2.5),
  PRICE_MOVE: envNum("PRICE_MOVE", 3),        // 6h %
  OI_MOVE: envNum("OI_MOVE", 8),              // 6h %
  LIQ_NEAR: envNum("LIQ_NEAR", 3),            // %
  LIQ_MIN_SHARE: envNum("LIQ_MIN_SHARE", 0.2),
  UNLOCK_DAYS: envNum("UNLOCK_DAYS", 7),
  COOLDOWN_H: envNum("COOLDOWN_H", 4),
  SAVE_EVERY_MIN: envNum("SAVE_EVERY_MIN", 5),
  RETENTION_DAYS: envNum("RETENTION_DAYS", 7),
  SUMMARY_HOUR_IST: envNum("SUMMARY_HOUR_IST", 8),
  // Paper-trade tracker
  RR: envNum("RR", 3),                       // TP = RR x SL
  ATR_MULT: envNum("ATR_MULT", 1.5),         // SL = 1.5 x ATR(14, 1h)
  SL_MIN_PCT: envNum("SL_MIN_PCT", 0.5),
  SL_MAX_PCT: envNum("SL_MAX_PCT", 10),
  HOLD_H: envNum("HOLD_H", 72),              // itne ghante me SL/TP na lage to band
  FEE_PCT: envNum("FEE_PCT", 0.1),           // round-trip fees %
  WEEKLY_DOW_IST: envNum("WEEKLY_DOW_IST", 0),   // 0 = Sunday
  WEEKLY_HOUR_IST: envNum("WEEKLY_HOUR_IST", 20),
  // EMA strategy (purane funding/OI signals ki jagah)
  SIGNAL_MODE: Deno.env.get("SIGNAL_MODE") ?? "soxl",  // "soxl" (abhi), "ema" ya "legacy"
  EMA_LEN: envNum("EMA_LEN", 200),
  EMA_TF_H: envNum("EMA_TF_H", 4),            // 4 ghante ki candles
  EMA_HOLD_H: envNum("EMA_HOLD_H", 168),      // 7 din me SL/TP na lage to band
  EXCLUDE: new Set((Deno.env.get("EXCLUDE_SYMBOLS") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)),
};
const LEVERAGES = [10, 20, 25, 50];
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// ---------------------------------------------------------------- helpers
type Ticker = {
  symbol: string; underlying: string; mark_price: number; funding_rate: number;
  oi_usd: number; oi_change_6h_usd: number; volume_usd: number; change_24h: number;
};
type Stats = {
  symbol: string; f_mean: number | null; f_sd: number | null; f_n: number;
  p6: number | null; oi6: number | null; bins: [number, number][];
};
type Sig = { name: string; text: string; bias: number };

const num = (x: unknown, d = 0) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
};
const pct = (a: number, b: number) => (a ? (b / a - 1) * 100 : 0);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sign = (v: number, d = 1) => (v >= 0 ? "+" : "") + v.toFixed(d);

function fmtPrice(p: number) {
  if (p === 0) return "0";
  if (p >= 100) return p.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  const digits = Math.max(4, -Math.floor(Math.log10(Math.abs(p))) + 3);
  return p.toFixed(digits);
}
function fmtUsd(v: number) {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
}
const istDate = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS); // use getUTC* on result
const istStr = (d: Date) => {
  const x = istDate(d);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][x.getUTCMonth()];
  return `${String(x.getUTCDate()).padStart(2, "0")} ${mon} ${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")} IST`;
};
const istDay = (d: Date) => istDate(d).toISOString().slice(0, 10);

// ---------------------------------------------------------------- supabase
async function sb(path: string, init: RequestInit & { prefer?: string } = {}) {
  const headers: Record<string, string> = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers["Prefer"] = init.prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${init.method ?? "GET"} ${path.split("?")[0]}: ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

async function getState(key: string): Promise<Date | null> {
  const rows = await sb(`delta_alerts?select=last_ts&symbol=eq.${encodeURIComponent(key)}`);
  return rows?.length ? new Date(rows[0].last_ts) : null;
}
async function upsertAlerts(items: { symbol: string; last_ts: string; last_score: number }[]) {
  if (!items.length) return;
  await sb("delta_alerts?on_conflict=symbol", {
    method: "POST", body: JSON.stringify(items), prefer: "resolution=merge-duplicates,return=minimal",
  });
}

// ---------------------------------------------------------------- delta
// Saare perpetuals ka mark price (volume filter ke bina) — open paper trades ke liye
const ALL_PRICES = new Map<string, number>();

async function fetchTickers(): Promise<Ticker[]> {
  const r = await fetch(CFG.DELTA_URL, { headers: { "User-Agent": "delta-signal-scanner" } });
  if (!r.ok) throw new Error(`Delta API ${r.status}`);
  const j = await r.json();
  const out: Ticker[] = [];
  ALL_PRICES.clear();
  for (const t of j.result ?? []) {
    if (t.contract_type !== "perpetual_futures") continue;
    const sym = String(t.symbol ?? "");
    if (num(t.mark_price) > 0) ALL_PRICES.set(sym, num(t.mark_price));
    if (CFG.EXCLUDE.has(sym.toUpperCase())) continue;
    const vol = num(t.turnover_usd);
    if (vol < CFG.MIN_VOLUME_USD) continue;
    out.push({
      symbol: sym,
      underlying: t.underlying_asset_symbol || sym.replace(/USD$/, ""),
      mark_price: num(t.mark_price),
      funding_rate: num(t.funding_rate),
      oi_usd: num(t.oi_value_usd),
      oi_change_6h_usd: num(t.oi_change_usd_6h),
      volume_usd: vol,
      change_24h: num(t.mark_change_24h ?? t.ltp_change_24h),
    });
  }
  return out;
}

// ---------------------------------------------------------------- signals
function sigFunding(cur: Ticker, st?: Stats): Sig | null {
  const f = cur.funding_rate;
  let z: number | null = null;
  if (st && st.f_n >= 30 && st.f_sd && st.f_sd > 0 && st.f_mean !== null) z = (f - st.f_mean) / st.f_sd;
  const hit = Math.abs(f) >= CFG.FUNDING_ABS ||
    (z !== null && Math.abs(z) >= CFG.FUNDING_Z && Math.abs(f) >= CFG.FUNDING_ABS / 3);
  if (!hit) return null;
  const ztxt = z !== null ? `, normal se ${Math.abs(z).toFixed(1)}σ door` : "";
  if (f > 0) {
    return { name: "Funding", bias: -1,
      text: `Funding <b>+${f.toFixed(4)}%</b>${ztxt} → zyada log LONG, neeche jhatka (long squeeze) ho sakta hai` };
  }
  return { name: "Funding", bias: +1,
    text: `Funding <b>${f.toFixed(4)}%</b>${ztxt} → zyada log SHORT, upar short squeeze ho sakta hai` };
}

function oiPrice(cur: Ticker, st?: Stats): { p: number; o: number } | null {
  if (!st || !st.p6 || !st.oi6) return null;
  return { p: pct(st.p6, cur.mark_price), o: pct(st.oi6, cur.oi_usd) };
}

function sigOiPrice(cur: Ticker, st?: Stats): Sig | null {
  const m = oiPrice(cur, st);
  if (!m) return null;
  const { p, o } = m;
  const base = `6h: Price ${sign(p)}%, OI ${sign(o)}%`;
  const PM = CFG.PRICE_MOVE, OM = CFG.OI_MOVE;
  if (p >= PM && o <= -OM) return { name: "OI/Price", bias: -1, text: `${base} → rally shorts ke band hone se aayi hai, naye buyers kam (kamzor rally)` };
  if (p >= PM && o >= OM) return { name: "OI/Price", bias: +1, text: `${base} → naya paisa aa raha hai (longs badh rahe)` };
  if (p <= -PM && o >= OM) return { name: "OI/Price", bias: -1, text: `${base} → naye shorts khul rahe hain; funding negative hua to squeeze ka risk` };
  if (p <= -PM && o <= -OM) return { name: "OI/Price", bias: +1, text: `${base} → longs band/liquidate ho rahe hain, selling thak sakti hai` };
  return null;
}

// OI jis price par bana, wahan naye positions maan kar har leverage ki liquidation ka andaza.
function liqZones(cur: Ticker, st?: Stats) {
  const price = cur.mark_price;
  if (!st || st.f_n < 8 || price <= 0 || !st.bins?.length) return null;
  const bins = new Map<string, number>();
  let total = 0;
  for (const [p, d] of st.bins) {
    if (!(p > 0) || !(d > 0)) continue;
    total += d;
    const w = d / (LEVERAGES.length * 2);
    for (const L of LEVERAGES) {
      for (const [side, z] of [["long", p * (1 - 0.9 / L)], ["short", p * (1 + 0.9 / L)]] as const) {
        const k = Math.round(Math.log(z / price) / Math.log(1.005));
        const key = `${side}|${k}`;
        bins.set(key, (bins.get(key) ?? 0) + w);
      }
    }
  }
  if (total <= 0) return null;
  const res: Record<string, { price: number; dist: number; usd: number; share: number }> = {};
  for (const side of ["long", "short"]) {
    let best: [number, number] | null = null;
    for (const [key, w] of bins) {
      const [s, ks] = key.split("|");
      const k = Number(ks);
      if (s !== side || (side === "long" ? k >= 0 : k <= 0)) continue;
      if (!best || w > best[0]) best = [w, k];
    }
    if (best) {
      const lvl = price * Math.pow(1.005, best[1]);
      res[side] = { price: lvl, dist: pct(price, lvl), usd: best[0], share: best[0] / (total / 2) };
    }
  }
  return res;
}

function sigLiq(cur: Ticker, st?: Stats): Sig | null {
  const z = liqZones(cur, st);
  if (!z) return null;
  let best: [string, { price: number; dist: number; usd: number; share: number }] | null = null;
  for (const side of ["long", "short"]) {
    const s = z[side];
    if (s && Math.abs(s.dist) <= CFG.LIQ_NEAR && s.share >= CFG.LIQ_MIN_SHARE) {
      if (!best || Math.abs(s.dist) < Math.abs(best[1].dist)) best = [side, s];
    }
  }
  if (!best) return null;
  const [side, s] = best;
  if (side === "long") {
    return { name: "Liquidation", bias: -1,
      text: `Long liquidation zone ~<b>$${fmtPrice(s.price)}</b> (${sign(s.dist)}%), ~${fmtUsd(s.usd)} positions → price neeche shikaar karne ja sakta hai (andaza)` };
  }
  return { name: "Liquidation", bias: +1,
    text: `Short liquidation zone ~<b>$${fmtPrice(s.price)}</b> (${sign(s.dist)}%), ~${fmtUsd(s.usd)} positions → price upar shikaar karne ja sakta hai (andaza)` };
}

type Unlock = { symbol: string; unlock_date: string; pct_supply: number | null; note: string | null };
function daysUntil(dateStr: string, today: string) {
  return Math.round((Date.parse(dateStr) - Date.parse(today)) / 86_400_000);
}
function sigUnlock(cur: Ticker, unlocks: Map<string, Unlock[]>, today: string): Sig | null {
  const items = unlocks.get(cur.underlying.toUpperCase()) ?? unlocks.get(cur.symbol.toUpperCase()) ?? [];
  const soon = items.filter((u) => { const d = daysUntil(u.unlock_date, today); return d >= 0 && d <= CFG.UNLOCK_DAYS; })
    .sort((a, b) => a.unlock_date.localeCompare(b.unlock_date));
  if (!soon.length) return null;
  const u = soon[0];
  const d = daysUntil(u.unlock_date, today);
  const when = d === 0 ? "aaj" : `${d} din baad`;
  const size = u.pct_supply ? ` ${num(u.pct_supply).toFixed(2)}% supply` : "";
  const note = u.note ? ` (${esc(u.note)})` : "";
  return { name: "Unlock", bias: -1, text: `Token unlock ${when} (${u.unlock_date})${size}${note} → selling pressure aa sakta hai` };
}

// ---------------------------------------------------------------- telegram
async function tg(text: string) {
  if (!TG_TOKEN || !TG_CHAT) { console.log("[telegram skip]\n" + text); return; }
  const chunks: string[] = [];
  let buf = "";
  for (const block of text.split("\n\n")) {
    if (buf.length + block.length + 2 > 3800) { chunks.push(buf); buf = ""; }
    buf += (buf ? "\n\n" : "") + block;
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: c, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.log("Telegram error", r.status, (await r.text()).slice(0, 300));
  }
}

const VARIANT_NAME: Record<string, string> = { S: "SOXLBUSD MACD+StochRSI", A: "Signal disha", B: "Ulta", C: "BTC trend disha", E: "EMA200 cross" };

function alertBlock(cur: Ticker, sigs: Sig[], trades: PaperTrade[] = []) {
  const bias = sigs.reduce((a, s) => a + s.bias, 0);
  const head = bias < 0 ? "🔻 Neeche ka risk" : bias > 0 ? "🔺 Upar ka risk" : "⚖️ Mixed";
  const link = `https://www.delta.exchange/app/futures/trade/${cur.underlying}/${cur.symbol}`;
  const lines = [
    `⚠️ <b><a href="${link}">${esc(cur.symbol)}</a></b> — Score ${sigs.length}/4 · ${head}`,
    `Price $${fmtPrice(cur.mark_price)} (${sign(cur.change_24h)}% 24h) · OI ${fmtUsd(cur.oi_usd)} · Vol ${fmtUsd(cur.volume_usd)}`,
    ...sigs.map((s) => `• <i>${s.name}:</i> ${s.text}`),
  ];
  if (trades.length) {
    const t0 = trades[0];
    lines.push(`📘 <i>Paper trades @ $${fmtPrice(t0.entry)} · SL ${t0.sl_pct.toFixed(1)}% · TP ${(t0.sl_pct * CFG.RR).toFixed(1)}%:</i> ` +
      trades.map((t) => `${t.variant} ${t.side.toUpperCase()}`).join(" · "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- paper-trade tracker (1:RR)
type PaperTrade = {
  symbol: string; side: "long" | "short"; entry: number; sl: number; tp: number; sl_pct: number;
  score: number; combo: string; btc_trend: string | null; variant: string;
};
type OpenTrade = PaperTrade & { id: number; opened_at: string; max_fav_pct: number; max_adv_pct: number };

async function markCandles(symbol: string, hours: number) {
  const end = Math.floor(Date.now() / 1000), start = end - hours * 3600;
  const r = await fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=1h&symbol=${
    encodeURIComponent("MARK:" + symbol)}&start=${start}&end=${end}`);
  if (!r.ok) return [];
  const j = await r.json();
  return ((j.result ?? []) as { time: number; high: number; low: number; close: number }[])
    .sort((a, b) => a.time - b.time);
}

async function atrPct(symbol: string, price: number) {
  const c = await markCandles(symbol, 20);
  if (c.length < 5 || price <= 0) return 2; // data kam ho to 2% default
  const tr: number[] = [];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  const last = tr.slice(-14);
  const atr = last.reduce((a, b) => a + b, 0) / last.length;
  return Math.min(CFG.SL_MAX_PCT, Math.max(CFG.SL_MIN_PCT, (CFG.ATR_MULT * atr / price) * 100));
}

let BTC_TREND_CACHE: string | null | undefined;
async function btcTrend() {
  if (BTC_TREND_CACHE !== undefined) return BTC_TREND_CACHE;
  const c = await markCandles("BTCUSD", 170);
  if (c.length < 100) return (BTC_TREND_CACHE = null);
  const sma = c.slice(-169, -1).reduce((a, x) => a + x.close, 0) / (c.slice(-169, -1).length);
  return (BTC_TREND_CACHE = c[c.length - 1].close > sma ? "up" : "down");
}

// Ek alert par 3 paper trades: A = signal ki disha, B = ulta, C = BTC 7-din trend ki disha
async function openTrades(cur: Ticker, sigs: Sig[], openKeys: Set<string>): Promise<PaperTrade[]> {
  if (cur.mark_price <= 0) return [];
  const bias = sigs.reduce((a, s) => a + s.bias, 0);
  const trend = await btcTrend();
  const sides: [string, "long" | "short" | null][] = [
    ["A", bias > 0 ? "long" : bias < 0 ? "short" : null],
    ["B", bias > 0 ? "short" : bias < 0 ? "long" : null],
    ["C", trend === "up" ? "long" : trend === "down" ? "short" : null],
  ];
  const todo = sides.filter(([v, side]) => side && !openKeys.has(`${cur.symbol}|${v}`));
  if (!todo.length) return [];
  const slp = await atrPct(cur.symbol, cur.mark_price);
  const out: PaperTrade[] = [];
  for (const [variant, side] of todo) {
    const dir = side === "long" ? 1 : -1;
    out.push({
      symbol: cur.symbol, side: side!, entry: cur.mark_price,
      sl: cur.mark_price * (1 - dir * slp / 100),
      tp: cur.mark_price * (1 + dir * CFG.RR * slp / 100),
      sl_pct: Math.round(slp * 100) / 100,
      score: sigs.length,
      combo: sigs.map((s) => s.name).sort().join("+"),
      btc_trend: trend,
      variant,
    });
    openKeys.add(`${cur.symbol}|${variant}`);
  }
  await sb("delta_trades", { method: "POST", body: JSON.stringify(out), prefer: "return=minimal" });
  return out;
}

async function updateTrades(now: Date) {
  const open: OpenTrade[] = await sb("delta_trades?status=eq.open&select=*") ?? [];
  const closedMsgs: string[] = [];
  for (const t of open) {
    const price = ALL_PRICES.get(t.symbol);
    if (!price) continue;
    const dir = t.side === "long" ? 1 : -1;
    const movePct = dir * pct(t.entry, price);
    const fav = Math.max(num(t.max_fav_pct), movePct), adv = Math.min(num(t.max_adv_pct), movePct);
    const ageH = (now.getTime() - Date.parse(t.opened_at)) / 3_600_000;
    let status: string | null = null, exit = price;
    if (dir > 0 ? price <= t.sl : price >= t.sl) { status = "sl"; exit = t.sl; }
    else if (dir > 0 ? price >= t.tp : price <= t.tp) { status = "tp"; exit = t.tp; }
    else if ((t.variant ?? "A") === "S") {
      // SOXL trade: market band hone par (ya agle din) band
      const ss = session(now.getTime() / 1000);
      if (!ss.open || ss.date !== session(Date.parse(t.opened_at) / 1000).date) status = "eod";
    }
    else if (ageH >= ((t.variant ?? "A") === "E" ? CFG.EMA_HOLD_H : CFG.HOLD_H)) status = "timeout";
    const patch: Record<string, unknown> = { max_fav_pct: fav, max_adv_pct: adv };
    if (status) {
      const r = (dir * pct(t.entry, exit) - CFG.FEE_PCT) / t.sl_pct;
      Object.assign(patch, { status, closed_at: now.toISOString(), exit_price: exit, r: Math.round(r * 100) / 100 });
      const icon = status === "tp" ? "✅" : status === "sl" ? "❌" : status === "eod" ? "🔔" : "⏱";
      closedMsgs.push(`${icon} [${t.variant ?? "A"}] ${esc(t.symbol)} ${t.side.toUpperCase()} ${status.toUpperCase()} · ${r >= 0 ? "+" : ""}${r.toFixed(2)}R ` +
        `($${fmtPrice(t.entry)} → $${fmtPrice(exit)}, ${ageH.toFixed(1)}h)`);
    } else if (fav === num(t.max_fav_pct) && adv === num(t.max_adv_pct)) {
      continue; // kuch nahi badla
    }
    await sb(`delta_trades?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=minimal" });
  }
  if (closedMsgs.length) await tg("📘 <b>Paper trades band hue</b>\n" + closedMsgs.join("\n"));
  return { open: open.length, closed: closedMsgs.length };
}

function rStats(rows: { r: number }[]) {
  const n = rows.length;
  if (!n) return "—";
  const wins = rows.filter((x) => x.r > 0).length;
  const tot = rows.reduce((a, x) => a + num(x.r), 0);
  return `${n} trades · win ${(wins / n * 100).toFixed(0)}% · avg ${tot / n >= 0 ? "+" : ""}${(tot / n).toFixed(2)}R · total ${tot >= 0 ? "+" : ""}${tot.toFixed(1)}R`;
}

async function weeklyReport(now: Date) {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  type Closed = { r: number; combo: string; side: string; btc_trend: string | null; status: string; variant: string | null };
  const cols = "r,combo,side,btc_trend,status,variant";
  const week: Closed[] = await sb(`delta_trades?status=neq.open&closed_at=gte.${since}&select=${cols}`) ?? [];
  const all: Closed[] = await sb(`delta_trades?status=neq.open&select=${cols}`) ?? [];
  const openN = (await sb("delta_trades?status=eq.open&select=id") ?? []).length;
  const byVariant = (rows: Closed[]) => ["S", "E", "A", "B", "C"].filter((v) => v === "S" || rows.some((x) => (x.variant ?? "A") === v)).map((v) => {
    const sub = rows.filter((x) => (x.variant ?? "A") === v);
    const sides = ["long", "short"].map((sd) => {
      const ss = sub.filter((x) => x.side === sd);
      return ss.length ? `     ${sd}: ${rStats(ss)}` : "";
    }).filter(Boolean).join("\n");
    return `<b>${v} · ${VARIANT_NAME[v]}</b>: ${rStats(sub)}` + (sides ? `\n${sides}` : "");
  }).join("\n");
  const be = (100 / (CFG.RR + 1)).toFixed(0);
  await tg([
    `📊 <b>Weekly Signal Report</b> · ${istDay(now)}`,
    `<i>S = SOXLBUSD (Daily MACD trend + 5m Stoch RSI), SL swing par, TP 1:${SOXL.RR}, break-even ~${Math.round(100 / (SOXL.RR + 1))}% win. ` +
      `E/A/B/C = purane strategies (band, sirf purana hisaab; break-even ~${be}%).</i>`,
    `🗓 <b>Pichhle 7 din</b>\n${byVariant(week)}`,
    `📈 <b>Shuru se ab tak</b>\n${byVariant(all)}`,
    `Abhi khule paper trades: ${openN}`,
  ].join("\n\n"));
}

// ---------------------------------------------------------------- SOXLBUSD strategy (live)
async function deltaCandles(symbol: string, resolution: string, startSec: number, endSec: number): Promise<SCandle[]> {
  const stepS = resolution === "5m" ? 300 : resolution === "1d" ? 86400 : resolution === "4h" ? 14400 : 3600;
  const chunk = 1900 * stepS;
  const out = new Map<number, SCandle>();
  for (let s = startSec; s < endSec; s += chunk) {
    const e = Math.min(endSec, s + chunk);
    const r = await fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=${resolution}&symbol=${
      encodeURIComponent(symbol)}&start=${s}&end=${e}`);
    if (!r.ok) throw new Error(`Delta candles ${resolution} ${r.status}`);
    const j = await r.json();
    for (const c of (j.result ?? []) as SCandle[]) out.set(c.time, { time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close });
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

async function runSoxl(now: Date) {
  await fetchTickers();                       // ALL_PRICES (paper trade tracking ke liye)
  const tradeRes = await updateTrades(now);
  const nowS = Math.floor(now.getTime() / 1000);
  const ss = session(nowS);
  const base = { mode: "soxl", market_open: ss.open, trades_open: tradeRes.open, trades_closed: tradeRes.closed };
  if (!ss.open) return base;

  const daily = await deltaCandles(SOXL.SYMBOL, "1d", nowS - 200 * 86400, nowS);
  const tr = dailyTrendAt(daily, nowS);
  const trendTxt = tr.trend === 1 ? "🟢 BUY" : tr.trend === -1 ? "🔴 SELL" : "⚪ Flat";

  // Market khulte hi aaj ka trend batao (din me ek baar)
  const lastDay = await getState("__SOXLDAY__");
  if (!lastDay || session(lastDay.getTime() / 1000).date !== ss.date) {
    await upsertAlerts([{ symbol: "__SOXLDAY__", last_ts: now.toISOString(), last_score: 0 }]);
    await tg(`🔔 <b>US market khula</b> · ${SOXL.SYMBOL}\n` +
      `Aaj ka daily MACD trend: <b>${trendTxt}</b> (MACD ${tr.line.toFixed(3)} vs Signal ${tr.signal.toFixed(3)})\n` +
      `<i>${tr.trend === -1 ? "Sirf SELL dekhenge: 5m par upar jaane ke baad Stoch RSI 80 ke upar se cross down." :
        tr.trend === 1 ? "Sirf BUY dekhenge: 5m par neeche aane ke baad Stoch RSI 20 ke neeche se cross up." : "Trend saaf nahi, aaj trade nahi."}</i>`);
  }
  if (tr.trend === 0) return { ...base, trend: 0 };

  // Sirf nayi band 5m candle par check
  const c5 = await deltaCandles(SOXL.SYMBOL, "5m", nowS - 400 * 300, nowS);
  const closed = c5.filter((c) => c.time + 300 <= nowS);
  if (closed.length < 60) return { ...base, trend: tr.trend, note: "5m data kam" };
  const lastC = closed[closed.length - 1];
  const lastDone = await getState("__SOXL5M__");
  if (lastDone && lastDone.getTime() / 1000 >= lastC.time) return { ...base, trend: tr.trend, checked: false };
  await upsertAlerts([{ symbol: "__SOXL5M__", last_ts: new Date(lastC.time * 1000).toISOString(), last_score: 0 }]);
  if (session(lastC.time + 299).date !== ss.date || !session(lastC.time + 299).open) return { ...base, trend: tr.trend, checked: false };
  if (ss.min > ss.closeMin - SOXL.NO_ENTRY_LAST_MIN) return { ...base, trend: tr.trend, note: "market band hone wala" };

  const { k, d } = stochRsi(closed.map((c) => c.close), SOXL.STOCH.rsi, SOXL.STOCH.stoch, SOXL.STOCH.k, SOXL.STOCH.d);
  const i = closed.length - 1;
  const sig = entryAt(closed, k, d, i, tr.trend);
  const kd = { k: +k[i].toFixed(1), d: +d[i].toFixed(1) };
  if (!sig) return { ...base, trend: tr.trend, checked: true, ...kd };

  // Aaj ke trades aur khula trade
  type Row = { opened_at: string; status: string };
  const recent: Row[] = await sb(`delta_trades?variant=eq.S&opened_at=gte.${new Date((nowS - 20 * 3600) * 1000).toISOString()}&select=opened_at,status`) ?? [];
  const today = recent.filter((r) => session(Date.parse(r.opened_at) / 1000).date === ss.date);
  const link = `https://www.delta.exchange/app/futures/trade/SOXLB/${SOXL.SYMBOL}`;
  if (sig.skip) {
    return { ...base, trend: tr.trend, signal: "skipped", riskPct: +sig.riskPct.toFixed(2) };
  }
  let note = "";
  if (today.some((r) => r.status === "open")) note = "Ek trade pehle se khula hai — naya paper trade nahi khola.";
  else if (today.length >= SOXL.MAX_TRADES_PER_DAY) note = `Aaj ke ${SOXL.MAX_TRADES_PER_DAY} trade ho chuke — naya paper trade nahi khola.`;
  else {
    await sb("delta_trades", { method: "POST", prefer: "return=minimal", body: JSON.stringify({
      symbol: SOXL.SYMBOL, side: sig.side, entry: sig.entry, sl: sig.sl, tp: sig.tp, sl_pct: +sig.riskPct.toFixed(3),
      score: 1, combo: "MACD-D+StochRSI-5m", btc_trend: tr.trend === 1 ? "up" : "down", variant: "S",
    }) });
  }
  const buy = sig.side === "long";
  await tg([
    `${buy ? "🟢 <b>BUY</b>" : "🔴 <b>SELL</b>"} <b><a href="${link}">${SOXL.SYMBOL}</a></b> · ${istStr(now)}`,
    `Daily MACD trend: ${trendTxt}`,
    `5m Stoch RSI: K ${kd.k} / D ${kd.d} — ${buy ? "20 ke neeche se upar cross" : "80 ke upar se neeche cross"}`,
    `Entry ~$${fmtPrice(sig.entry)}`,
    `SL $${fmtPrice(sig.sl)} (${sig.riskPct.toFixed(2)}%, ${buy ? "swing low" : "swing high"})`,
    `TP $${fmtPrice(sig.tp)} (${(sig.riskPct * SOXL.RR).toFixed(2)}%, 1:${SOXL.RR})`,
    note ? `<i>${note}</i>` : `📘 Paper trade khul gaya (market band hone par apne aap band).`,
    `<i>Sirf jaankari, financial advice nahi. SOXL 3x leveraged hai — size chhota rakhein, SL zaroor.</i>`,
  ].join("\n"));
  return { ...base, trend: tr.trend, signal: sig.side, ...kd };
}

async function runSoxlBacktest(days: number) {
  const nowS = Math.floor(Date.now() / 1000);
  const [c5, daily] = await Promise.all([
    deltaCandles(SOXL.SYMBOL, "5m", nowS - days * 86400, nowS),
    deltaCandles(SOXL.SYMBOL, "1d", nowS - (days + 120) * 86400, nowS),
  ]);
  const bt = soxlBacktest(c5, daily);
  return {
    candles5m: c5.length, firstCandle: c5.length ? new Date(c5[0].time * 1000).toISOString() : null,
    dailyCandles: daily.length, skippedSignals: bt.skipped, summary: bt.summary,
    lastTrades: bt.trades.slice(-15).map((t) => ({ date: t.date, side: t.side, reason: t.reason, r: +t.r.toFixed(2), pnlPct: +t.pnlPct.toFixed(2) })),
  };
}

// ---------------------------------------------------------------- main
async function loadCommon() {
  const [tickers, statsRows, unlockRows] = await Promise.all([
    fetchTickers(),
    sb("rpc/delta_stats", { method: "POST", body: JSON.stringify({ p_days: 3 }) }) as Promise<Stats[]>,
    sb("delta_unlocks?select=symbol,unlock_date,pct_supply,note") as Promise<Unlock[]>,
  ]);
  const stats = new Map<string, Stats>();
  for (const s of statsRows ?? []) stats.set(s.symbol, { ...s, f_n: num(s.f_n), bins: (s.bins ?? []) as [number, number][] });
  const unlocks = new Map<string, Unlock[]>();
  for (const u of unlockRows ?? []) {
    const k = String(u.symbol).trim().toUpperCase();
    unlocks.set(k, [...(unlocks.get(k) ?? []), u]);
  }
  return { tickers, stats, unlocks };
}

async function maybeSave(now: Date, tickers: Ticker[]) {
  const last = await sb("delta_snapshots?select=ts&order=ts.desc&limit=1");
  const lastTs = last?.length ? new Date(last[0].ts).getTime() : 0;
  if (now.getTime() - lastTs < (CFG.SAVE_EVERY_MIN * 60 - 20) * 1000) return false;
  const rows = tickers.map((x) => ({
    ts: now.toISOString(), symbol: x.symbol, mark_price: x.mark_price, funding_rate: x.funding_rate,
    oi_usd: x.oi_usd, oi_change_6h_usd: x.oi_change_6h_usd, volume_usd: x.volume_usd, change_24h: x.change_24h,
  }));
  await sb("delta_snapshots", { method: "POST", body: JSON.stringify(rows), prefer: "return=minimal" });
  return true;
}

// ---------------------------------------------------------------- EMA200 cross strategy
type Candle = { time: number; open: number; high: number; low: number; close: number };
async function tfCandles(symbol: string, tfH: number, bars: number): Promise<Candle[]> {
  const res = tfH >= 4 ? "4h" : "1h";
  const step = res === "4h" ? 4 : 1;
  const end = Math.floor(Date.now() / 1000), start = end - bars * step * 3600;
  const r = await fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=${res}&symbol=${
    encodeURIComponent("MARK:" + symbol)}&start=${start}&end=${end}`);
  if (!r.ok) return [];
  const j = await r.json();
  const nowS = Date.now() / 1000;
  return ((j.result ?? []) as Candle[])
    .filter((c) => c.time + step * 3600 <= nowS + 5)        // sirf band (closed) candles
    .sort((a, b) => a.time - b.time);
}

function emaCross(c: Candle[], len: number) {
  if (c.length < len + 5) return null;
  const k = 2 / (len + 1);
  let e = c[0].close;
  const ema: number[] = [e];
  for (let i = 1; i < c.length; i++) { e = c[i].close * k + e * (1 - k); ema.push(e); }
  const n = c.length - 1;
  const up = c[n - 1].close <= ema[n - 1] && c[n].close > ema[n];
  const down = c[n - 1].close >= ema[n - 1] && c[n].close < ema[n];
  // ATR(14) isi timeframe par
  let tr = 0;
  for (let i = n - 13; i <= n; i++) {
    tr += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  return { side: up ? "long" as const : down ? "short" as const : null, ema: ema[n], close: c[n].close, candleTime: c[n].time, atr: tr / 14 };
}

async function runEmaScan(now: Date) {
  const tickers = await fetchTickers();
  const tradeRes = await updateTrades(now);
  const tfS = CFG.EMA_TF_H * 3600;
  const candleStart = Math.floor(now.getTime() / 1000 / tfS) * tfS;      // abhi wali candle ka start
  const lastDone = await getState("__EMA__");
  const mins = (now.getTime() / 1000 - candleStart) / 60;
  // Har nayi candle band hone ke baad pehle 15 minute me ek baar check
  if (mins > 15 || (lastDone && lastDone.getTime() / 1000 >= candleStart)) {
    return { mode: "ema", coins: tickers.length, checked: false, trades_open: tradeRes.open, trades_closed: tradeRes.closed };
  }
  await upsertAlerts([{ symbol: "__EMA__", last_ts: now.toISOString(), last_score: 0 }]);

  const openKeys = new Set<string>(
    ((await sb("delta_trades?status=eq.open&variant=eq.E&select=symbol")) ?? []).map((x: { symbol: string }) => x.symbol),
  );
  const bars = CFG.EMA_LEN * 3 + 20;
  const blocks: string[] = [];
  const newTrades: PaperTrade[] = [];
  for (let i = 0; i < tickers.length; i += 12) {
    const batch = tickers.slice(i, i + 12);
    const res = await Promise.all(batch.map(async (cur) => {
      try { return { cur, x: emaCross(await tfCandles(cur.symbol, CFG.EMA_TF_H, bars), CFG.EMA_LEN) }; }
      catch { return { cur, x: null }; }
    }));
    for (const { cur, x } of res) {
      if (!x || !x.side) continue;
      if (x.candleTime + tfS < candleStart) continue;              // purani candle ka cross nahi
      const price = cur.mark_price || x.close;
      const slp = Math.min(CFG.SL_MAX_PCT, Math.max(CFG.SL_MIN_PCT, (CFG.ATR_MULT * x.atr / price) * 100));
      const dir = x.side === "long" ? 1 : -1;
      let trade: PaperTrade | null = null;
      if (!openKeys.has(cur.symbol)) {
        trade = {
          symbol: cur.symbol, side: x.side, entry: price,
          sl: price * (1 - dir * slp / 100), tp: price * (1 + dir * CFG.RR * slp / 100),
          sl_pct: Math.round(slp * 100) / 100, score: 1, combo: `EMA${CFG.EMA_LEN}-${CFG.EMA_TF_H}h`,
          btc_trend: null, variant: "E",
        };
        newTrades.push(trade);
        openKeys.add(cur.symbol);
      }
      const link = `https://www.delta.exchange/app/futures/trade/${cur.underlying}/${cur.symbol}`;
      blocks.push([
        `${x.side === "long" ? "🟢 BUY" : "🔴 SELL"} <b><a href="${link}">${esc(cur.symbol)}</a></b> — ${CFG.EMA_TF_H}h candle EMA${CFG.EMA_LEN} ke ` +
          `${x.side === "long" ? "upar" : "neeche"} band hui`,
        `Close $${fmtPrice(x.close)} · EMA $${fmtPrice(x.ema)} · Vol ${fmtUsd(cur.volume_usd)}`,
        trade
          ? `📘 Paper trade: ${trade.side.toUpperCase()} @ $${fmtPrice(trade.entry)} · SL $${fmtPrice(trade.sl)} (${trade.sl_pct.toFixed(1)}%) · TP $${fmtPrice(trade.tp)} (${(trade.sl_pct * CFG.RR).toFixed(1)}%)`
          : `📘 Is coin par pehle se ek paper trade khula hai`,
      ].join("\n"));
    }
  }
  if (newTrades.length) await sb("delta_trades", { method: "POST", body: JSON.stringify(newTrades), prefer: "return=minimal" });
  if (blocks.length) {
    await tg(`📡 <b>EMA${CFG.EMA_LEN} Signals (${CFG.EMA_TF_H}h)</b> · ${istStr(now)}\n\n` + blocks.join("\n\n") +
      "\n\n<i>Backtest me is strategy ka koi pakka faayda nahi dikha. Sirf jaankari — trade ka faisla aapka, stop-loss zaroor.</i>");
  }
  return { mode: "ema", coins: tickers.length, checked: true, signals: blocks.length, trades_opened: newTrades.length,
    trades_open: tradeRes.open, trades_closed: tradeRes.closed };
}

async function runEmaSummary(now: Date) {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  type Row = { symbol: string; side: string; entry: number; opened_at: string };
  const recent: Row[] = await sb(`delta_trades?variant=eq.E&opened_at=gte.${since}&select=symbol,side,entry,opened_at&order=opened_at.asc`) ?? [];
  const openN = (await sb("delta_trades?status=eq.open&variant=eq.E&select=id") ?? []).length;
  const lines = recent.map((r) => `${r.side === "long" ? "🟢" : "🔴"} ${esc(r.symbol)} ${r.side.toUpperCase()} @ $${fmtPrice(r.entry)} · ${istStr(new Date(r.opened_at))}`);
  await tg([
    `🗞 <b>Daily EMA${CFG.EMA_LEN} Summary</b> · ${istDay(now)}`,
    `<b>Pichhle 24 ghante ke crosses:</b>\n` + (lines.join("\n") || "— koi cross nahi"),
    `Khule EMA paper trades: ${openN}`,
  ].join("\n\n"));
}

async function runScan(now: Date) {
  const { tickers, stats, unlocks } = await loadCommon();
  const today = istDay(now);
  const prevRows = await sb("delta_alerts?select=symbol,last_ts,last_score");
  const prev = new Map<string, { ts: number; score: number }>();
  for (const r of prevRows ?? []) prev.set(r.symbol, { ts: Date.parse(r.last_ts), score: num(r.last_score) });

  BTC_TREND_CACHE = undefined; // har run me taaza
  // Pehle khule paper trades update (SL/TP/timeout)
  const tradeRes = await updateTrades(now);
  const openKeys = new Set<string>(
    ((await sb("delta_trades?status=eq.open&select=symbol,variant")) ?? [])
      .map((x: { symbol: string; variant: string | null }) => `${x.symbol}|${x.variant ?? "A"}`),
  );

  const blocks: { score: number; vol: number; text: string }[] = [];
  const sent: { symbol: string; last_ts: string; last_score: number }[] = [];
  let opened = 0;
  for (const cur of tickers) {
    const st = stats.get(cur.symbol);
    const sigs = [sigFunding(cur, st), sigOiPrice(cur, st), sigLiq(cur, st), sigUnlock(cur, unlocks, today)]
      .filter((s): s is Sig => s !== null);
    if (sigs.length < CFG.MIN_SCORE) continue;
    const p = prev.get(cur.symbol);
    if (p && (now.getTime() - p.ts) / 3_600_000 < CFG.COOLDOWN_H && sigs.length <= p.score) continue;
    let trades: PaperTrade[] = [];
    try { trades = await openTrades(cur, sigs, openKeys); opened += trades.length; }
    catch (e) { console.error("openTrades", cur.symbol, e); }
    blocks.push({ score: sigs.length, vol: cur.volume_usd, text: alertBlock(cur, sigs, trades) });
    sent.push({ symbol: cur.symbol, last_ts: now.toISOString(), last_score: sigs.length });
  }
  if (blocks.length) {
    blocks.sort((a, b) => b.score - a.score || b.vol - a.vol);
    await tg(`📡 <b>Delta Signals</b> · ${istStr(now)}\n\n` + blocks.map((b) => b.text).join("\n\n") +
      "\n\n<i>Sirf data hai, trade ka faisla aapka. Stop-loss zaroor lagayein.</i>");
    await upsertAlerts(sent);
  }
  const saved = await maybeSave(now, tickers);
  return { coins: tickers.length, alerts: blocks.length, saved, trades_open: tradeRes.open, trades_closed: tradeRes.closed, trades_opened: opened };
}

async function runSummary(now: Date) {
  const { tickers, stats, unlocks } = await loadCommon();
  const today = istDay(now);
  const byF = [...tickers].sort((a, b) => a.funding_rate - b.funding_rate);
  const pos = byF.slice(-5).reverse().filter((x) => x.funding_rate > 0).map((x) => `${esc(x.symbol)} +${x.funding_rate.toFixed(4)}%`);
  const neg = byF.slice(0, 5).filter((x) => x.funding_rate < 0).map((x) => `${esc(x.symbol)} ${x.funding_rate.toFixed(4)}%`);
  const moves = tickers.map((x) => ({ x, m: oiPrice(x, stats.get(x.symbol)) }))
    .filter((v) => v.m).sort((a, b) => Math.abs(b.m!.o) - Math.abs(a.m!.o)).slice(0, 5)
    .map(({ x, m }) => `${esc(x.symbol)} OI ${sign(m!.o)}% · Price ${sign(m!.p)}%`);
  const syms = new Set(tickers.flatMap((x) => [x.underlying.toUpperCase(), x.symbol.toUpperCase()]));
  const up: string[] = [];
  for (const [s, items] of unlocks) {
    for (const u of items) {
      const d = daysUntil(u.unlock_date, today);
      if (d >= 0 && d <= CFG.UNLOCK_DAYS && syms.has(s)) {
        up.push(`${s} — ${u.unlock_date}` + (u.pct_supply ? ` · ${num(u.pct_supply).toFixed(2)}% supply` : ""));
      }
    }
  }
  up.sort((a, b) => a.split(" — ")[1].localeCompare(b.split(" — ")[1]));
  await tg([
    `🗞 <b>Daily Summary</b> · ${today}`,
    "<b>Sabse zyada positive funding (longs bhaari):</b>\n" + (pos.join("\n") || "—"),
    "<b>Sabse zyada negative funding (shorts bhaari):</b>\n" + (neg.join("\n") || "—"),
    "<b>6h me sabse bada OI badlav:</b>\n" + (moves.join("\n") || "— (abhi history kam hai)"),
    `<b>Agle ${CFG.UNLOCK_DAYS} din ke unlocks:</b>\n` + (up.join("\n") || "— (delta_unlocks table me dates jodein)"),
  ].join("\n\n"));
  await sb(`delta_snapshots?ts=lt.${new Date(now.getTime() - CFG.RETENTION_DAYS * 86_400_000).toISOString()}`,
    { method: "DELETE", prefer: "return=minimal" });
}

// ---------------------------------------------------------------- unlock auto-refresh (DefiLlama)
const UNLOCK_SKIP = new Set(["GRAM"]); // naam takrata hai (DefiLlama ka TON), isliye skip
async function refreshUnlocks(now: Date) {
  const [deltaRes, pageRes] = await Promise.all([
    fetch(CFG.DELTA_URL, { headers: { "User-Agent": "delta-signal-scanner" } }),
    fetch("https://defillama.com/unlocks", { headers: { "User-Agent": "Mozilla/5.0 (delta-signal-scanner)" } }),
  ]);
  if (!deltaRes.ok) throw new Error(`Delta API ${deltaRes.status}`);
  if (!pageRes.ok) throw new Error(`DefiLlama ${pageRes.status}`);
  const deltaSyms = new Set<string>(
    ((await deltaRes.json()).result ?? []).map((t: { underlying_asset_symbol?: string }) =>
      String(t.underlying_asset_symbol ?? "").toUpperCase()),
  );
  let html: string | null = await pageRes.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("DefiLlama page format badal gaya");
  // deno-lint-ignore no-explicit-any
  const items: any[] = JSON.parse(m[1])?.props?.pageProps?.data ?? [];
  html = null;
  if (!items.length) throw new Error("DefiLlama data khali");

  const start = now.getTime() / 1000, end = start + 30 * 86400;
  const rows = new Map<string, { symbol: string; unlock_date: string; pct_supply: number; note: string }>();
  for (const p of items) {
    const sym = String(p.tSymbol ?? "").toUpperCase();
    if (!sym || UNLOCK_SKIP.has(sym) || !deltaSyms.has(sym) || !(p.circSupply > 0)) continue;
    const byDay = new Map<string, number>();
    for (const e of p.upcomingEvent ?? []) {
      if (e.unlockType !== "cliff" || !(e.timestamp >= start && e.timestamp <= end)) continue;
      const n = (e.noOfTokens ?? []).reduce((a: number, b: unknown) => a + num(b), 0);
      const day = new Date(e.timestamp * 1000).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + n);
    }
    for (const [day, n] of byDay) {
      const pctS = (n / p.circSupply) * 100;
      if (pctS < 0.5) continue;
      const usd = p.tPrice ? n * p.tPrice : 0;
      const key = `${sym}|${day}`;
      const prev = rows.get(key);
      const total = (prev?.pct_supply ?? 0) + pctS;
      rows.set(key, {
        symbol: sym, unlock_date: day, pct_supply: Math.round(total * 100) / 100,
        note: `${String(p.name ?? sym).slice(0, 60)}${usd ? ` · ~$${(usd / 1e6).toFixed(1)}M` : ""} · DefiLlama`,
      });
    }
  }
  // Sirf DefiLlama wali purani rows hatao; aapki khud ki daali rows waisi hi rahengi
  await sb("delta_unlocks?note=like.*DefiLlama", { method: "DELETE", prefer: "return=minimal" });
  const list = [...rows.values()];
  if (list.length) {
    await sb("delta_unlocks", { method: "POST", body: JSON.stringify(list), prefer: "return=minimal" });
  }
  return { unlocks: list.length };
}

Deno.serve(async (req) => {
  const now = new Date();
  const mode = new URL(req.url).searchParams.get("mode") ?? "scan";
  try {
    if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    if (mode === "soxl_bt") {
      const lastB = await getState("__SOXLBT__");
      if (lastB && now.getTime() - lastB.getTime() < 60_000) {
        return Response.json({ ok: false, skipped: "1 minute me ek backtest" }, { status: 429 });
      }
      await upsertAlerts([{ symbol: "__SOXLBT__", last_ts: now.toISOString(), last_score: 0 }]);
      const days = Math.min(400, Math.max(5, Number(new URL(req.url).searchParams.get("days") ?? 180)));
      return Response.json({ ok: true, mode, days, ...(await runSoxlBacktest(days)) });
    }
    if (mode === "unlocks") {
      // Din me ek-do baar kaafi hai; 1 ghante me ek se zyada nahi
      const lastU = await getState("__UNLOCKS__");
      if (lastU && now.getTime() - lastU.getTime() < 3_600_000) {
        return Response.json({ ok: false, skipped: "unlocks recently refreshed" }, { status: 429 });
      }
      await upsertAlerts([{ symbol: "__UNLOCKS__", last_ts: now.toISOString(), last_score: 0 }]);
      const res = await refreshUnlocks(now);
      console.log(JSON.stringify(res));
      return Response.json({ ok: true, mode, ...res });
    }
    // Guard: 45 second me ek hi run (koi bahar se baar baar call kare to bhi)
    const last = await getState("__LASTRUN__");
    if (last && now.getTime() - last.getTime() < 45_000) {
      return Response.json({ ok: false, skipped: "too soon" }, { status: 429 });
    }
    await upsertAlerts([{ symbol: "__LASTRUN__", last_ts: now.toISOString(), last_score: 0 }]);

    if (mode === "test") {
      await tg("✅ Delta scanner (Supabase, har 1 minute) connected! Alerts yahan aayenge.");
      return Response.json({ ok: true, mode });
    }
    const emaMode = CFG.SIGNAL_MODE === "ema";
    const soxlMode = CFG.SIGNAL_MODE === "soxl";
    const result: Record<string, unknown> = soxlMode ? await runSoxl(now) : emaMode ? await runEmaScan(now) : await runScan(now);

    // Roz ek baar summary (8 AM IST ke baad pehla run)
    const ist = istDate(now);
    if (!soxlMode && (mode === "summary" || ist.getUTCHours() >= CFG.SUMMARY_HOUR_IST)) {
      const lastSum = await getState("__SUMMARY__");
      if (mode === "summary" || !lastSum || istDay(lastSum) !== istDay(now)) {
        if (emaMode) await runEmaSummary(now); else await runSummary(now);
        await upsertAlerts([{ symbol: "__SUMMARY__", last_ts: now.toISOString(), last_score: 0 }]);
        result.summary = true;
      }
    }
    // Hafte me ek baar report (Sunday 8 PM IST ke baad pehla run)
    if (mode === "weekly" || (ist.getUTCDay() === CFG.WEEKLY_DOW_IST && ist.getUTCHours() >= CFG.WEEKLY_HOUR_IST)) {
      const lastW = await getState("__WEEKLY__");
      if (mode === "weekly" || !lastW || istDay(lastW) !== istDay(now)) {
        await weeklyReport(now);
        await upsertAlerts([{ symbol: "__WEEKLY__", last_ts: now.toISOString(), last_score: 0 }]);
        result.weekly = true;
      }
    }
    console.log(JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
