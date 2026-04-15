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
  /** Formatted phone number derived from the account number (e.g. "566-7111"
   *  for a 603 number, "(508) 380-8405" otherwise). Empty string when the
   *  account number is non-numeric (e.g. company account like "HBILLERICAFD"). */
  phone: string;
  outstanding: OutstandingItem[];
}

export interface SpecialOrdersResult {
  customers: SpecialOrderCustomer[];
  importDate: string; // ISO YYYY-MM-DD
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

/** Title-case "MICHAEL MCGETTIGAN" -> "Michael Mcgettigan". */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * RICS uses the customer's phone number as the account number. 7 digits = 603
 * area code (local NH), 10 digits = another area code. Non-numeric account
 * numbers (company accounts) return "".
 */
function formatPhoneFromAccount(account: string): string {
  const digits = account.replace(/\D/g, "");
  if (digits.length === 7) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return "";
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
 *
 * Edge cases handled:
 *  - Multi-item tickets: continuation rows (no date/ticket/type) inherit
 *    date, ticket, AND type from the most recent dated row above. This is
 *    critical — a continuation pickup row has empty type but is still a
 *    pickup, and a continuation order row has empty type but is still an
 *    order.
 *  - "SPECIAL" custom items: when the SKU is literally "SPECIAL" and the type
 *    column is empty, the row is a new order *only* if it has a quantity. A
 *    SPECIAL row with empty qty that is followed by "=== Previously Paid on
 *    <ticket> ===" is a pickup event (RICS re-rings the custom item on a new
 *    ticket when the deposit is applied).
 *  - Cancellations: detail reads "Cancel on <ticket> [<sku>]"; the type
 *    column is blank.
 */
export function parseSpecialOrders(buffer: ArrayBuffer): SpecialOrdersResult {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(
    ws,
    { header: 1, defval: null }
  );

  // ─── Identify customer blocks ──────────────────────────────────
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
    // Look up whether row `i` is followed (skipping S.O. bookkeeping lines)
    // by a "=== Previously Paid on <ticket> ===" line. If so, row `i` is a
    // pickup event (the deposit from the prior ticket is being applied to
    // this ring).
    const followedByPreviouslyPaid = (i: number): boolean => {
      for (let j = i + 1; j < block.endRow; j++) {
        const r = rows[j];
        if (!r) continue;
        const d = r[COL_DETAIL];
        if (d == null || String(d).trim() === "") continue;
        const s = String(d).trim();
        if (s.startsWith("S.O.")) continue; // skip deposit/payment lines
        return /^=== Previously Paid on /.test(s);
      }
      return false;
    };

    // Per-SKU ordered events, preserved in file order (FIFO by date).
    const ordersBySku = new Map<string, OutstandingItem[]>();
    const decBySku = new Map<string, number>();

    // Inheritance state for continuation rows.
    let lastDate: Date | null = null;
    let lastTicket = "";
    let lastType = ""; // "Special Order" | "Pickup" | ""

    for (let i = block.startRow + 1; i < block.endRow; i++) {
      const r = rows[i];
      if (!r) continue;
      if (String(r[COL_ACCOUNT] ?? "").trim() === "Balance") continue;

      const detail = r[COL_DETAIL];
      const typeCell = r[COL_TYPE];
      const qtyRaw = r[COL_QTY];
      const dateRaw = r[COL_DATE];

      // Skip the embedded column-header row (col 4 = "Date", col 51 =
      // "Quantity"). Important: this also prevents the SPECIAL rule below
      // from matching when the header happens to sit above a SPECIAL row.
      if (dateRaw === "Date" || qtyRaw === "Quantity") continue;

      if (detail == null || String(detail).trim() === "") continue;
      const detailStr = String(detail).trim();

      // Skip bookkeeping lines.
      if (detailStr.startsWith("S.O.")) continue; // S.O. Deposit / Payment
      if (detailStr.startsWith("===")) continue; // === Previously Paid on ... ===

      // Cancellation — "Cancel on <ticket> [<sku>]". RICS leaves the type
      // column blank; the cancelled SKU is in brackets.
      if (/^Cancel on /i.test(detailStr)) {
        const m = detailStr.match(/\[([^\]]+)\]/);
        if (m) {
          const sku = m[1];
          decBySku.set(sku, (decBySku.get(sku) || 0) + 1);
        }
        continue;
      }

      // Resolve effective type / date / ticket for this row.
      let effType =
        typeCell != null && String(typeCell).trim() !== ""
          ? String(typeCell).trim()
          : "";
      let effDate: Date | null = dateRaw instanceof Date ? dateRaw : null;
      let effTicket =
        r[COL_TICKET] != null && String(r[COL_TICKET]).trim() !== ""
          ? String(r[COL_TICKET])
          : "";

      if (effDate) {
        // New dated row — update inheritance state.
        lastDate = effDate;
        lastTicket = effTicket;

        // A dated row with an empty type cell but followed by "=== Previously
        // Paid on <ticket> ===" is a SPECIAL pickup/re-ring event. Regular
        // pickups always have type="Pickup" in the column, so this case only
        // fires for SPECIAL custom items.
        if (effType === "" && followedByPreviouslyPaid(i)) {
          effType = "Pickup";
        }
        lastType = effType;
      } else {
        // Continuation row on a multi-item ticket — inherit from the most
        // recent dated row. This covers both order continuations (e.g. a
        // second SKU rung on the same Special Order ticket) and pickup
        // continuations (e.g. ALECS50 picked up alongside the main SKU).
        effDate = lastDate;
        effTicket = lastTicket;
        if (effType === "") effType = lastType;
      }

      // Pickup (either explicit type or inherited from continuation).
      if (effType === "Pickup") {
        decBySku.set(detailStr, (decBySku.get(detailStr) || 0) + 1);
        continue;
      }

      // Order detection.
      let isOrder = false;
      let sku = detailStr;
      if (effType === "Special Order") {
        isOrder = true;
      } else if (
        detailStr === "SPECIAL" &&
        effType === "" &&
        typeof qtyRaw === "number" &&
        qtyRaw > 0
      ) {
        // Custom SPECIAL item. Only count as a new order when qty is
        // present — a qty-less SPECIAL line is a pickup/re-ring event and
        // was already converted above via followedByPreviouslyPaid().
        isOrder = true;
        sku = "SPECIAL";
      }
      if (!isOrder) continue;

      const item: OutstandingItem = {
        sku,
        size: r[COL_SIZE] != null ? String(r[COL_SIZE]).trim() : "",
        width: r[COL_WIDTH] != null ? String(r[COL_WIDTH]).trim() : "",
        date: effDate ? toIsoDate(effDate) : null,
        ticket: effTicket,
      };
      if (!ordersBySku.has(sku)) ordersBySku.set(sku, []);
      ordersBySku.get(sku)!.push(item);
    }

    // Net outstanding per SKU: drop the oldest N orders where N = pickups +
    // cancels for that SKU (FIFO — oldest orders are fulfilled first).
    const outstanding: OutstandingItem[] = [];
    for (const [, list] of ordersBySku) {
      const skuKey = list[0].sku;
      const dec = decBySku.get(skuKey) || 0;
      const remaining = list.slice(Math.min(dec, list.length));
      outstanding.push(...remaining);
    }

    if (outstanding.length === 0) continue;

    // Sort outstanding items by date (oldest first) so the printed list
    // reads chronologically within each customer.
    outstanding.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    customers.push({
      accountNumber: block.accountNumber,
      name: titleCase(block.name),
      phone: formatPhoneFromAccount(block.accountNumber),
      outstanding,
    });
  }

  // Alphabetical by name (first-name order). The report page offers a
  // last-name sort option; the JSON is stored in a stable default order.
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
