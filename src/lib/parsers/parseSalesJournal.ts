import * as XLSX from "xlsx";

export interface Transaction {
  id: string;
  reportId: string;
  ticketNumber: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM AM/PM
  cashier: string;
  customerName: string;
  salesperson: string;
  transactionType: string;
  sku: string;
  productName: string;
  size: string;
  retailPrice: number;
  salePrice: number;
  perks: number; // exact dollar value — never cast to boolean
  markdown: number;
  isOutlet: boolean; // perks === 1
  isPayablePerk: boolean; // perks > 1
  hasPerk: boolean; // perks > 0
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

interface TicketContext {
  ticketNumber: string;
  date: string;
  time: string;
  cashier: string;
  customerName: string;
}

function parseTicketHeader(col0Str: string): TicketContext | null {
  if (!/^Ticket \d+/.test(col0Str)) return null;

  // Normalize internal whitespace (multi-line cells become spaces)
  const normalized = col0Str.replace(/\s+/g, " ").trim();

  const ticketNumMatch = normalized.match(/^Ticket (\d+)/);
  if (!ticketNumMatch) return null;

  const dateMatch = normalized.match(/on\s+(\d{2}\/\d{2}\/\d{4})/);
  const timeMatch = normalized.match(/(\d{1,2}:\d{2}\s+[AP]M)/);
  const cashierMatch = normalized.match(/by Cashier:\s+(.*?)(?:\s+for Customer:|$)/);
  const customerMatch = normalized.match(/for Customer:\s+\d+\s+(.*?)$/);

  const dateStr = dateMatch?.[1] ?? "";
  let date = "";
  if (dateStr) {
    const [month, day, year] = dateStr.split("/");
    date = `${year}-${month}-${day}`;
  }

  return {
    ticketNumber: ticketNumMatch[1],
    date,
    time: timeMatch?.[1]?.trim() ?? "",
    cashier: cashierMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "",
    customerName: customerMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "",
  };
}

export async function parseSalesJournal(
  buffer: ArrayBuffer,
  reportId: string,
  onProgress?: (current: number, total: number) => void
): Promise<Transaction[]> {
  const wb = XLSX.read(buffer, { type: "array" });
  const transactions: Transaction[] = [];

  // Column positions vary between sheets, so we detect them from the header
  // row (the row containing "Retail", "Perks", etc.) on each sheet.
  interface ColMap {
    item: number;       // SKU\nProduct\nSize
    salesperson: number;
    sold: number;       // quantity sold on this line
    retail: number;
    salePrice: number;
    perks: number;
    markdown: number;
  }

  function detectColumns(sheetRows: unknown[][]): ColMap {
    // Default layout (Sheet 0 / single-day files)
    const defaults: ColMap = { item: 2, salesperson: 5, sold: 8, retail: 12, salePrice: 13, perks: 15, markdown: 16 };

    for (let i = 0; i < Math.min(sheetRows.length, 40); i++) {
      const row = sheetRows[i];
      if (!row) continue;
      // Look for the header row that contains "Retail"
      let retailCol = -1;
      for (let c = 0; c < 30; c++) {
        if (row[c] != null && String(row[c]).trim() === "Retail") {
          retailCol = c;
          break;
        }
      }
      if (retailCol === -1) continue;

      // Found the header row — map columns by looking for known headers
      const map: ColMap = { ...defaults };
      map.retail = retailCol;
      for (let c = 0; c < 30; c++) {
        const v = row[c] != null ? String(row[c]).trim() : "";
        if (v === "Price") map.salePrice = c;
        if (v === "Perks") map.perks = c;
        if (v === "Markdown") map.markdown = c;
        if (v === "Sold") map.sold = c;
      }

      // Find item and salesperson columns from the first actual sale row
      for (let j = i + 1; j < Math.min(sheetRows.length, i + 50); j++) {
        const saleRow = sheetRows[j];
        if (!saleRow) continue;
        const c0 = saleRow[0] != null ? String(saleRow[0]).trim() : "";
        if (!SALE_TYPES.has(c0)) continue;
        // Item column: contains newlines (SKU\nProduct\nSize)
        for (let c = 1; c < 10; c++) {
          if (saleRow[c] != null && String(saleRow[c]).includes("\n")) {
            map.item = c;
            break;
          }
        }
        // Salesperson column: contains "Sales:"
        for (let c = 1; c < 15; c++) {
          if (saleRow[c] != null && String(saleRow[c]).trim().startsWith("Sales:")) {
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

  // Process each sheet independently with its own column mapping
  const CHUNK_SIZE = 50;
  let processedRows = 0;

  // First pass: count total data rows for progress reporting
  let totalRows = 0;
  const sheetData: { rows: unknown[][]; cols: ColMap }[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
    });
    const cols = detectColumns(sheetRows);

    // Find where transaction data starts
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

      // Skip null / undefined / empty / NaN
      if (col0 === null || col0 === undefined || col0 === "") continue;
      if (typeof col0 === "number" && isNaN(col0)) continue;

      const col0Str = String(col0).trim();
      if (!col0Str) continue;

      // Ticket header row
      if (/^Ticket \d+/.test(col0Str)) {
        const parsed = parseTicketHeader(col0Str);
        if (parsed) currentTicket = parsed;
        continue;
      }

      // Explicit skip values
      if (SKIP_VALUES.has(col0Str)) continue;
      if (SKIP_PREFIXES.some((p) => col0Str.startsWith(p))) continue;

      // Sale row
      if (!SALE_TYPES.has(col0Str)) continue;

      const itemRaw = row[cols.item] != null ? String(row[cols.item]) : "";
      const parts = itemRaw.split("\n");
      const sku = parts[0]?.trim() ?? "";
      const productName = parts[1]?.trim() ?? "";
      const size = parts[2]?.trim() ?? "";

      const salespersonRaw = row[cols.salesperson] != null ? String(row[cols.salesperson]).trim() : "";
      const salesperson = salespersonRaw.replace(/^Sales:\s*/, "").trim();

      const retailRaw = row[cols.retail];
      const salePriceRaw = row[cols.salePrice];
      const perksRaw = row[cols.perks];
      const markdownRaw = row[cols.markdown];
      const soldRaw = row[cols.sold];
      const retailPrice = typeof retailRaw === "number" ? retailRaw : 0;
      const salePrice = typeof salePriceRaw === "number" ? salePriceRaw : 0;
      const soldQty = typeof soldRaw === "number" && soldRaw > 0 ? soldRaw : 1;
      // Perks column is the total for the line; divide by quantity to get per-unit perk
      const perksTotal = typeof perksRaw === "number" ? perksRaw : 0;
      const perks = soldQty > 1 ? perksTotal / soldQty : perksTotal;
      const markdown = typeof markdownRaw === "number" ? markdownRaw : 0;

      const isOutlet = perks === 1;
      const isPayablePerk = perks > 1;
      const hasPerk = perks > 0;

      transactions.push({
        id: crypto.randomUUID(),
        reportId,
        ticketNumber: currentTicket.ticketNumber,
        date: currentTicket.date,
        time: currentTicket.time,
        cashier: currentTicket.cashier,
        customerName: currentTicket.customerName,
        salesperson,
        transactionType: col0Str,
        sku,
        productName,
        size,
        retailPrice,
        salePrice,
        perks,
        markdown,
        isOutlet,
        isPayablePerk,
        hasPerk,
      });
    }
  }

  onProgress?.(totalRows, totalRows);
  return transactions;
}
