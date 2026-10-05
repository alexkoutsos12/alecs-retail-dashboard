import * as XLSX from "xlsx";
import { parseSalesJournal } from "./parseSalesJournal";

/**
 * Discount analysis for the Senior Discount module.
 *
 * Alec's offers a 10% senior citizen discount. In the RICS Sales Journal a
 * senior discount is recorded exactly like any other markdown, so there is no
 * explicit flag. We approximate the senior-discount total by elimination and
 * classify every discounted line into a category so the result can be
 * reconciled against the report's own total discount figure:
 *
 *   - outlet:   perked line with a $1 marker (outlet merchandise).
 *   - perk:     perked line with a $2+ marker (employee payable perk).
 *   - senior:   non-perked sale discounted by (almost) exactly 10%.
 *   - markdown: non-perked sale discounted by some other percentage
 *               (a full-service sale-tag markdown).
 *   - return:   a Return line (negative discount) — excluded from the senior
 *               figure, but kept so the totals reconcile.
 *
 * Known, unavoidable limits (surfaced by the reconciliation view):
 *   - A full-service item marked down ~10% is indistinguishable from a senior
 *     discount and is counted as senior.
 *   - A tiny amount of discount is applied at the ticket level (not on any
 *     line) and Layaway Sales are not read by the shared sales-journal parser;
 *     both show up as the small "unreconciled" remainder.
 */

export type DiscountCategory =
  | "senior"
  | "outlet"
  | "perk"
  | "markdown"
  | "return";

export interface DiscountLine {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM AM/PM
  ticketNumber: string;
  cashier: string;
  salesperson: string;
  sku: string;
  productName: string;
  size: string;
  retailPrice: number; // per unit
  salePrice: number; // per unit
  discountAmount: number; // line total discounted (Markdown column; negative on returns)
  discountPct: number; // fraction, e.g. 0.1 for 10%
  category: DiscountCategory;
}

export interface DiscountAnalysis {
  lines: DiscountLine[];
  /**
   * The report's own total discount, read from the "Store Totals" grand-total
   * row (or the summed "Date Totals" rows as a fallback). Null when the file
   * carries no such summary row. Used to reconcile against the sum of the
   * parsed line discounts.
   */
  reportedTotalDiscount: number | null;
}

/** The senior discount rate (10%). */
export const SENIOR_RATE = 0.1;

/**
 * How far from exactly 10% a line's discount may fall and still count as a
 * senior discount. ±0.1% captures cent-rounding on a true 10% markdown while
 * excluding genuine sale-tag markdowns that land nearby.
 */
export const SENIOR_TOLERANCE = 0.001;

/** Backwards-compatible alias — a senior line is just a DiscountLine. */
export type SeniorDiscountLine = DiscountLine;

function classify(
  transactionType: string,
  perks: number,
  retailPrice: number,
  salePrice: number
): DiscountCategory {
  if (transactionType === "Return") return "return";
  if (perks === 1) return "outlet";
  if (perks !== 0) return "perk"; // $2+ payable perk (any other nonzero marker)
  // Non-perked sale carrying a discount.
  if (retailPrice > 0 && salePrice < retailPrice) {
    const pct = (retailPrice - salePrice) / retailPrice;
    if (Math.abs(pct - SENIOR_RATE) <= SENIOR_TOLERANCE) return "senior";
  }
  return "markdown";
}

/**
 * Read the report's own total discount from the summary rows. Prefers the
 * single "Store Totals" grand-total row; falls back to summing the per-day
 * "Date Totals" rows; returns null if neither is present.
 */
function extractReportedTotalDiscount(buffer: ArrayBuffer): number | null {
  const wb = XLSX.read(buffer, { type: "array" });

  let storeTotal = 0;
  let foundStore = false;
  let dateTotal = 0;
  let foundDate = false;

  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(
      wb.Sheets[name],
      { header: 1, defval: null }
    );

    // Find the Markdown column from the header row.
    let mdCol = -1;
    for (let i = 0; i < Math.min(rows.length, 40) && mdCol === -1; i++) {
      const row = rows[i];
      if (!row) continue;
      for (let c = 0; c < 40; c++) {
        if (row[c] != null && String(row[c]).trim() === "Markdown") {
          mdCol = c;
          break;
        }
      }
    }
    if (mdCol === -1) continue;

    for (const row of rows) {
      if (!row) continue;
      const label = row[0] != null ? String(row[0]).trim() : "";
      const val = row[mdCol];
      if (typeof val !== "number") continue;
      if (label === "Store Totals") {
        storeTotal += val;
        foundStore = true;
      } else if (label === "Date Totals") {
        dateTotal += val;
        foundDate = true;
      }
    }
  }

  if (foundStore) return storeTotal;
  if (foundDate) return dateTotal;
  return null;
}

/**
 * Parse a RICS Sales Journal into a full discount analysis — every discounted
 * line categorized, plus the report's own total discount for reconciliation.
 */
export async function parseDiscountAnalysis(
  buffer: ArrayBuffer,
  reportId: string,
  onProgress?: (current: number, total: number) => void
): Promise<DiscountAnalysis> {
  const transactions = await parseSalesJournal(buffer, reportId, onProgress);

  const lines: DiscountLine[] = [];
  for (const t of transactions) {
    // Only lines that actually carry a discount (positive markdown on a sale,
    // negative on a return). A full-price line has markdown 0 and is skipped.
    if (!t.markdown || t.markdown === 0) continue;

    const category = classify(
      t.transactionType,
      t.perks,
      t.retailPrice,
      t.salePrice
    );
    const discountPct =
      t.retailPrice > 0 ? (t.retailPrice - t.salePrice) / t.retailPrice : 0;

    lines.push({
      id: t.id,
      date: t.date,
      time: t.time,
      ticketNumber: t.ticketNumber,
      cashier: t.cashier,
      salesperson: t.salesperson,
      sku: t.sku,
      productName: t.productName,
      size: t.size,
      retailPrice: t.retailPrice,
      salePrice: t.salePrice,
      discountAmount: t.markdown,
      discountPct,
      category,
    });
  }

  return {
    lines,
    reportedTotalDiscount: extractReportedTotalDiscount(buffer),
  };
}
