// Doosre exchanges ki current funding (sab %/8h me badal kar). Har exchange ka ek bulk call.
// Koi exchange block/fail ho to use chhod dete hain — baaki se kaam chalta hai.

export type XFund = Map<string, number>;           // base coin (jaise "LAB") -> funding %/8h
export type XAll = Record<string, XFund>;          // exchange -> map
export type XStatus = Record<string, string>;      // exchange -> "ok 523" / "err 403"

const UA = { "User-Agent": "delta-signal-scanner" };

// "1000PEPEUSDT" / "PEPE_USDT" / "PEPE-USDT-SWAP" / "1000PEPE" -> "PEPE"
export function baseOf(sym: string): string {
  let s = sym.toUpperCase().replace(/[-_]?USDT(M)?$/, "").replace(/-USDT-SWAP$/, "").replace(/[-_]$/, "");
  s = s.replace(/^(1000000|100000|10000|1000)(?=[A-Z])/, "");
  return s;
}

async function getJson(url: string, init: RequestInit = {}, ms = 6000) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(id); }
}

const put = (m: XFund, sym: string, pct8h: number) => {
  if (!Number.isFinite(pct8h)) return;
  const b = baseOf(sym);
  // ek coin ke kai contract ho to sabse bada rakho
  if (!m.has(b) || pct8h > (m.get(b) as number)) m.set(b, pct8h);
};

const FETCHERS: Record<string, () => Promise<XFund>> = {
  async bybit() {
    const j = await getJson("https://api.bybit.com/v5/market/tickers?category=linear");
    const m: XFund = new Map();
    for (const t of j?.result?.list ?? []) {
      if (!String(t.symbol).endsWith("USDT") || t.fundingRate === "") continue;
      const h = Number(t.fundingIntervalHour) || 8;
      put(m, t.symbol, Number(t.fundingRate) * 100 * (8 / h));
    }
    return m;
  },
  async binance() {
    const [pi, info] = await Promise.all([
      getJson("https://fapi.binance.com/fapi/v1/premiumIndex"),
      getJson("https://fapi.binance.com/fapi/v1/fundingInfo").catch(() => []),
    ]);
    const iv = new Map<string, number>((info ?? []).map((x: { symbol: string; fundingIntervalHours: number }) => [x.symbol, x.fundingIntervalHours]));
    const m: XFund = new Map();
    for (const t of pi ?? []) {
      if (!String(t.symbol).endsWith("USDT")) continue;
      put(m, t.symbol, Number(t.lastFundingRate) * 100 * (8 / (iv.get(t.symbol) || 8)));
    }
    return m;
  },
  async okx() {
    const j = await getJson("https://www.okx.com/api/v5/public/funding-rate?instId=ANY");
    const m: XFund = new Map();
    for (const t of j?.data ?? []) {
      if (!String(t.instId).endsWith("-USDT-SWAP")) continue;
      const h = t.nextFundingTime && t.fundingTime ? Math.max(1, (Number(t.nextFundingTime) - Number(t.fundingTime)) / 3.6e6) : 8;
      put(m, String(t.instId).replace("-USDT-SWAP", ""), Number(t.fundingRate) * 100 * (8 / h));
    }
    return m;
  },
  async bitget() {
    const j = await getJson("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES");
    const m: XFund = new Map();
    for (const t of j?.data ?? []) put(m, t.symbol, Number(t.fundingRate) * 100); // interval nahi milta: 8h maana
    return m;
  },
  async gate() {
    const j = await getJson("https://api.gateio.ws/api/v4/futures/usdt/contracts");
    const m: XFund = new Map();
    for (const t of j ?? []) {
      if (t.in_delisting) continue;
      const h = (Number(t.funding_interval) || 28800) / 3600;
      put(m, t.name, Number(t.funding_rate) * 100 * (8 / h));
    }
    return m;
  },
  async mexc() {
    const j = await getJson("https://contract.mexc.com/api/v1/contract/ticker");
    const m: XFund = new Map();
    for (const t of j?.data ?? []) if (String(t.symbol).endsWith("_USDT")) put(m, t.symbol, Number(t.fundingRate) * 100);
    return m;
  },
  async kucoin() {
    const j = await getJson("https://api-futures.kucoin.com/api/v1/contracts/active");
    const m: XFund = new Map();
    for (const t of j?.data ?? []) {
      if (t.quoteCurrency !== "USDT" || t.fundingFeeRate == null) continue;
      const h = (Number(t.fundingRateGranularity) || 28800000) / 3.6e6;
      const base = String(t.baseCurrency) === "XBT" ? "BTC" : String(t.baseCurrency);
      put(m, base, Number(t.fundingFeeRate) * 100 * (8 / h));
    }
    return m;
  },
  async hyperliquid() {
    const j = await getJson("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    });
    const m: XFund = new Map();
    const uni = j?.[0]?.universe ?? [], ctx = j?.[1] ?? [];
    uni.forEach((u: { name: string }, i: number) => put(m, u.name, Number(ctx[i]?.funding) * 100 * 8)); // hourly -> 8h
    return m;
  },
};

let CACHE: { at: number; all: XAll; status: XStatus } | null = null;

// 5 minute cache (edge instance zinda rahe to)
export async function fetchAllFunding(maxAgeMs = 5 * 60_000): Promise<{ all: XAll; status: XStatus }> {
  if (CACHE && Date.now() - CACHE.at < maxAgeMs) return CACHE;
  const all: XAll = {}, status: XStatus = {};
  await Promise.all(Object.entries(FETCHERS).map(async ([ex, fn]) => {
    try { const m = await fn(); all[ex] = m; status[ex] = `ok ${m.size}`; }
    catch (e) { status[ex] = `err ${String((e as Error).message ?? e).slice(0, 60)}`; }
  }));
  CACHE = { at: Date.now(), all, status };
  return CACHE;
}

// Ek coin ki saare exchanges par funding
export function fundingFor(all: XAll, base: string): Record<string, number> {
  const b = baseOf(base);
  const out: Record<string, number> = {};
  for (const [ex, m] of Object.entries(all)) if (m.has(b)) out[ex] = m.get(b) as number;
  return out;
}
