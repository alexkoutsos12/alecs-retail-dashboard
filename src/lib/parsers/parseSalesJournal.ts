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
  const cashierMatch = normalized.match(/by Cashier:\s+(.*?)\s+for Customer:/);
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
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
  });

  // Skip rows 0–5; data begins at row index 6
  const rows = allRows.slice(6);
  const total = rows.length;
  const transactions: Transaction[] = [];

  const CHUNK_SIZE = 50;

  let currentTicket: TicketContext = {
    ticketNumber: "",
    date: "",
    time: "",
    cashier: "",
    customerName: "",
  };

  for (let i = 0; i < rows.length; i++) {
    if (i % CHUNK_SIZE === 0) {
      onProgress?.(i, total);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

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

    const itemRaw = row[2] != null ? String(row[2]) : "";
    const parts = itemRaw.split("\n");
    const sku = parts[0]?.trim() ?? "";
    const productName = parts[1]?.trim() ?? "";
    const size = parts[2]?.trim() ?? "";

    const salespersonRaw = row[5] != null ? String(row[5]).trim() : "";
    const salesperson = salespersonRaw.replace(/^Sales:\s*/, "").trim();

    const retailPrice = typeof row[13] === "number" ? row[13] : 0;
    const salePrice = typeof row[14] === "number" ? row[14] : 0;
    const perks = typeof row[15] === "number" ? row[15] : 0;
    const markdown = typeof row[16] === "number" ? row[16] : 0;

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

  onProgress?.(total, total);
  return transactions;
}
