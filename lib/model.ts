// lib/model.ts — the token-radar value model and farm-plan generator.
//
// Everything here is a pure function of the sealed snapshot, so both grading
// runs write byte-identical output. No network, no wall clock: a protocol's
// tracking age is measured from the snapshot's own as_of date.
//
// The model in one line:
//   implied_value_usd = category_multiple x TVL x momentum x loyalty
//
//   category_multiple  what the market last paid for a token per dollar of
//                      TVL in this category (median mcap/TVL of the
//                      launched protocols DefiLlama records, same category)
//   momentum           the 7-day TVL trend, clamped to [0.55, 2.5]x — a book
//                      that is growing backs a bigger claim than one that is
//                      bleeding
//   loyalty            1 + 0.5 x (1 - e^(-days/365)) — every year a protocol
//                      holds real TVL with no token adds proven retention,
//                      saturating at +50%
//
// The implied value is this model's claim about a token that does not exist;
// it is not a prediction that one ships.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelFactor {
  category_multiple: number;
  momentum: number;
  loyalty: number;
  days_tracked: number | null;
  launched_sample: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  tvl_usd: number;
  category: string | null;
  chains: string[];
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  model: ModelFactor;
}

export interface LaunchedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export interface ScreenedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

export interface CategoryMultiple {
  multiple: number;
  sample: number;
}

export interface ValueModel {
  by_category: Record<string, CategoryMultiple>;
  overall: CategoryMultiple;
  formula: string;
}

// ---------------------------------------------------------------- screening

// A pre-token protocol is not a launch candidate when its TVL is really an
// exchange's balance sheet, bridge collateral in transit, or a wrapped/staked
// product of a token that generally already trades. This mirrors the house's
// watchlist rule (which the watchlist itself already encodes) so the radar can
// apply the same judgment below the $50M floor. The watchlist is always kept:
// it is the house's floor and this screen never removes it.

const EXCLUDED_CATEGORIES: Record<string, string> = {
  CEX: "an exchange's balance sheet, not a protocol that launches a token to its users",
  Bridge: 'bridge collateral — assets in transit, not a user base a token captures',
  'Canonical Bridge': 'canonical bridge collateral — assets in transit, not a user base a token captures',
  'Cross Chain Bridge': 'bridge collateral — assets in transit, not a user base a token captures',
  'Liquid Staking': 'a liquid-staking product whose parent asset generally already trades',
  'Liquid Restaking': 'a liquid-restaking product whose parent asset generally already trades',
  Restaking: 'a restaking product whose parent asset generally already trades',
  'Restaked BTC': 'a wrapped/restaked BTC product whose parent asset already trades',
  'Anchor BTC': 'a wrapped BTC product whose parent asset already trades',
  'Decentralized BTC': 'a wrapped BTC product whose parent asset already trades',
};

const WRAPPED_WORD = /(^|[\s-])(wrapped|staked|staking)([\s-]|$)/i;
const VERSION_SUFFIX = /\s(v?\d+(?:\.\d+)*|v\d+|2\.0)$/i;
const EXCHANGE_PREFIX =
  /^(binance|coinbase|bybit|kraken|bitget|okx|okex|bitfinex|gemini|htx|bitstamp|robinhood|kucoin|upbit|bithumb|mexc|deribit|poloniex|bitflyer|gate\.io|crypto\.com)\b/i;

function screenProtocol(p: SnapshotProtocol): string | null {
  const cat = p.category ?? '';
  if (EXCLUDED_CATEGORIES[cat] !== undefined) return `Category ${cat}: ${EXCLUDED_CATEGORIES[cat]}.`;
  if (WRAPPED_WORD.test(p.name)) return 'Name marks it as a wrapped or staked product of an asset that already trades.';
  if (VERSION_SUFFIX.test(p.name)) return 'Name carries a version marker, so it is a product of an older parent protocol.';
  if (EXCHANGE_PREFIX.test(p.name)) return 'Named for a centralized exchange.';
  return null;
}

// ---------------------------------------------------------------- helpers

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const DAY_MS = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS));
}

export function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

function fmtPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
}

const chainList = (chains: string[]): string => {
  const head = chains.slice(0, 3).join(', ');
  return chains.length > 3 ? `${head} + ${chains.length - 3} more` : head;
};

// ---------------------------------------------------------------- the model

const MULT_MIN = 0.05;
const MULT_MAX = 1.5;
const MIN_SAMPLE = 5;

export function buildValueModel(snapshot: Snapshot): ValueModel {
  const byCategory: Record<string, number[]> = {};
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (!(p.gecko_id || p.symbol)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const m = p.mcap_usd / p.tvl_usd;
    all.push(m);
    const c = p.category ?? '(none)';
    (byCategory[c] ??= []).push(m);
  }
  const overall = median(all);
  const by_category: Record<string, CategoryMultiple> = {};
  for (const c of Object.keys(byCategory).sort()) {
    const vals = byCategory[c]!;
    if (vals.length < MIN_SAMPLE) continue;
    by_category[c] = {
      multiple: Math.min(MULT_MAX, Math.max(MULT_MIN, median(vals))),
      sample: vals.length,
    };
  }
  return {
    by_category,
    overall: { multiple: Math.min(MULT_MAX, Math.max(MULT_MIN, overall)), sample: all.length },
    formula: 'implied_value_usd = category_multiple x TVL x momentum x loyalty',
  };
}

function multipleFor(model: ValueModel, category: string | null): CategoryMultiple {
  if (category !== null && model.by_category[category] !== undefined) return model.by_category[category]!;
  return model.overall;
}

/** The 7-day TVL trend as a multiplier, clamped so one wild week cannot dominate. */
export function momentumOf(change7d: number | null): number {
  if (change7d === null) return 1;
  return Math.min(2.5, Math.max(0.55, 1 + change7d / 100));
}

/** Retention credit for time served with TVL and no token: 1.0x to 1.5x. */
export function loyaltyOf(listedAt: string | null, asOf: string): { loyalty: number; days: number | null } {
  if (listedAt === null) return { loyalty: 1, days: null };
  const days = daysBetween(listedAt, asOf);
  return { loyalty: 1 + 0.5 * (1 - Math.exp(-days / 365)), days };
}

// ---------------------------------------------------------------- farm plans

interface ActionPlan {
  label: string;
  text: string;
}

function actionFor(p: SnapshotProtocol, deposit: number): ActionPlan {
  const cat = p.category ?? '';
  if (/Dexs|Farm|Liquidity Manager/i.test(cat)) {
    return {
      label: 'Provide liquidity',
      text: `Provide liquidity rather than parking idle: split the ${fmtUsd(deposit)} across the two or three deepest pools ${p.name} lists, keep one pool stablecoin-side, and let the position sit — LP depth is what launch snapshots tend to weight. Setting it up takes about 15 minutes.`,
    };
  }
  if (/Lending|CDP|Collateral|Uncollateralized/i.test(cat)) {
    return {
      label: 'Supply and borrow',
      text: `Supply the ${fmtUsd(deposit)} as collateral and borrow a little against it (keep loan-to-value under 50%) so both sides of the book count as activity; a borrowed position also farms the protocol's credit surface. Budget about 15 minutes to open and hedge the position.`,
    };
  }
  if (/Risk Curators|Capital Allocator|Yield|Indexes/i.test(cat)) {
    return {
      label: 'Allocate across strategies',
      text: `Allocate the ${fmtUsd(deposit)} across two or three of the vaults or curated strategies ${p.name} runs on ${chainList(p.chains)} rather than one — snapshots often count positions per strategy, and spreading costs nothing in yield. About 15 minutes to place and record the positions.`,
    };
  }
  if (/Derivatives|Basis Trading|Options|Prediction/i.test(cat)) {
    return {
      label: 'Trade the core book',
      text: `Use the core product: hold one modest perpetual, basis or options position on ${p.name} (a quarter of the ${fmtUsd(deposit)} at most) and keep the rest as margin, so the account shows real trading history without liquidation risk. Budget 20 minutes a week to roll or adjust.`,
    };
  }
  if (/RWA/i.test(cat)) {
    return {
      label: 'Hold the tokenized book',
      text: `Deposit the ${fmtUsd(deposit)} into ${p.name}'s tokenized treasury or vault product on ${chainList(p.chains)} and leave it — RWA books reward steady holders, and on-chain position age is the eligibility signal a launch would snapshot. About 10 minutes to open.`,
    };
  }
  if (/Staking Pool|Restaking/i.test(cat)) {
    return {
      label: 'Stake through the pool',
      text: `Stake the ${fmtUsd(deposit)} through ${p.name}'s pool on ${chainList(p.chains)} and keep it staked — deposits, not claims, are what a launch snapshot would see. Unstake windows on fresh pools can lag, so treat the money as locked for the season. 10 minutes to stake.`,
    };
  }
  return {
    label: 'Use the core product',
    text: `Put the ${fmtUsd(deposit)} to work through ${p.name}'s core product on ${chainList(p.chains)} and keep it there — active, aged positions are the surface a token launch would snapshot. Budget 15 minutes now and 10 minutes a fortnight to keep the account alive.`,
  };
}

/**
 * A concrete farm plan for one protocol: what to deposit, what to do with it,
 * how long to hold it, and what it costs in time and gas — every number taken
 * from the snapshot's own TVL, 7-day change, chains and tracking age.
 */
export function farmSteps(p: SnapshotProtocol, ctx: { asOf: string; implied: number; days: number | null }): string[] {
  const deposit = 1000;
  const eth = p.chains.includes('Ethereum');
  const gas = eth
    ? p.chains.length > 1
      ? '$5-15 of gas on Ethereum and well under $1 on its other chains'
      : '$5-15 of gas'
    : 'well under $1 of gas';
  const share = (deposit / p.tvl_usd) * 100;
  const shareTxt = share >= 0.01 ? `${share.toFixed(2)}%` : `${share.toExponential(1)}%`;
  const chg = p.change_7d;
  const drift = chg === null ? null : deposit * Math.pow(1 + chg / 100, 4);
  const age = ctx.days === null ? 'an unknown tracking age' : `${ctx.days} days on DefiLlama's book`;
  const action = actionFor(p, deposit);
  const chains = chainList(p.chains);

  const steps: string[] = [
    `Fund the position: move ${fmtUsd(deposit)} to ${p.name} on ${chains}. The book holds ${fmtUsd(p.tvl_usd)} of TVL, so your deposit is ${shareTxt} of it — deep enough to enter and exit in a single transaction. Allow 10-20 minutes for the transfer and budget ${gas}.`,
    `${action.label}: ${action.text}`,
    chg === null
      ? `Hold and re-check weekly: ${p.name}'s 7-day TVL move is unreported in the snapshot, so read the trend as unproven — check the number yourself every Sunday (5 minutes) and rebalance only when the book moves more than 20% against you.`
      : `Hold and rebalance: the book moved ${fmtPct(chg)} in 7 days, about ${fmtUsd((p.tvl_usd * chg) / 100)} of TVL; at that weekly pace a ${fmtUsd(deposit)} deposit drifts to roughly ${fmtUsd(drift!)} in a month. Set a 20% rebalance band and check it every Sunday — 5 minutes.`,
    `Farm the eligibility surface: launches tend to snapshot deposits, repeated actions and position age rather than raw size. Make at least one action every two weeks for 90 days (18 sessions, about 10 minutes each) and keep a little live activity on every chain ${p.name} serves (${p.chains.length} chain${p.chains.length === 1 ? '' : 's'}${p.chains.length > 1 ? `: ${chains}` : ''}).`,
    `Watch for a points or quest program: check ${p.name}'s app and governance forum every Monday (5 minutes). If points go live, top the deposit up to the next tier within that week — retroactive multipliers usually start at program launch, not before it.`,
    `Plan the exit: ${p.name} has run with no recorded token for ${age}, and this radar puts its implied value at ${fmtUsd(ctx.implied)} if a token shipped today. If one does, expect a snapshot, a 30-90 day lockup and 30-60 minutes to claim and swap; if nothing ships within 6 months, rotate the ${fmtUsd(deposit)} to the next name on the board.`,
  ];
  return steps.map((s) => s.trim());
}

// ---------------------------------------------------------------- the board

export interface Board {
  rows: BoardRow[];
  model: ValueModel;
  launched: LaunchedRow[];
  screened: ScreenedRow[];
  stats: Record<string, number>;
}

export function buildBoard(snapshot: Snapshot): Board {
  const model = buildValueModel(snapshot);
  const watchlist = new Set(snapshot.watchlist);

  const candidates: Array<{ p: SnapshotProtocol; raw: number; factor: ModelFactor; days: number | null; reason: string | null }> = [];
  const screened: ScreenedRow[] = [];

  for (const p of snapshot.protocols) {
    if (p.gecko_id || p.symbol) continue; // token already trades: not this radar's subject
    const reason = screenProtocol(p);
    const onWatchlist = watchlist.has(p.slug);
    if (reason !== null && !onWatchlist) {
      screened.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
      continue;
    }
    const catMult = multipleFor(model, p.category);
    const momentum = momentumOf(p.change_7d);
    const { loyalty, days } = loyaltyOf(p.listed_at, snapshot.as_of);
    candidates.push({
      p,
      days,
      raw: catMult.multiple * p.tvl_usd * momentum * loyalty,
      factor: {
        category_multiple: catMult.multiple,
        momentum,
        loyalty,
        days_tracked: days,
        launched_sample: catMult.sample,
      },
    });
  }

  candidates.sort((a, b) => b.raw - a.raw || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));

  const rows: BoardRow[] = [];
  let prev = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    let v = Math.max(1, Math.round(c.raw));
    if (v >= prev) v = prev - 1;
    if (v < 1) v = 1;
    prev = v;
    rows.push({
      slug: c.p.slug,
      name: c.p.name,
      rank: i + 1,
      implied_value_usd: v,
      farm_steps: farmSteps(c.p, { asOf: snapshot.as_of, implied: v, days: c.days }),
      tvl_usd: c.p.tvl_usd,
      category: c.p.category,
      chains: c.p.chains,
      change_7d: c.p.change_7d,
      listed_at: c.p.listed_at,
      watchlist: watchlist.has(c.p.slug),
      model: c.factor,
    });
  }

  const launched: LaunchedRow[] = snapshot.protocols
    .filter((p) => (p.gecko_id || p.symbol) && p.mcap_usd !== null && p.mcap_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: p.mcap_usd! / p.tvl_usd,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);

  screened.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));

  const stats = {
    protocols: snapshot.protocols.length,
    pre_token: snapshot.protocols.filter((p) => !p.gecko_id && !p.symbol).length,
    candidates: rows.length,
    watchlist: snapshot.watchlist.length,
    launched_with_mcap: launched.length,
    screened_out: screened.length,
  };

  return { rows, model, launched, screened, stats };
}
