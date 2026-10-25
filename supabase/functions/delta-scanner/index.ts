// Delta Exchange Signal Scanner — Supabase Edge Function
// pg_cron har 1 minute call karta hai. Har call par:
//   1. Delta public API se saare perpetual futures (API key nahi chahiye)
//   2. Har 5 minute ek snapshot Supabase me save
//   3. Signals: Funding extreme, OI vs Price (6h), Liquidation zones (andaza), Token unlock
//   4. Score >= MIN_SCORE -> Telegram alert (har coin par cooldown)
//   5. Roz ~8 AM IST summary
// Sirf data/alert. Trade ka faisla user ka.

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
async function fetchTickers(): Promise<Ticker[]> {
  const r = await fetch(CFG.DELTA_URL, { headers: { "User-Agent": "delta-signal-scanner" } });
  if (!r.ok) throw new Error(`Delta API ${r.status}`);
  const j = await r.json();
  const out: Ticker[] = [];
  for (const t of j.result ?? []) {
    if (t.contract_type !== "perpetual_futures") continue;
    const sym = String(t.symbol ?? "");
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

function alertBlock(cur: Ticker, sigs: Sig[]) {
  const bias = sigs.reduce((a, s) => a + s.bias, 0);
  const head = bias < 0 ? "🔻 Neeche ka risk" : bias > 0 ? "🔺 Upar ka risk" : "⚖️ Mixed";
  const link = `https://www.delta.exchange/app/futures/trade/${cur.underlying}/${cur.symbol}`;
  return [
    `⚠️ <b><a href="${link}">${esc(cur.symbol)}</a></b> — Score ${sigs.length}/4 · ${head}`,
    `Price $${fmtPrice(cur.mark_price)} (${sign(cur.change_24h)}% 24h) · OI ${fmtUsd(cur.oi_usd)} · Vol ${fmtUsd(cur.volume_usd)}`,
    ...sigs.map((s) => `• <i>${s.name}:</i> ${s.text}`),
  ].join("\n");
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

async function runScan(now: Date) {
  const { tickers, stats, unlocks } = await loadCommon();
  const today = istDay(now);
  const prevRows = await sb("delta_alerts?select=symbol,last_ts,last_score");
  const prev = new Map<string, { ts: number; score: number }>();
  for (const r of prevRows ?? []) prev.set(r.symbol, { ts: Date.parse(r.last_ts), score: num(r.last_score) });

  const blocks: { score: number; vol: number; text: string }[] = [];
  const sent: { symbol: string; last_ts: string; last_score: number }[] = [];
  for (const cur of tickers) {
    const st = stats.get(cur.symbol);
    const sigs = [sigFunding(cur, st), sigOiPrice(cur, st), sigLiq(cur, st), sigUnlock(cur, unlocks, today)]
      .filter((s): s is Sig => s !== null);
    if (sigs.length < CFG.MIN_SCORE) continue;
    const p = prev.get(cur.symbol);
    if (p && (now.getTime() - p.ts) / 3_600_000 < CFG.COOLDOWN_H && sigs.length <= p.score) continue;
    blocks.push({ score: sigs.length, vol: cur.volume_usd, text: alertBlock(cur, sigs) });
    sent.push({ symbol: cur.symbol, last_ts: now.toISOString(), last_score: sigs.length });
  }
  if (blocks.length) {
    blocks.sort((a, b) => b.score - a.score || b.vol - a.vol);
    await tg(`📡 <b>Delta Signals</b> · ${istStr(now)}\n\n` + blocks.map((b) => b.text).join("\n\n") +
      "\n\n<i>Sirf data hai, trade ka faisla aapka. Stop-loss zaroor lagayein.</i>");
    await upsertAlerts(sent);
  }
  const saved = await maybeSave(now, tickers);
  return { coins: tickers.length, alerts: blocks.length, saved };
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

Deno.serve(async (req) => {
  const now = new Date();
  const mode = new URL(req.url).searchParams.get("mode") ?? "scan";
  try {
    if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
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
    const result: Record<string, unknown> = await runScan(now);

    // Roz ek baar summary (8 AM IST ke baad pehla run)
    const ist = istDate(now);
    if (mode === "summary" || ist.getUTCHours() >= CFG.SUMMARY_HOUR_IST) {
      const lastSum = await getState("__SUMMARY__");
      if (mode === "summary" || !lastSum || istDay(lastSum) !== istDay(now)) {
        await runSummary(now);
        await upsertAlerts([{ symbol: "__SUMMARY__", last_ts: now.toISOString(), last_score: 0 }]);
        result.summary = true;
      }
    }
    console.log(JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
