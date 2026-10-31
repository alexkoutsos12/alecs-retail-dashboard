import { NikeSku, SizeRun } from "./parsers/parseNikeStock";

/**
 * Nike Order Builder engine.
 *
 * Matches a Nike.net order form against the historical stock-status analysis
 * imported into the Planner and recommends a per-size buy quantity.
 *
 * Model (all driven by the imported stock status, so it's fully adaptive):
 *   - Each franchise + size run gets a conviction tier and a recommended
 *     colorway count from how it sold.
 *   - The total units to buy for a family = historical units sold, adjusted
 *     by sell-through. That total is split across however many colorways the
 *     buyer keeps (keep fewer -> each is deeper), then distributed across a
 *     smoothed size-sell curve, then split across the delivery dates.
 */

export function matchKey(name: string): string {
  const n = name.toLowerCase();
  if (/air force 1|force 1|af1/.test(n)) return "air force 1";
  if (/court bor/.test(n)) return "court borough";
  if (/air max 270/.test(n)) return "air max 270";
  if (/air max 90/.test(n)) return "air max 90";
  if (/air max nova/.test(n)) return "air max nova";
  // Other Air Max models match only by exact name (fall through), so a model
  // we don't carry (Chroma, Invigor, …) isn't lumped into a generic bucket.
  if (/dunk/.test(n)) return "dunk";
  if (/kawa/.test(n)) return "kawa";
  if (/cosmic/.test(n)) return "cosmic runner";
  if (/star runner/.test(n)) return "star runner";
  if (/flex/.test(n)) return "flex";
  if (/team hustle/.test(n)) return "team hustle";
  if (/pegasus/.test(n)) return "pegasus";
  if (/vomero/.test(n)) return "vomero";
  if (/winflo/.test(n)) return "winflo";
  if (/revolution/.test(n)) return "revolution";
  if (/free/.test(n)) return "free";
  if (/blazer/.test(n)) return "blazer";
  if (/tanjun/.test(n)) return "tanjun";
  if (/giann|freak/.test(n)) return "giannis";
  if (/lebron|witness/.test(n)) return "lebron witness";
  if (/dynamite|\bs\.\s?t\.?/.test(n)) return "st"; // Nike S.T. (dots required)
  if (/hu?a?rache/.test(n)) return "huarache";
  if (/tennis classic/.test(n)) return "tennis classic";
  if (/waffle/.test(n)) return "waffle";
  if (/isofly/.test(n)) return "isofly";
  return n.replace(/\s+/g, " ").trim();
}

export function ageToRun(age: string): SizeRun {
  const a = age.toLowerCase();
  if (a.includes("toddler")) return "Toddler";
  if (a.includes("pre")) return "Little Kid";
  if (a.includes("grade")) return "Big Kid";
  return "Other";
}

export function sizeToCode(size: string): number {
  const m = size.match(/([\d.]+)/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * 10);
}

export function runKey(franchise: string, run: SizeRun): string {
  return `${matchKey(franchise)}::${run}`;
}

export interface FamilyRunStats {
  name: string; // representative canonical family name (for display)
  soldByCode: Map<number, number>;
  totalSold: number;
  totalOnHand: number;
  colorways: number;
  sellThrough: number;
}

export interface History {
  families: Map<string, FamilyRunStats>;
  // Normalized size-sell share by code, per run — used to smooth thin curves.
  runCurves: Map<SizeRun, Map<number, number>>;
}

export function buildHistory(skus: NikeSku[]): History {
  const families = new Map<string, FamilyRunStats>();
  const runTotals = new Map<SizeRun, Map<number, number>>();

  for (const k of skus) {
    const key = `${matchKey(k.styleFamily)}::${k.run}`;
    let st = families.get(key);
    if (!st) {
      st = {
        name: k.styleFamily,
        soldByCode: new Map(),
        totalSold: 0,
        totalOnHand: 0,
        colorways: 0,
        sellThrough: 0,
      };
      families.set(key, st);
    }
    st.colorways += 1;
    let rt = runTotals.get(k.run);
    if (!rt) {
      rt = new Map();
      runTotals.set(k.run, rt);
    }
    for (const s of k.sizes) {
      st.soldByCode.set(s.code, (st.soldByCode.get(s.code) ?? 0) + s.sold);
      st.totalSold += s.sold;
      st.totalOnHand += s.onHand;
      rt.set(s.code, (rt.get(s.code) ?? 0) + s.sold);
    }
  }
  for (const st of families.values()) {
    st.sellThrough =
      st.totalSold + st.totalOnHand > 0
        ? st.totalSold / (st.totalSold + st.totalOnHand)
        : 0;
  }

  const runCurves = new Map<SizeRun, Map<number, number>>();
  for (const [run, rt] of runTotals) {
    const total = [...rt.values()].reduce((a, b) => a + b, 0);
    const share = new Map<number, number>();
    if (total > 0)
      for (const [code, v] of rt) share.set(code, v / total);
    runCurves.set(run, share);
  }

  return { families, runCurves };
}

// ─── Guidance (conviction + recommended colorways) ────────────────────────────

export type Conviction = "high" | "ask" | "skip";

export interface FamilyGuide {
  conviction: Conviction;
  recommendedColorways: number;
  familyBuyUnits: number;
}

/** Total units we'd buy for a family next season from its history. */
function familyBuyUnits(st: FamilyRunStats): number {
  return Math.round(st.totalSold * (0.75 + 0.5 * st.sellThrough));
}

export function familyGuide(
  franchise: string,
  run: SizeRun,
  history: History,
  baseline: number
): FamilyGuide {
  const st = history.families.get(runKey(franchise, run));
  if (!st || st.totalSold === 0) {
    return { conviction: "ask", recommendedColorways: 0, familyBuyUnits: 0 };
  }
  const units = familyBuyUnits(st);
  const rec = Math.max(1, Math.round(units / Math.max(1, baseline)));
  let conviction: Conviction;
  if (st.sellThrough >= 0.45 && st.totalSold >= 10) conviction = "high";
  else if (st.sellThrough < 0.25) conviction = "skip";
  else conviction = "ask";
  return { conviction, recommendedColorways: rec, familyBuyUnits: units };
}

// ─── Recommend ────────────────────────────────────────────────────────────────

export interface OrderRow {
  r0: number;
  styleColor: string;
  productName: string;
  franchise: string;
  age: string;
  size: string;
  code: number;
  run: SizeRun;
  wholesale: number;
  retail: number;
}

export interface RowRec {
  r0: number;
  qty: number;
  split: [number, number, number];
}

export interface StyleRec {
  styleColor: string;
  productName: string;
  franchise: string;
  run: SizeRun;
  matched: boolean;
  matchedName: string; // history family it was sized from ("" when none)
  depth: number;
  pairs: number;
  wholesaleTotal: number;
  retailTotal: number;
  sizes: { size: string; qty: number }[];
}

export interface RecommendResult {
  rows: Map<number, RowRec>;
  styles: StyleRec[];
}

export type DeliveryWeights = [number, number, number];

function splitWeighted(qty: number, w: DeliveryWeights): [number, number, number] {
  const a = Math.round(qty * w[0]);
  const b = Math.round(qty * w[1]);
  const c = qty - a - b;
  return [a, b, Math.max(0, c)];
}

const SMOOTH_ALPHA = 10; // pseudo-units blended toward the run curve

interface RawQty {
  r0: number;
  styleColor: string;
  size: string;
  qty: number;
  wholesale: number;
  retail: number;
}
interface StyleMeta {
  productName: string;
  franchise: string;
  run: SizeRun;
  matched: boolean;
  matchedName: string;
  depth: number;
}

/**
 * Recommend per-size buy quantities.
 *
 * `baseline` is the fallback depth for a kept-but-new franchise. `weights`
 * spreads each size across the three deliveries. `budget`, when > 0, caps the
 * total pairs — if the demand-driven buy exceeds it, every quantity is scaled
 * down proportionally so the performance emphasis is preserved.
 */
export function recommend(
  orderRows: OrderRow[],
  history: History,
  baseline: number,
  weights: DeliveryWeights = [1 / 3, 1 / 3, 1 / 3],
  budget = 0
): RecommendResult {
  const byFamily = new Map<string, OrderRow[]>();
  for (const row of orderRows) {
    const key = runKey(row.franchise, row.run);
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key)!.push(row);
  }

  const raws: RawQty[] = [];
  const meta = new Map<string, StyleMeta>();

  for (const [, famRows] of byFamily) {
    const key = runKey(famRows[0].franchise, famRows[0].run);
    const st = history.families.get(key);
    const first = famRows[0];
    const runCurve = history.runCurves.get(first.run) ?? new Map();
    const hasHistory = !!st && st.totalSold > 0;

    if (!hasHistory && runCurve.size === 0) {
      for (const row of famRows)
        if (!meta.has(row.styleColor))
          meta.set(row.styleColor, {
            productName: row.productName,
            franchise: row.franchise,
            run: row.run,
            matched: false,
            matchedName: "",
            depth: 0,
          });
      continue;
    }

    const keptColorways = new Set(famRows.map((r) => r.styleColor)).size;
    const perColorway = hasHistory
      ? Math.max(1, Math.round(familyBuyUnits(st!) / keptColorways))
      : baseline;
    const matchedName = hasHistory ? st!.name : "";

    const effShare = (code: number): number => {
      const runShare = runCurve.get(code) ?? 0;
      if (!hasHistory) return runShare;
      const famShare = (st!.soldByCode.get(code) ?? 0) / st!.totalSold;
      return (
        (famShare * st!.totalSold + runShare * SMOOTH_ALPHA) /
        (st!.totalSold + SMOOTH_ALPHA)
      );
    };

    for (const row of famRows) {
      if (!meta.has(row.styleColor))
        meta.set(row.styleColor, {
          productName: row.productName,
          franchise: row.franchise,
          run: row.run,
          matched: true,
          matchedName,
          depth: perColorway,
        });
      const qty = Math.round(perColorway * effShare(row.code));
      if (qty > 0)
        raws.push({
          r0: row.r0,
          styleColor: row.styleColor,
          size: row.size,
          qty,
          wholesale: row.wholesale,
          retail: row.retail,
        });
    }
  }

  // Budget scaling (pairs).
  const totalRaw = raws.reduce((s, r) => s + r.qty, 0);
  const factor = budget > 0 && totalRaw > budget ? budget / totalRaw : 1;

  const rows = new Map<number, RowRec>();
  const styleMap = new Map<string, StyleRec>();
  for (const [sc, m] of meta)
    styleMap.set(sc, {
      styleColor: sc,
      productName: m.productName,
      franchise: m.franchise,
      run: m.run,
      matched: m.matched,
      matchedName: m.matchedName,
      depth: m.depth,
      pairs: 0,
      wholesaleTotal: 0,
      retailTotal: 0,
      sizes: [],
    });

  for (const raw of raws) {
    const q = factor < 1 ? Math.round(raw.qty * factor) : raw.qty;
    if (q <= 0) continue;
    rows.set(raw.r0, { r0: raw.r0, qty: q, split: splitWeighted(q, weights) });
    const rec = styleMap.get(raw.styleColor)!;
    rec.pairs += q;
    rec.wholesaleTotal += q * raw.wholesale;
    rec.retailTotal += q * raw.retail;
    rec.sizes.push({ size: raw.size, qty: q });
  }

  const styles = [...styleMap.values()].sort(
    (a, b) => Number(b.matched) - Number(a.matched) || b.pairs - a.pairs
  );
  return { rows, styles };
}
