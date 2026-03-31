import * as XLSX from "xlsx";
import { classifyByCode } from "@/lib/categoryMap";

export interface SkuSize {
  size: string;
  qty: number;
}

export interface SkuWidth {
  width: string;
  available: SkuSize[];
}

export interface SkuItem {
  id: string;
  reportId: string;
  sku: string;
  description: string;
  color: string;
  supplier: string;
  class: string;
  gender: string;
  mainCategory: string;
  perk: number;
  sizes: SkuWidth[];
  totalOnHand: number;
}

export interface StockStatusResult {
  skus: SkuItem[];
  importDate: string;
  excludedDollarOneSkus: string[];
}

/**
 * Parse a RICS Stock Status Excel file into SKU inventory items.
 */
export function parseStockStatus(
  buffer: ArrayBuffer,
  reportId: string,
  onProgress?: (current: number, total: number) => void
): StockStatusResult {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: (string | number | null)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
  });

  // Extract import date from row 3 — look for MM/DD/YYYY pattern
  let importDate = "";
  const row3 = rows[3];
  if (row3) {
    const row3Str = row3.filter(Boolean).join(" ");
    const dateMatch = row3Str.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dateMatch) {
      const [m, d, y] = dateMatch[1].split("/");
      importDate = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }

  // Column indices from the spec
  const COL_SKU = 0;
  const COL_DESC = 7;
  const COL_COLOR = 22;
  const COL_WIDTH = 26;
  const COL_SUPPLIER = 29;
  const COL_CLASS = 46;
  const COL_PERK = 75;

  // Identify SKU header rows — col[0] has a value that looks like a SKU
  // (not a header label, store name, or summary).
  // SKU rows start at row 8+.
  const DATA_START = 8;
  const totalRows = rows.length;

  interface SkuBlock {
    headerRow: number;
    sku: string;
    description: string;
    color: string;
    supplier: string;
    classValue: string;
    perk: number;
  }

  // First pass: find all SKU header rows
  const skuBlocks: SkuBlock[] = [];
  for (let i = DATA_START; i < totalRows; i++) {
    const row = rows[i];
    if (!row) continue;

    const cellSku = row[COL_SKU];
    if (cellSku == null || String(cellSku).trim() === "") continue;

    const skuStr = String(cellSku).trim();

    // Skip header/summary rows — SKUs are typically alphanumeric codes
    // Headers contain words like "SKU", "Store", "Total", etc.
    if (
      /^(sku|store|total|grand|report|page)/i.test(skuStr) ||
      skuStr.length < 2
    )
      continue;

    const perkVal = row[COL_PERK];
    const perk = typeof perkVal === "number" ? perkVal : parseFloat(String(perkVal || "0")) || 0;

    skuBlocks.push({
      headerRow: i,
      sku: skuStr,
      description: String(row[COL_DESC] ?? "").trim(),
      color: String(row[COL_COLOR] ?? "").trim(),
      supplier: String(row[COL_SUPPLIER] ?? "").trim(),
      classValue: String(row[COL_CLASS] ?? "").trim(),
      perk,
    });
  }

  // Second pass: for each SKU block, parse size labels and width rows
  const skus: SkuItem[] = [];
  const excludedDollarOneSkus: string[] = [];

  for (let b = 0; b < skuBlocks.length; b++) {
    if (onProgress) onProgress(b, skuBlocks.length);

    const block = skuBlocks[b];
    const nextBlockRow =
      b + 1 < skuBlocks.length ? skuBlocks[b + 1].headerRow : totalRows;

    // $1 perk exclusion
    if (block.perk === 1) {
      excludedDollarOneSkus.push(block.sku);
      continue;
    }

    // Skip SKUs with no perk (perk === 0 means not a perk item)
    if (block.perk <= 0) continue;

    // Row after header = size labels
    const sizeLabelsRow = rows[block.headerRow + 1];
    if (!sizeLabelsRow) continue;

    // Build size label map: column index → size string
    // Size labels are numeric values in the row after the SKU header.
    // The "Total" column is the last one — we skip it.
    const sizeColumns: { col: number; label: string }[] = [];
    for (let c = COL_WIDTH + 1; c < sizeLabelsRow.length; c++) {
      const val = sizeLabelsRow[c];
      if (val == null) continue;
      const label = String(val).trim();
      if (label === "" || /^total$/i.test(label)) continue;
      sizeColumns.push({ col: c, label });
    }

    if (sizeColumns.length === 0) continue;

    // Width rows: from headerRow+2 to nextBlockRow
    const widths: SkuWidth[] = [];
    for (let r = block.headerRow + 2; r < nextBlockRow; r++) {
      const row = rows[r];
      if (!row) continue;

      // Skip if this looks like a new SKU header (has col[0] data)
      if (row[COL_SKU] != null && String(row[COL_SKU]).trim() !== "") break;

      // Width may be empty for single-width SKUs (e.g. children's)
      const widthVal = row[COL_WIDTH];
      const widthStr =
        widthVal != null && String(widthVal).trim() !== ""
          ? String(widthVal).trim()
          : "STD";

      const available: SkuSize[] = [];
      for (const sc of sizeColumns) {
        const qty = row[sc.col];
        if (qty != null && typeof qty === "number" && qty > 0) {
          available.push({ size: sc.label, qty });
        }
      }

      if (available.length > 0) {
        widths.push({ width: widthStr, available });
      }
    }

    // Skip SKUs with zero inventory
    if (widths.length === 0) continue;

    const totalOnHand = widths.reduce(
      (sum, w) => sum + w.available.reduce((s, a) => s + a.qty, 0),
      0
    );

    const { gender, mainCategory } = classifyByCode(block.classValue);

    skus.push({
      id: crypto.randomUUID(),
      reportId,
      sku: block.sku,
      description: block.description,
      color: block.color,
      supplier: block.supplier,
      class: block.classValue,
      gender,
      mainCategory,
      perk: block.perk,
      sizes: widths,
      totalOnHand,
    });
  }

  if (onProgress) onProgress(skuBlocks.length, skuBlocks.length);

  return { skus, importDate, excludedDollarOneSkus };
}
