import * as XLSX from "xlsx";
import {
  SizeRun,
  Gender,
  resolveRun,
  resolveGender,
  resolveFamily,
  sizeLabel,
  sizeOrder,
} from "./parseNikeStock";

/**
 * Nike on-order (Purchase Order) CSV parser.
 *
 * RICS exports one row per (PO, SKU, size). This collapses to one record per
 * SKU with its purchase orders broken out — each PO carries its name, ship
 * date, and open (still-to-receive) quantity by size — plus an aggregated
 * on-order size curve. Keyed by SKU so the Planner can merge it onto the
 * matching stock item (or surface it as an on-order-only style).
 */

export interface OnOrderPO {
  poNumber: string;
  shipDate: string; // display, e.g. "3/1/2027"
  shipSort: string; // sortable, e.g. "2027-03-01"
  orderDate: string;
  sizes: { code: number; label: string; order: number; open: number }[];
  total: number;
}

export interface OnOrderSizeCell {
  code: number;
  label: string;
  order: number;
  onOrder: number;
}

export interface OnOrderSku {
  sku: string;
  description: string;
  color: string;
  classCode: string;
  className: string;
  gender: Gender;
  run: SizeRun;
  styleFamily: string;
  retailPrice: number;
  cost: number;
  onOrder: number; // total open across all POs
  pos: OnOrderPO[];
  sizes: OnOrderSizeCell[]; // aggregated open by size
}

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

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Excel serial date (1900 system) -> JS Date (UTC). */
function excelSerialToDate(n: number): Date {
  return new Date((Math.round(n) - 25569) * 86400000);
}

/**
 * Normalize a RICS ship/order date into a plain display string and a sortable
 * key. The value may arrive as "M/D/YYYY" text, a JS Date, or — when the CSV is
 * read through the spreadsheet engine — an Excel date serial number like 46054.
 */
function formatDate(v: unknown): { display: string; sort: string } {
  let d: Date | null = null;
  if (typeof v === "number" && v > 0) d = excelSerialToDate(v);
  else if (v instanceof Date) d = v;
  else {
    const s = String(v ?? "").trim();
    if (!s) return { display: "", sort: "" };
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    else if (/^\d+$/.test(s)) d = excelSerialToDate(+s);
    else return { display: s, sort: s };
  }
  if (!d || Number.isNaN(d.getTime())) {
    const s = String(v ?? "");
    return { display: s, sort: s };
  }
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  return {
    display: `${MONTHS[mo]} ${day}, ${y}`,
    sort: `${y}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

interface Accum {
  first: Record<string, unknown>;
  pos: Map<
    string,
    { shipDisplay: string; shipSort: string; orderDisplay: string; sizes: Map<number, number> }
  >;
  sizes: Map<number, number>;
}

export async function parseNikeOnOrder(
  buffer: ArrayBuffer
): Promise<OnOrderSku[]> {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: null,
  });
  const keyOf = (row: Record<string, unknown>, name: string): unknown => {
    for (const k of Object.keys(row))
      if (k.replace(/^﻿/, "").trim() === name) return row[k];
    return null;
  };

  // Does the export carry an OpenQty column? When it does, it is authoritative:
  // a blank means the line is fully received (0 still open), NOT "fall back to
  // the ordered quantity" — otherwise received stock is double-counted as
  // on-order. Only when the column is absent do we derive open = ordered − rcvd.
  const hasOpenCol =
    rows.length > 0 &&
    Object.keys(rows[0]).some((k) => k.replace(/^﻿/, "").trim() === "OpenQty");

  const bySku = new Map<string, Accum>();
  for (const row of rows) {
    const sku = str(keyOf(row, "SKU"));
    if (!sku) continue;
    const code = Math.round(num(keyOf(row, "COL")));
    if (code <= 0) continue;
    let open: number;
    if (hasOpenCol) {
      const openRaw = keyOf(row, "OpenQty");
      open =
        openRaw == null || String(openRaw).trim() === "" ? 0 : num(openRaw);
    } else {
      open = Math.max(
        0,
        num(keyOf(row, "OrderedQty")) - num(keyOf(row, "RcvdQty"))
      );
    }
    if (open <= 0) continue;

    let acc = bySku.get(sku);
    if (!acc) {
      acc = { first: row, pos: new Map(), sizes: new Map() };
      bySku.set(sku, acc);
    }
    const poName = str(keyOf(row, "PONumber")) || "(no PO)";
    let po = acc.pos.get(poName);
    if (!po) {
      const ship = formatDate(keyOf(row, "ShipDate"));
      po = {
        shipDisplay: ship.display,
        shipSort: ship.sort,
        orderDisplay: formatDate(keyOf(row, "OrderDate")).display,
        sizes: new Map(),
      };
      acc.pos.set(poName, po);
    }
    po.sizes.set(code, (po.sizes.get(code) ?? 0) + open);
    acc.sizes.set(code, (acc.sizes.get(code) ?? 0) + open);
  }

  const out: OnOrderSku[] = [];
  for (const [sku, acc] of bySku) {
    const row = acc.first;
    const description = str(keyOf(row, "Description"));
    const className = str(keyOf(row, "Class3"));
    const codes = [...acc.sizes.keys()];
    const run = resolveRun(description, codes);

    const pos: OnOrderPO[] = [...acc.pos.entries()]
      .map(([poNumber, p]) => {
        const sizes = [...p.sizes.entries()]
          .map(([code, open]) => ({
            code,
            label: sizeLabel(code),
            order: sizeOrder(code, run),
            open,
          }))
          .sort((a, b) => a.order - b.order);
        return {
          poNumber,
          shipDate: p.shipDisplay,
          shipSort: p.shipSort,
          orderDate: p.orderDisplay,
          sizes,
          total: sizes.reduce((s, c) => s + c.open, 0),
        };
      })
      .sort((a, b) => a.shipSort.localeCompare(b.shipSort));

    const sizes: OnOrderSizeCell[] = codes
      .map((code) => ({
        code,
        label: sizeLabel(code),
        order: sizeOrder(code, run),
        onOrder: acc.sizes.get(code)!,
      }))
      .sort((a, b) => a.order - b.order);

    out.push({
      sku,
      description,
      color: str(keyOf(row, "Color")),
      classCode: (className.match(/^\d+/) ?? [""])[0],
      className: className.replace(/^\d+\s*-\s*/, "").trim(),
      gender: resolveGender(className),
      run,
      styleFamily: resolveFamily(description, className),
      retailPrice: num(keyOf(row, "SkuRetail")),
      cost: num(keyOf(row, "SkuCost")),
      onOrder: sizes.reduce((s, c) => s + c.onOrder, 0),
      pos,
      sizes,
    });
  }

  return out;
}
