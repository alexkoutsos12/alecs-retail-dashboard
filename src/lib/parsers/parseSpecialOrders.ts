import * as XLSX from "xlsx";

export interface OutstandingItem {
  sku: string;
  size: string;
  width: string;
  date: string | null; // ISO YYYY-MM-DD
  ticket: string;
}

export interface SpecialOrderCustomer {
  accountNumber: string;
  name: string;
  outstanding: OutstandingItem[];
}

export interface SpecialOrdersResult {
  customers: SpecialOrderCustomer[];
  importDate: string; // ISO YYYY-MM-DD (today)
  totalOutstanding: number;
}

// Column indices from the RICS "Customer List - Special Orders" layout.
const COL_ACCOUNT = 0;
const COL_DATE = 4;
const COL_TICKET = 15;
const COL_DETAIL = 21;
const COL_SIZE = 33;
const COL_WIDTH = 37;
const COL_NAME = 9;
const COL_TYPE = 41;
const COL_QTY = 51;

/** Title-case "LARA LOUIS" -> "Lara Louis". */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a RICS "Customer List - Special Orders" workbook.
 *
 * The file has a single sheet with a non-tabular layout — each customer is a
 * multi-row block (header row with account number & name, then transaction
 * rows, ending with a "Balance" row).
 *
 * A SKU is "outstanding" when the number of times it was ordered exceeds the
 * number of times it was picked up or cancelled. Count-based tracking, so
 * customers may re-order a SKU after a previous pickup.
 */
export function parseSpecialOrders(buffer: ArrayBuffer): SpecialOrdersResult {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(
    ws,
    { header: 1, defval: null }
  );

  // Identify customer header rows: non-empty account number in col 0 with a
  // name in col 9.
  interface Block {
    accountNumber: string;
    name: string;
    startRow: number;
    endRow: number;
  }
  const blocks: Block[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const acct = r[COL_ACCOUNT];
    const name = r[COL_NAME];
    if (
      acct != null &&
      String(acct).trim() !== "" &&
      String(acct).trim() !== "Balance" &&
      name != null &&
      String(name).trim() !== ""
    ) {
      blocks.push({
        accountNumber: String(acct).trim(),
        name: String(name).trim(),
        startRow: i,
        endRow: rows.length,
      });
    }
  }
  for (let b = 0; b < blocks.length - 1; b++) {
    blocks[b].endRow = blocks[b + 1].startRow;
  }

  const customers: SpecialOrderCustomer[] = [];

  for (const block of blocks) {
    // Per-SKU ordered events, preserved in file order (FIFO by date).
    const ordersBySku = new Map<string, OutstandingItem[]>();
    const decBySku = new Map<string, number>();

    let lastDate: Date | null = null;
    let lastTicket: string = "";

    for (let i = block.startRow + 1; i < block.endRow; i++) {
      const r = rows[i];
      if (!r) continue;
      if (String(r[COL_ACCOUNT] ?? "").trim() === "Balance") continue;

      const detail = r[COL_DETAIL];
      const type = r[COL_TYPE];
      const qtyRaw = r[COL_QTY];
      const dateRaw = r[COL_DATE];

      // Skip the column header row embedded in each block
      // (col 4 = "Date", col 51 = "Quantity").
      if (dateRaw === "Date" || qtyRaw === "Quantity") continue;

      // Must have some detail text to be a transaction row.
      if (detail == null || String(detail).trim() === "") continue;
      const detailStr = String(detail).trim();

      // Skip non-transaction bookkeeping lines.
      if (detailStr.startsWith("S.O.")) continue; // S.O. Deposit / S.O. Payment
      if (detailStr.startsWith("===")) continue; // === Previously Paid on ... ===

      // Capture date/ticket on lines that have them so continuation rows
      // (multi-item tickets) inherit from the most recent dated row above.
      if (dateRaw instanceof Date) {
        lastDate = dateRaw;
        lastTicket = r[COL_TICKET] != null ? String(r[COL_TICKET]) : "";
      }

      // Cancellation — detail like "Cancel on 158182 [SPECIAL]". RICS does
      // not put "Cancel" in the type column; the cancelled SKU is in brackets.
      if (/^Cancel on /i.test(detailStr)) {
        const m = detailStr.match(/\[([^\]]+)\]/);
        if (m) {
          const sku = m[1];
          decBySku.set(sku, (decBySku.get(sku) || 0) + 1);
        }
        continue;
      }

      // Pickup — type column = "Pickup", detail is the SKU.
      if (type === "Pickup") {
        decBySku.set(detailStr, (decBySku.get(detailStr) || 0) + 1);
        continue;
      }

      // Order row — either explicit "Special Order" in the type column, or a
      // custom-item row where the SKU is literally "SPECIAL" and RICS leaves
      // the type column blank. The column header row is already filtered
      // above (qty === "Quantity"), so SPECIAL rows with no qty still count.
      let isOrder = false;
      let sku = detailStr;
      if (type === "Special Order") {
        isOrder = true;
      } else if (
        detailStr === "SPECIAL" &&
        (type == null || String(type).trim() === "")
      ) {
        isOrder = true;
        sku = "SPECIAL";
      }
      if (!isOrder) continue;

      const item: OutstandingItem = {
        sku,
        size: r[COL_SIZE] != null ? String(r[COL_SIZE]).trim() : "",
        width: r[COL_WIDTH] != null ? String(r[COL_WIDTH]).trim() : "",
        date: lastDate ? toIsoDate(lastDate) : null,
        ticket: lastTicket,
      };
      if (!ordersBySku.has(sku)) ordersBySku.set(sku, []);
      ordersBySku.get(sku)!.push(item);
    }

    // Net outstanding per SKU: drop the oldest N orders where N = pickups +
    // cancels for that SKU. Each order row counts as one.
    const outstanding: OutstandingItem[] = [];
    for (const [sku, list] of ordersBySku) {
      const dec = decBySku.get(sku) || 0;
      const remaining = list.slice(Math.min(dec, list.length));
      outstanding.push(...remaining);
    }

    if (outstanding.length === 0) continue;

    customers.push({
      accountNumber: block.accountNumber,
      name: titleCase(block.name),
      outstanding,
    });
  }

  // Alphabetical by name.
  customers.sort((a, b) => a.name.localeCompare(b.name));

  const totalOutstanding = customers.reduce(
    (sum, c) => sum + c.outstanding.length,
    0
  );

  return {
    customers,
    importDate: toIsoDate(new Date()),
    totalOutstanding,
  };
}
