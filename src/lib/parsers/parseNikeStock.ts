import * as XLSX from "xlsx";

/**
 * Nike Stock Status (CSV) parser for the Buying Planner.
 *
 * RICS Stock Status exported as CSV is long format — one row per SKU per
 * size — with OnHand / OnOrderTotal / Sales1 (the selected sales window) on
 * each row, plus price, cost and age. This parser collapses the rows into one
 * record per SKU with a size grid, and enriches each with:
 *   - size run (Toddler / Little Kid / Big Kid) from Nike's TD/PS/GS/BG
 *     suffix, falling back to the shape of the size codes;
 *   - a canonical style family (abbreviations like COURT BOR / CT BOROUGH are
 *     merged) so colorways of the same shoe group together;
 *   - gender, margin, and a reorder/coverage signal.
 */

export type SizeRun = "Toddler" | "Little Kid" | "Big Kid" | "Other";
export type Gender = "Boys" | "Girls" | "Unisex";

export interface SizeCell {
  code: number; // size * 10, e.g. 35 = 3.5, 105 = 10.5
  label: string; // "3.5", "10.5", "1"
  order: number; // sort key within the run
  onHand: number;
  onOrder: number;
  sold: number;
}

export interface NikeSku {
  sku: string;
  supplierSku: string;
  description: string; // raw Summary
  styleFamily: string; // canonical family
  color: string;
  classCode: string; // "520"
  className: string; // "Boys Sport/Fash"
  gender: Gender;
  run: SizeRun;
  retailPrice: number;
  cost: number;
  marginPct: number; // (retail - cost) / retail
  daysFirstReceived: number;
  daysLastReceived: number;
  sizes: SizeCell[]; // sorted in shoe order
  onHand: number;
  onOrder: number;
  sold: number;
  sellThrough: number; // sold / (sold + onHand)
  coverageGap: number; // sold - (onHand + onOrder); positive => can't cover a repeat
}

// ─── Size-run resolution ─────────────────────────────────────────────────────

function resolveRun(summary: string, codes: number[]): SizeRun {
  const s = ` ${summary.toUpperCase()} `;
  if (/\bTD\b|\(TD\)/.test(s)) return "Toddler";
  if (/\bPS\b|\(PS\)/.test(s)) return "Little Kid";
  if (/\bGS\b|\bBG\b|\(GS\)/.test(s)) return "Big Kid";
  // Fallback: infer from the set of size codes present.
  const hasHigh = codes.some((c) => c >= 105); // 10.5c-13.5c → Little Kid run
  const hasTop = codes.some((c) => c >= 80 && c <= 100); // 8c-10c → Toddler
  const hasLow = codes.some((c) => c >= 35 && c <= 75); // 3.5-7.5
  const has1to3 = codes.some((c) => c >= 10 && c <= 30); // 1-3
  if (hasHigh) return "Little Kid";
  if (hasTop) return "Toddler";
  if (hasLow && !has1to3) return "Big Kid";
  if (has1to3) return "Little Kid";
  return "Other";
}

function resolveGender(className: string): Gender {
  const c = className.toLowerCase();
  if (c.includes("boys") || c.includes("boy")) return "Boys";
  if (c.includes("girls") || c.includes("girl")) return "Girls";
  return "Unisex";
}

// ─── Style family (alias resolution) ─────────────────────────────────────────

// Ordered rules — first match wins. Merges Nike's inconsistent abbreviations
// and generation numbers into one family per shoe model. Silhouette (Low/Mid)
// is kept where it is a genuinely different product line.
const FAMILY_RULES: [RegExp, string][] = [
  [/G\.?\s?T\.?\s?CUT/, "G.T. Cut"],
  [/A'?\s?ONE/, "A'One"],
  [/AIR FORCE 1|AF1|FORCE 1/, "Air Force 1"],
  [/COURT BOR.*MID|CT BOROUGH MID/, "Court Borough Mid"],
  [/COURT BOR.*LOW|CT BOROUGH LOW/, "Court Borough Low"],
  [/COURT BOROUGH/, "Court Borough"],
  [/AIR MAX 270/, "Air Max 270"],
  [/AIR MAX 90|CRIB MAX 90/, "Air Max 90"],
  [/AIR MAX NOVA/, "Air Max Nova"],
  [/AIR MAX SYS|AIR MAX SYSTM/, "Air Max System"],
  [/AIR MAX NUAXIS/, "Air Max Nuaxis"],
  [/AIR MAX EXCEE/, "Air Max Excee"],
  [/AIR MAX SC/, "Air Max SC"],
  [/(AIR )?MAX BIA/, "Air Max Bia"],
  [/AIR MAX MOTION/, "Air Max Motion"],
  [/AIR MAX TW/, "Air Max TW"],
  [/AIR MAX/, "Air Max (Other)"],
  [/DUNK/, "Dunk Low"],
  [/FLEX RUNNER/, "Flex Runner"],
  [/FLEX EXPERIENCE/, "Flex Experience"],
  [/STAR RUNNER/, "Star Runner"],
  [/COSMIC RUNNER/, "Cosmic Runner"],
  [/REVOLUTION/, "Revolution"],
  [/TEAM HUSTLE/, "Team Hustle"],
  [/LEBRON|WITNESS/, "LeBron Witness"],
  [/KOBE/, "Kobe"],
  [/GIANN|FREAK/, "Giannis"],
  [/BLAZER/, "Blazer"],
  [/KAWA/, "Kawa Slide"],
  [/D[YT]NAMITE/, "S.T. Dynamite"],
  [/PEGASUS/, "Pegasus"],
  [/HU?A?RACHE|HURACHE/, "Huarache"],
  [/TANJUN/, "Tanjun"],
  [/ISOFLY/, "Isofly"],
  [/SONIC FLY/, "Sonic Fly"],
  [/MYSTIC FLY/, "Mystic Fly"],
  [/WINFLO/, "Winflo"],
  [/VOMERO/, "Vomero"],
  [/WAFFLE/, "Waffle"],
  [/FREE /, "Free"],
  [/OMN[IO] MULTI/, "Omni Multi-Court"],
  [/WEARALLDAY/, "Wearallday"],
  [/STELLAR RIDE/, "Stellar Ride"],
  [/GATO/, "Gato"],
  [/SONGOKU|FREAK/, "Giannis"],
];

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function normalizeDescription(summary: string): string {
  let s = summary.toUpperCase().trim();
  s = s.replace(/\((PS|TD|GS)\)/g, " ");
  s = s.replace(/\b(TD|PS|GS|BG|BP|BT|BPV|TDV|PSV|GSV|LIL)\b/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function resolveFamily(summary: string, className: string): string {
  const norm = normalizeDescription(summary);
  if (norm === "") {
    // No description — fall back to the class (strip the leading code).
    const cn = className.replace(/^\d+\s*-\s*/, "").trim();
    if (/thong/i.test(cn)) return "Thong Sandal";
    if (/slide/i.test(cn)) return "Slide";
    if (/sandal/i.test(cn)) return "Sandal";
    return cn ? titleCase(cn) : "Uncategorized";
  }
  for (const [re, family] of FAMILY_RULES) {
    if (re.test(norm)) return family;
  }
  if (/SLIDE/.test(norm)) return "Slide";
  if (/THONG/.test(norm)) return "Thong Sandal";
  return titleCase(norm);
}

// ─── Size code helpers ───────────────────────────────────────────────────────

function sizeLabel(code: number): string {
  const size = code / 10;
  return Number.isInteger(size) ? String(size) : size.toFixed(1);
}

function sizeOrder(code: number, run: SizeRun): number {
  // Little Kid runs go 10.5c-13.5c (105-135) THEN 1y-3y (010-030), so push the
  // low youth codes after the high toddler codes.
  if (run === "Little Kid" && code <= 30) return code + 1000;
  return code;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

interface RawAccum {
  first: Record<string, unknown>;
  sizes: Map<number, { onHand: number; onOrder: number; sold: number }>;
}

export async function parseNikeStock(
  buffer: ArrayBuffer,
  onProgress?: (current: number, total: number) => void
): Promise<NikeSku[]> {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: null,
  });

  // Header names can carry a BOM; normalize key lookup.
  const keyOf = (row: Record<string, unknown>, name: string): unknown => {
    for (const k of Object.keys(row)) {
      if (k.replace(/^﻿/, "").trim() === name) return row[k];
    }
    return null;
  };

  const bySku = new Map<string, RawAccum>();
  const total = rows.length;
  let i = 0;
  for (const row of rows) {
    if (i % 500 === 0) {
      onProgress?.(i, total);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    i++;

    const sku = str(keyOf(row, "SKU"));
    if (!sku) continue;
    const code = Math.round(num(keyOf(row, "COL")));
    const onHand = num(keyOf(row, "OnHand"));
    const onOrder = num(keyOf(row, "OnOrderTotal"));
    const sold = num(keyOf(row, "Sales1"));

    let acc = bySku.get(sku);
    if (!acc) {
      acc = { first: row, sizes: new Map() };
      bySku.set(sku, acc);
    }
    if (code > 0) {
      const cell = acc.sizes.get(code) ?? { onHand: 0, onOrder: 0, sold: 0 };
      cell.onHand += onHand;
      cell.onOrder += onOrder;
      cell.sold += sold;
      acc.sizes.set(code, cell);
    }
  }

  const result: NikeSku[] = [];
  for (const [sku, acc] of bySku) {
    const row = acc.first;
    const description = str(keyOf(row, "Summary"));
    const className = str(keyOf(row, "Class"));
    const codes = [...acc.sizes.keys()];
    const run = resolveRun(description, codes);

    const sizes: SizeCell[] = codes
      .map((code) => {
        const c = acc.sizes.get(code)!;
        return {
          code,
          label: sizeLabel(code),
          order: sizeOrder(code, run),
          onHand: c.onHand,
          onOrder: c.onOrder,
          sold: c.sold,
        };
      })
      .sort((a, b) => a.order - b.order);

    const onHand = sizes.reduce((s, c) => s + c.onHand, 0);
    const onOrder = sizes.reduce((s, c) => s + c.onOrder, 0);
    const sold = sizes.reduce((s, c) => s + c.sold, 0);
    const retailPrice = num(keyOf(row, "RetailPrice"));
    const cost = num(keyOf(row, "CurrentCost"));

    result.push({
      sku,
      supplierSku: str(keyOf(row, "SupplierSKU")),
      description,
      styleFamily: resolveFamily(description, className),
      color: str(keyOf(row, "Color")),
      classCode: (className.match(/^\d+/) ?? [""])[0],
      className: className.replace(/^\d+\s*-\s*/, "").trim(),
      gender: resolveGender(className),
      run,
      retailPrice,
      cost,
      marginPct: retailPrice > 0 ? (retailPrice - cost) / retailPrice : 0,
      daysFirstReceived: num(keyOf(row, "DaysAgoFirstReceived")),
      daysLastReceived: num(keyOf(row, "DaysAgoLastReceived")),
      sizes,
      onHand,
      onOrder,
      sold,
      sellThrough: sold + onHand > 0 ? sold / (sold + onHand) : 0,
      coverageGap: sold - (onHand + onOrder),
    });
  }

  onProgress?.(total, total);
  return result;
}
