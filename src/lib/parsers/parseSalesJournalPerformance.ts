import * as XLSX from "xlsx";

export interface PerformanceTransaction {
  id: string;
  reportId: string;
  ticketNumber: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM AM/PM
  dayOfWeek: string; // Monday, Tuesday, etc.
  hour: number; // 0-23
  cashier: string;
  customerName: string;
  salesperson: string;
  transactionType: string;
  isReturn: boolean;
  sku: string;
  productName: string;
  size: string;
  retailPrice: number;
  salePrice: number;
  perks: number;
  markdown: number;
}

const SALE_TYPES = new Set(["Regular Sale", "Return", "Special Order Pickup"]);

const SKIP_VALUES = new Set([
  "Ticket Totals",
  "Tender",
  "Discount:",
  "Return:",
  "Charge Payment",
]);

const SKIP_PREFIXES = ["Batch from", "Store "];

// Return reasons that should be excluded — these are credit transfers,
// not actual product returns.
const EXCLUDED_RETURN_REASONS = new Set([
  "5-Club Transfer",
  "6-Captains Credits",
  "7-club advance",
]);

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

interface TicketContext {
  ticketNumber: string;
  date: string;
  time: string;
  dayOfWeek: string;
  hour: number;
  cashier: string;
  customerName: string;
}

function parseTicketHeader(col0Str: string): TicketContext | null {
  if (!/^Ticket \d+/.test(col0Str)) return null;

  const normalized = col0Str.replace(/\s+/g, " ").trim();

  const ticketNumMatch = normalized.match(/^Ticket (\d+)/);
  if (!ticketNumMatch) return null;

  const dateMatch = normalized.match(/on\s+(\d{2}\/\d{2}\/\d{4})/);
  const timeMatch = normalized.match(/(\d{1,2}:\d{2}\s+[AP]M)/);
  const cashierMatch = normalized.match(
    /by Cashier:\s+(.*?)(?:\s+for Customer:|$)/
  );
  const customerMatch = normalized.match(/for Customer:\s+\d+\s+(.*?)$/);

  const dateStr = dateMatch?.[1] ?? "";
  let date = "";
  let dayOfWeek = "";
  if (dateStr) {
    const [month, day, year] = dateStr.split("/");
    date = `${year}-${month}-${day}`;
    const d = new Date(Number(year), Number(month) - 1, Number(day));
    dayOfWeek = DAY_NAMES[d.getDay()];
  }

  let hour = 0;
  const timeStr = timeMatch?.[1]?.trim() ?? "";
  if (timeStr) {
    const hMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s+(AM|PM)$/);
    if (hMatch) {
      let h = Number(hMatch[1]);
      const ampm = hMatch[3];
      if (ampm === "PM" && h !== 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
      hour = h;
    }
  }

  return {
    ticketNumber: ticketNumMatch[1],
    date,
    time: timeStr,
    dayOfWeek,
    hour,
    cashier: cashierMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "",
    customerName: customerMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "",
  };
}

interface ColMap {
  item: number;
  salesperson: number;
  sold: number;
  retail: number;
  salePrice: number;
  perks: number;
  markdown: number;
}

function detectColumns(sheetRows: unknown[][]): ColMap {
  const defaults: ColMap = {
    item: 2,
    salesperson: 5,
    sold: 8,
    retail: 12,
    salePrice: 13,
    perks: 15,
    markdown: 16,
  };

  for (let i = 0; i < Math.min(sheetRows.length, 40); i++) {
    const row = sheetRows[i];
    if (!row) continue;
    let retailCol = -1;
    for (let c = 0; c < 30; c++) {
      if (row[c] != null && String(row[c]).trim() === "Retail") {
        retailCol = c;
        break;
      }
    }
    if (retailCol === -1) continue;

    const map: ColMap = { ...defaults };
    map.retail = retailCol;
    for (let c = 0; c < 30; c++) {
      const v = row[c] != null ? String(row[c]).trim() : "";
      if (v === "Price") map.salePrice = c;
      if (v === "Perks") map.perks = c;
      if (v === "Markdown") map.markdown = c;
      if (v === "Sold") map.sold = c;
    }

    for (let j = i + 1; j < Math.min(sheetRows.length, i + 50); j++) {
      const saleRow = sheetRows[j];
      if (!saleRow) continue;
      const c0 = saleRow[0] != null ? String(saleRow[0]).trim() : "";
      if (!SALE_TYPES.has(c0)) continue;
      for (let c = 1; c < 10; c++) {
        if (saleRow[c] != null && String(saleRow[c]).includes("\n")) {
          map.item = c;
          break;
        }
      }
      for (let c = 1; c < 15; c++) {
        if (
          saleRow[c] != null &&
          String(saleRow[c]).trim().startsWith("Sales:")
        ) {
          map.salesperson = c;
          break;
        }
      }
      break;
    }
    return map;
  }
  return defaults;
}

export async function parseSalesJournalPerformance(
  buffer: ArrayBuffer,
  reportId: string,
  onProgress?: (current: number, total: number) => void
): Promise<PerformanceTransaction[]> {
  const wb = XLSX.read(buffer, { type: "array" });
  const transactions: PerformanceTransaction[] = [];

  const CHUNK_SIZE = 50;
  let processedRows = 0;

  // Parse all sheets — each sheet is one day's data
  const sheetNames = wb.SheetNames;

  // First pass: count rows and detect columns per sheet
  let totalRows = 0;
  const sheetData: { rows: unknown[][]; cols: ColMap }[] = [];
  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
    });
    const cols = detectColumns(sheetRows);

    let dataStart = 0;
    for (let i = 0; i < sheetRows.length; i++) {
      const c0 = sheetRows[i]?.[0];
      if (c0 == null) continue;
      const s = String(c0).trim();
      if (s.startsWith("Batch from") || /^Ticket \d+/.test(s)) {
        dataStart = i;
        break;
      }
    }
    const dataRows = sheetRows.slice(dataStart);
    totalRows += dataRows.length;
    sheetData.push({ rows: dataRows, cols });
  }

  let currentTicket: TicketContext = {
    ticketNumber: "",
    date: "",
    time: "",
    dayOfWeek: "",
    hour: 0,
    cashier: "",
    customerName: "",
  };

  for (const { rows, cols } of sheetData) {
    for (let i = 0; i < rows.length; i++) {
      if (processedRows % CHUNK_SIZE === 0) {
        onProgress?.(processedRows, totalRows);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      processedRows++;

      const row = rows[i] as unknown[];
      const col0 = row[0];

      if (col0 === null || col0 === undefined || col0 === "") continue;
      if (typeof col0 === "number" && isNaN(col0)) continue;

      const col0Str = String(col0).trim();
      if (!col0Str) continue;

      if (/^Ticket \d+/.test(col0Str)) {
        const parsed = parseTicketHeader(col0Str);
        if (parsed) currentTicket = parsed;
        continue;
      }

      if (SKIP_VALUES.has(col0Str)) continue;
      if (SKIP_PREFIXES.some((p) => col0Str.startsWith(p))) continue;

      if (!SALE_TYPES.has(col0Str)) continue;

      // For returns, look ahead for the "Return:" reason row and skip
      // if it matches an excluded reason (club transfers, credits, etc.)
      if (col0Str === "Return") {
        let excluded = false;
        for (let j = i + 1; j < Math.min(i + 4, rows.length); j++) {
          const peekRow = rows[j] as unknown[];
          const peek0 = peekRow?.[0] != null ? String(peekRow[0]).trim() : "";
          if (peek0 === "Return:") {
            const reason = peekRow[3] != null ? String(peekRow[3]).trim() : "";
            if (EXCLUDED_RETURN_REASONS.has(reason)) excluded = true;
            break;
          }
          // Skip past Discount: rows that may sit between Return and Return:
          if (peek0 !== "Discount:") break;
        }
        if (excluded) continue;
      }

      const itemRaw = row[cols.item] != null ? String(row[cols.item]) : "";
      const parts = itemRaw.split("\n");
      const sku = parts[0]?.trim() ?? "";
      const productName = parts[1]?.trim() ?? "";
      const size = parts[2]?.trim() ?? "";

      const salespersonRaw =
        row[cols.salesperson] != null
          ? String(row[cols.salesperson]).trim()
          : "";
      const salesperson = salespersonRaw.replace(/^Sales:\s*/, "").trim();

      const retailRaw = row[cols.retail];
      const salePriceRaw = row[cols.salePrice];
      const perksRaw = row[cols.perks];
      const markdownRaw = row[cols.markdown];
      const soldRaw = row[cols.sold];
      const retailPrice = typeof retailRaw === "number" ? retailRaw : 0;
      const salePrice = typeof salePriceRaw === "number" ? salePriceRaw : 0;
      const soldQty = typeof soldRaw === "number" && soldRaw > 0 ? soldRaw : 1;
      const perksTotal = typeof perksRaw === "number" ? perksRaw : 0;
      const perks = soldQty > 1 ? perksTotal / soldQty : perksTotal;
      const markdown = typeof markdownRaw === "number" ? markdownRaw : 0;

      transactions.push({
        id: crypto.randomUUID(),
        reportId,
        ticketNumber: currentTicket.ticketNumber,
        date: currentTicket.date,
        time: currentTicket.time,
        dayOfWeek: currentTicket.dayOfWeek,
        hour: currentTicket.hour,
        cashier: currentTicket.cashier,
        customerName: currentTicket.customerName,
        salesperson,
        transactionType: col0Str,
        isReturn: col0Str === "Return",
        sku,
        productName,
        size,
        retailPrice,
        salePrice,
        perks,
        markdown,
      });
    }
  }

  onProgress?.(totalRows, totalRows);
  return transactions;
}
