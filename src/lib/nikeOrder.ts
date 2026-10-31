import { NikeSku, SizeRun } from "./parsers/parseNikeStock";

/**
 * Nike Order Builder engine.
 *
 * Matches a Nike.net order form (new-season styles, one row per
 * style-color + size) against the historical stock-status analysis already
 * imported into the Planner, and recommends a per-size buy quantity.
 *
 * Fully adaptive to the imported stock status: a style-color is only
 * recommended when its franchise + size run exists in the history. Families
 * the store doesn't carry (e.g. soccer cleats, brand-new silhouettes) are
 * left blank. Within a matched family, the historical size-sell curve sets
 * the spread and sell-through scales the depth off a user baseline.
 */

/** Reduce a franchise / style-family name to a coarse key both sides share. */
export function matchKey(name: string): string {
  const n = name.toLowerCase();
  if (/air force 1|force 1|af1/.test(n)) return "air force 1";
  if (/court bor/.test(n)) return "court borough";
  if (/air max 270/.test(n)) return "air max 270";
  if (/air max 90/.test(n)) return "air max 90";
  if (/air max nova/.test(n)) return "air max nova";
  if (/air max/.test(n)) return "air max";
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
  if (/dynamite|s\.?\s?t\.?/.test(n)) return "st";
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

/** "10.5C" / "3.5Y" / "2C" -> size code (size * 10). */
export function sizeToCode(size: string): number {
  const m = size.match(/([\d.]+)/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * 10);
}

export interface FamilyRunStats {
  soldByCode: Map<number, number>;
  totalSold: number;
  totalOnHand: number;
  colorways: number;
  sellThrough: number;
}

/** Build per (matchKey + run) historical stats from the imported SKUs. */
export function buildHistory(skus: NikeSku[]): Map<string, FamilyRunStats> {
  const map = new Map<string, FamilyRunStats>();
  for (const k of skus) {
    const key = `${matchKey(k.styleFamily)}::${k.run}`;
    let st = map.get(key);
    if (!st) {
      st = {
        soldByCode: new Map(),
        totalSold: 0,
        totalOnHand: 0,
        colorways: 0,
        sellThrough: 0,
      };
      map.set(key, st);
    }
    st.colorways += 1;
    for (const s of k.sizes) {
      st.soldByCode.set(
        s.code,
        (st.soldByCode.get(s.code) ?? 0) + s.sold
      );
      st.totalSold += s.sold;
      st.totalOnHand += s.onHand;
    }
  }
  for (const st of map.values()) {
    st.sellThrough =
      st.totalSold + st.totalOnHand > 0
        ? st.totalSold / (st.totalSold + st.totalOnHand)
        : 0;
  }
  return map;
}

export interface OrderRow {
  r0: number; // 0-indexed worksheet row
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
  matchedKey: string;
  depth: number;
  pairs: number;
  wholesaleTotal: number;
  retailTotal: number;
  sizes: { size: string; qty: number }[];
}

function splitThree(qty: number): [number, number, number] {
  const base = Math.floor(qty / 3);
  const rem = qty % 3;
  return [base + (rem > 0 ? 1 : 0), base + (rem > 1 ? 1 : 0), base];
}

export interface RecommendResult {
  rows: Map<number, RowRec>;
  styles: StyleRec[];
}

/**
 * Produce recommendations. `baseline` is the typical pairs-per-colorway the
 * user sets; depth = round(baseline * (0.5 + sellThrough)), so a hot family
 * buys up to ~1.5x and a slow one ~0.5x. Depth is distributed across the
 * historical size-sell curve, then split across the three deliveries.
 */
export function recommend(
  orderRows: OrderRow[],
  history: Map<string, FamilyRunStats>,
  baseline: number
): RecommendResult {
  // Group order rows by style-color.
  const byStyle = new Map<string, OrderRow[]>();
  for (const row of orderRows) {
    if (!byStyle.has(row.styleColor)) byStyle.set(row.styleColor, []);
    byStyle.get(row.styleColor)!.push(row);
  }

  const rows = new Map<number, RowRec>();
  const styles: StyleRec[] = [];

  for (const [styleColor, rowsForStyle] of byStyle) {
    const first = rowsForStyle[0];
    const key = `${matchKey(first.franchise)}::${first.run}`;
    const st = history.get(key);

    const styleRec: StyleRec = {
      styleColor,
      productName: first.productName,
      franchise: first.franchise,
      run: first.run,
      matched: false,
      matchedKey: key,
      depth: 0,
      pairs: 0,
      wholesaleTotal: 0,
      retailTotal: 0,
      sizes: [],
    };

    if (st && st.totalSold > 0) {
      styleRec.matched = true;
      const depth = Math.max(
        1,
        Math.round(baseline * (0.5 + st.sellThrough))
      );
      styleRec.depth = depth;
      for (const row of rowsForStyle) {
        const share = (st.soldByCode.get(row.code) ?? 0) / st.totalSold;
        const qty = Math.round(depth * share);
        if (qty > 0) {
          rows.set(row.r0, { r0: row.r0, qty, split: splitThree(qty) });
          styleRec.pairs += qty;
          styleRec.wholesaleTotal += qty * row.wholesale;
          styleRec.retailTotal += qty * row.retail;
          styleRec.sizes.push({ size: row.size, qty });
        }
      }
    }

    styles.push(styleRec);
  }

  styles.sort(
    (a, b) =>
      Number(b.matched) - Number(a.matched) || b.pairs - a.pairs
  );
  return { rows, styles };
}
