// SOXLBUSD strategy: Daily MACD trend + 5m Stochastic RSI entry, sirf US market time me.
// Pure functions (indicators, session, signal, backtest) — index.ts isse use karta hai.

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export const SOXL = {
  SYMBOL: "SOXLBUSD",
  MACD: [12, 26, 9] as const,
  STOCH: { rsi: 14, stoch: 14, k: 3, d: 3, upper: 80, lower: 20 },
  SWING_BARS: 10,          // SL: pichhli 10 candles (5m) ka swing high/low
  RR: 2,                   // TP = 2 x risk
  MIN_RISK_PCT: 0.15,      // isse chhota SL ho to skip (noise)
  MAX_RISK_PCT: 6,         // isse bada SL ho to skip
  MAX_TRADES_PER_DAY: 2,
  NO_ENTRY_LAST_MIN: 15,   // market band hone se 15 min pehle naya trade nahi
  FEE_PCT: 0.1,            // round trip
};

// ---------------------------------------------------------------- indicators
export function ema(v: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let e = v[0];
  for (let i = 0; i < v.length; i++) { e = i === 0 ? v[0] : v[i] * k + e * (1 - k); out.push(e); }
  return out;
}

export function macd(closes: number[], f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const signal = ema(line, sig);
  return { line, signal, hist: line.map((x, i) => x - signal[i]) };
}

// Wilder RSI
export function rsi(closes: number[], len = 14): number[] {
  const out = new Array(closes.length).fill(NaN);
  let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= len) {
      ag += g / len; al += l / len;
      if (i === len) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    } else {
      ag = (ag * (len - 1) + g) / len; al = (al * (len - 1) + l) / len;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}

const sma = (v: number[], len: number) => v.map((_, i) => {
  if (i < len - 1) return NaN;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += v[k];
  return s / len;
});

// Stochastic RSI (14,14,3,3) — K aur D 0..100
export function stochRsi(closes: number[], rsiLen = 14, stLen = 14, kLen = 3, dLen = 3) {
  const r = rsi(closes, rsiLen);
  const st = r.map((x, i) => {
    if (i < rsiLen + stLen - 1 || !Number.isFinite(x)) return NaN;
    let lo = Infinity, hi = -Infinity;
    for (let k = i - stLen + 1; k <= i; k++) { lo = Math.min(lo, r[k]); hi = Math.max(hi, r[k]); }
    return hi === lo ? 50 : ((x - lo) / (hi - lo)) * 100;
  });
  const k = sma(st.map((x) => (Number.isFinite(x) ? x : 0)), kLen).map((x, i) => (i < rsiLen + stLen + kLen - 2 ? NaN : x));
  const d = sma(k.map((x) => (Number.isFinite(x) ? x : 0)), dLen).map((x, i) => (i < rsiLen + stLen + kLen + dLen - 3 ? NaN : x));
  return { k, d };
}

// ---------------------------------------------------------------- US market session (NYSE)
const HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03",
  "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05",
  "2027-09-06", "2027-11-25", "2027-12-24",
]);
const EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]); // 1:00 PM band

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});

export function nyParts(tsSec: number) {
  const p: Record<string, string> = {};
  for (const x of nyFmt.formatToParts(new Date(tsSec * 1000))) p[x.type] = x.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    min: Number(p.hour) * 60 + Number(p.minute),
    weekday: p.weekday,
  };
}

// Is samay market khula hai? (open 9:30, close 16:00 ya early close 13:00)
export function session(tsSec: number) {
  const { date, min, weekday } = nyParts(tsSec);
  const closeMin = EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60;
  const tradingDay = weekday !== "Sat" && weekday !== "Sun" && !HOLIDAYS.has(date);
  return { date, min, tradingDay, open: tradingDay && min >= 9 * 60 + 30 && min < closeMin, closeMin };
}

// ---------------------------------------------------------------- daily trend
// Trend = pichhli PURI (band) daily candle par MACD line vs signal
export function dailyTrendAt(daily: Candle[], tsSec: number): { trend: 1 | -1 | 0; line: number; signal: number } {
  const closed = daily.filter((d) => d.time + 86400 <= tsSec);
  if (closed.length < 40) return { trend: 0, line: NaN, signal: NaN };
  const m = macd(closed.map((d) => d.close), ...SOXL.MACD);
  const i = closed.length - 1;
  return { trend: m.line[i] > m.signal[i] ? 1 : m.line[i] < m.signal[i] ? -1 : 0, line: m.line[i], signal: m.signal[i] };
}

// ---------------------------------------------------------------- 5m entry signal (index i band candle par)
export function entryAt(c5: Candle[], k: number[], d: number[], i: number, trend: 1 | -1) {
  if (i < 1 || !Number.isFinite(k[i]) || !Number.isFinite(d[i]) || !Number.isFinite(k[i - 1]) || !Number.isFinite(d[i - 1])) return null;
  const { upper, lower } = SOXL.STOCH;
  let hit = false;
  // SELL: price upar gaya (Stoch RSI 80 ke upar) aur K ne D ko neeche cross kiya
  if (trend === -1) hit = k[i - 1] >= d[i - 1] && k[i] < d[i] && Math.max(k[i - 1], d[i - 1]) >= upper;
  // BUY: price neeche gaya (Stoch RSI 20 ke neeche) aur K ne D ko upar cross kiya
  if (trend === 1) hit = k[i - 1] <= d[i - 1] && k[i] > d[i] && Math.min(k[i - 1], d[i - 1]) <= lower;
  if (!hit) return null;
  const entry = c5[i].close;
  let swing = trend === -1 ? -Infinity : Infinity;
  for (let j = Math.max(0, i - SOXL.SWING_BARS + 1); j <= i; j++) {
    swing = trend === -1 ? Math.max(swing, c5[j].high) : Math.min(swing, c5[j].low);
  }
  const risk = Math.abs(swing - entry);
  const riskPct = (risk / entry) * 100;
  if (riskPct < SOXL.MIN_RISK_PCT || riskPct > SOXL.MAX_RISK_PCT) return { skip: true as const, riskPct };
  const side = trend === 1 ? "long" as const : "short" as const;
  return {
    skip: false as const, side, entry, sl: swing,
    tp: entry + (trend === 1 ? 1 : -1) * SOXL.RR * risk,
    riskPct, k: k[i], d: d[i],
  };
}

// ---------------------------------------------------------------- backtest
export type BtTrade = {
  date: string; time: number; side: "long" | "short"; entry: number; sl: number; tp: number;
  exit: number; reason: "tp" | "sl" | "eod"; r: number; pnlPct: number; riskPct: number;
};

export function backtest(c5: Candle[], daily: Candle[]) {
  const closes = c5.map((c) => c.close);
  const { k, d } = stochRsi(closes, SOXL.STOCH.rsi, SOXL.STOCH.stoch, SOXL.STOCH.k, SOXL.STOCH.d);
  const trades: BtTrade[] = [];
  const perDay = new Map<string, number>();
  let skipped = 0;
  for (let i = 30; i < c5.length - 1; i++) {
    const closeT = c5[i].time + 300;                // signal candle band hone ka samay
    const s = session(closeT - 1);
    if (!s.open || s.min > s.closeMin - SOXL.NO_ENTRY_LAST_MIN) continue;
    if ((perDay.get(s.date) ?? 0) >= SOXL.MAX_TRADES_PER_DAY) continue;
    const tr = dailyTrendAt(daily, closeT);
    if (tr.trend === 0) continue;
    const e = entryAt(c5, k, d, i, tr.trend);
    if (!e) continue;
    if (e.skip) { skipped++; continue; }
    perDay.set(s.date, (perDay.get(s.date) ?? 0) + 1);
    const dir = e.side === "long" ? 1 : -1;
    let exit = NaN, reason: BtTrade["reason"] = "eod", j = i + 1;
    for (; j < c5.length; j++) {
      const sj = session(c5[j].time);
      if (sj.date !== s.date || !sj.open) { exit = c5[j - 1].close; reason = "eod"; break; }
      const hitSL = dir > 0 ? c5[j].low <= e.sl : c5[j].high >= e.sl;
      const hitTP = dir > 0 ? c5[j].high >= e.tp : c5[j].low <= e.tp;
      if (hitSL) { exit = e.sl; reason = "sl"; break; }          // dono ek candle me: SL maano (safe)
      if (hitTP) { exit = e.tp; reason = "tp"; break; }
    }
    if (!Number.isFinite(exit)) { exit = c5[c5.length - 1].close; }
    const pnlPct = dir * ((exit / e.entry - 1) * 100) - SOXL.FEE_PCT;
    trades.push({
      date: s.date, time: c5[i].time, side: e.side, entry: e.entry, sl: e.sl, tp: e.tp, exit, reason,
      r: pnlPct / e.riskPct, pnlPct, riskPct: e.riskPct,
    });
    i = j; // ek waqt me ek hi trade
  }
  return { trades, skipped, summary: summarize(trades) };
}

export function summarize(t: BtTrade[]) {
  const n = t.length;
  if (!n) return { n: 0 };
  const wins = t.filter((x) => x.r > 0).length;
  const sumR = t.reduce((a, x) => a + x.r, 0);
  const sumPct = t.reduce((a, x) => a + x.pnlPct, 0);
  const mean = sumR / n;
  const sd = Math.sqrt(t.reduce((a, x) => a + (x.r - mean) ** 2, 0) / n);
  let peak = 0, eq = 0, maxDD = 0;
  for (const x of t) { eq += x.r; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); }
  const by = (f: (x: BtTrade) => string) => {
    const g: Record<string, { n: number; win: number; r: number }> = {};
    for (const x of t) { const key = f(x); g[key] ??= { n: 0, win: 0, r: 0 }; g[key].n++; if (x.r > 0) g[key].win++; g[key].r += x.r; }
    return Object.fromEntries(Object.entries(g).map(([kk, v]) => [kk, { n: v.n, winPct: Math.round(v.win / v.n * 100), avgR: +(v.r / v.n).toFixed(2), totalR: +v.r.toFixed(1) }]));
  };
  return {
    n, winPct: Math.round(wins / n * 100), avgR: +mean.toFixed(3), ci95: +(1.96 * sd / Math.sqrt(n)).toFixed(3),
    totalR: +sumR.toFixed(1), totalPct: +sumPct.toFixed(1), maxDrawdownR: +maxDD.toFixed(1),
    first: t[0].date, last: t[n - 1].date,
    bySide: by((x) => x.side), byExit: by((x) => x.reason), byMonth: by((x) => x.date.slice(0, 7)),
  };
}
