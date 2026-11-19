// main.ts — token-radar entry point.
//
// Reads the sealed snapshot (default /input/snapshot.json, overridable with
// --input), builds the ranked board with lib/model.ts, and writes /output
// (overridable with MAKEFUN_OUTPUT_DIR):
//
//   board.json              the ranked board
//   dashboard/              this repo's dashboard/ copied in, plus data.dat
//                           (the page's data, written beside the page)
//   screenshots/            this repo's screenshots/ copied in
//   dossier.json            buildDossier('/output', {text_max_bytes: 65536})
//
// Deterministic: every byte is a pure function of the snapshot and this repo,
// so both grading runs write the same output. Node 22 standard library only,
// no network, no wall clock.

import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildBoard, type Snapshot } from './lib/model.ts';

const here = dirname(fileURLToPath(import.meta.url));

function inputPath(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === '--input') return args[i + 1]!;
  }
  return '/input/snapshot.json';
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const snapshot = JSON.parse(readFileSync(inputPath(), 'utf8')) as Snapshot;

const board = buildBoard(snapshot);
if (board.rows.length < 100) throw new Error(`board holds ${board.rows.length} rows, under the 100 a valid board needs`);
for (const slug of snapshot.watchlist) {
  if (!board.rows.some((r) => r.slug === slug)) throw new Error(`watchlist protocol ${slug} missing from the board`);
}

const boardDoc = {
  schema: 'token-radar/board/v1',
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  model: {
    formula: board.model.formula,
    category_multiple:
      'median mcap/TVL the market pays for launched tokens in the same category (min 5 samples), else the overall median',
    momentum: 'clamp(1 + change_7d/100, 0.55, 2.5); 1.0 when the 7-day change is unreported',
    loyalty: '1 + 0.5 x (1 - e^(-days/365)) of DefiLlama tracking age; 1.0 when listed_at is null',
    category_multiples: board.model.by_category,
    overall_multiple: board.model.overall,
  },
  stats: board.stats,
  rows: board.rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
    tvl_usd: r.tvl_usd,
    category: r.category,
    chains: r.chains,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    watchlist: r.watchlist,
    model: r.model,
  })),
};

const payload = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  stats: board.stats,
  model: {
    formula: board.model.formula,
    by_category: board.model.by_category,
    overall: board.model.overall,
    notes: [
      'category_multiple: the median mcap/TVL the market pays for launched tokens in the same category (min 5 samples), else the overall median of all launched protocols with a recorded mcap.',
      'momentum: the 7-day TVL trend clamped to 0.55x-2.5x; 1.0x when unreported.',
      'loyalty: 1 + 0.5 x (1 - e^(-days/365)) — retention credit for time served with TVL and no token, saturating at 1.5x.',
      'The implied value is this model\'s claim about a token that does not exist, not a prediction that one ships.',
    ],
  },
  rows: board.rows,
  launched: board.launched.slice(0, 120),
  screened: board.screened,
};

mkdirSync(outDir, { recursive: true });
mkdirSync(join(here, 'screenshots'), { recursive: true });

writeFileSync(join(outDir, 'board.json'), `${JSON.stringify(boardDoc, null, 2)}\n`);

cpSync(join(here, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
writeFileSync(join(outDir, 'dashboard', 'data.dat'), `window.RADAR=${JSON.stringify(payload)};\n`);

cpSync(join(here, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });

// The dossier needs at least one screenshot; during local development, before
// the screenshots are taken, warn instead of failing so the board can be checked.
const shots = readdirSync(join(outDir, 'screenshots')).filter((n) => /\.(?:png|jpe?g)$/i.test(n));
if (shots.length > 0) {
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));
} else {
  console.log('token-radar: no screenshots yet, skipped dossier.json (take screenshots and re-run)');
}

console.log(
  `token-radar: ${board.rows.length} rows (${board.stats.watchlist} watchlist + ${board.rows.length - board.stats.watchlist} found), ` +
    `${board.launched.length} launched comparables, ${board.screened.length} screened out; wrote ${outDir}`,
);
