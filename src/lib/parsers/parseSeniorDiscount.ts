import { parseSalesJournal } from "./parseSalesJournal";

/**
 * Senior Discount parser.
 *
 * Alec's offers a 10% senior citizen discount. In the RICS Sales Journal a
 * senior discount is recorded exactly like any other markdown, so there is no
 * explicit flag to key off. We approximate the senior-discount total by
 * elimination:
 *
 *   1. Omit every *perked* line. The Perks column marks discounted
 *      merchandise — outlet items ($1) and employee payable perks ($2+). None
 *      of those are senior discounts. (Returns of perked items carry a
 *      negative perk and are excluded here too.)
 *   2. Of the remaining full-service lines, keep only those discounted by
 *      (almost) exactly 10%. A full-service item marked down by some other
 *      percentage is a sale-tag markdown, not a senior discount.
 *
 * The unavoidable flaw: a full-service item marked down by ~10% with a sale
 * tag is indistinguishable from a senior discount and will be counted. Over a
 * month this yields a representative figure within a small margin of error.
 *
 * Returns are ignored entirely — this reports discounts *given*, not net of
 * returns.
 */

export interface SeniorDiscountLine {
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
  discountAmount: number; // line total discounted (Markdown column)
  discountPct: number; // fraction, e.g. 0.1 for 10%
}

/** The senior discount rate (10%). */
export const SENIOR_RATE = 0.1;

/**
 * How far from exactly 10% a line's discount may fall and still count as a
 * senior discount. ±0.1% captures cent-rounding on a true 10% markdown while
 * excluding genuine sale-tag markdowns that land nearby. Widen this to catch
 * more rounding at the cost of sweeping in more real markdowns.
 */
export const SENIOR_TOLERANCE = 0.001;

/**
 * Transaction types that can carry a senior discount. Returns are excluded on
 * purpose — see the module note above.
 */
const SENIOR_TYPES = new Set(["Regular Sale", "Special Order Pickup"]);

export async function parseSeniorDiscount(
  buffer: ArrayBuffer,
  reportId: string,
  onProgress?: (current: number, total: number) => void
): Promise<SeniorDiscountLine[]> {
  const transactions = await parseSalesJournal(buffer, reportId, onProgress);

  const lines: SeniorDiscountLine[] = [];
  for (const t of transactions) {
    // Sales only — ignore returns.
    if (!SENIOR_TYPES.has(t.transactionType)) continue;
    // Any perk at all (outlet $1, payable $2+, or a negative perk on a
    // perked return) means this is discounted merchandise, not senior.
    if (t.perks !== 0) continue;
    // Must be a real discount off a real retail price.
    if (t.retailPrice <= 0 || t.salePrice >= t.retailPrice) continue;

    const discountPct = (t.retailPrice - t.salePrice) / t.retailPrice;
    if (Math.abs(discountPct - SENIOR_RATE) > SENIOR_TOLERANCE) continue;

    // The Markdown column is already the line total discounted (across
    // quantity). Fall back to the per-unit delta if it is missing.
    const discountAmount =
      t.markdown > 0 ? t.markdown : t.retailPrice - t.salePrice;

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
      discountAmount,
      discountPct,
    });
  }

  return lines;
}
