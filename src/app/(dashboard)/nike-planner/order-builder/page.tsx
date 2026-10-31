"use client";

import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  DragEvent,
  ChangeEvent,
} from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { Upload, Download, AlertCircle } from "lucide-react";
import { db, storage } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
} from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { NikeSku } from "@/lib/parsers/parseNikeStock";
import {
  buildHistory,
  recommend,
  ageToRun,
  sizeToCode,
  OrderRow,
} from "@/lib/nikeOrder";

const MODULE = "nike-planner";
const SHEET = "Edit Quantities";
// 0-indexed columns in the Nike.net "Edit Quantities" sheet.
const COL = {
  productName: 2, // C
  styleColor: 4, // E
  size: 5, // F
  g: 6, // G delivery 1
  h: 7, // H delivery 2
  i: 8, // I delivery 3
  franchise: 11, // L
  wholesale: 17, // R
  retail: 19, // T
  age: 25, // Z
};
const DATA_START = 5; // xlsx row 6

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function cellVal(ws: XLSX.WorkSheet, r0: number, c: number): unknown {
  const cell = ws[XLSX.utils.encode_cell({ r: r0, c })];
  return cell ? cell.v : undefined;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded p-4">
      <p className="font-heading text-brand-green text-2xl font-bold leading-none">
        {value}
      </p>
      <p className="font-body text-brand-text/50 text-xs mt-1">{label}</p>
    </div>
  );
}

export default function OrderBuilderPage() {
  // History (latest stock import)
  const [skus, setSkus] = useState<NikeSku[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyName, setHistoryName] = useState("");
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Uploaded order form
  const [bufferRef] = useState<{ current: ArrayBuffer | null }>({
    current: null,
  });
  const [orderRows, setOrderRows] = useState<OrderRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [baseline, setBaseline] = useState(12);

  useEffect(() => {
    document.title = "Order Builder · Nike Planner";
  }, []);

  // ─── Load latest stock import ────────────────────────────────────────────────

  useEffect(() => {
    async function run() {
      try {
        const snap = await getDocs(
          query(
            collection(db, "reports"),
            where("module", "==", MODULE),
            orderBy("uploadedAt", "desc"),
            limit(1)
          )
        );
        if (snap.empty) {
          setHistoryLoading(false);
          return;
        }
        const d = snap.docs[0].data() as {
          filename: string;
          storagePath: string;
        };
        setHistoryName(d.filename);
        const url = await getDownloadURL(storageRef(storage, d.storagePath));
        const res = await fetch(
          `/api/storage-proxy?url=${encodeURIComponent(url)}`
        );
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        setSkus((await res.json()) as NikeSku[]);
      } catch (err) {
        setHistoryError(
          err instanceof Error ? err.message : "Failed to load stock data."
        );
      } finally {
        setHistoryLoading(false);
      }
    }
    run();
  }, []);

  const history = useMemo(() => buildHistory(skus ?? []), [skus]);

  // ─── Parse the order form ────────────────────────────────────────────────────

  const parseOrder = useCallback(
    (buffer: ArrayBuffer, name: string) => {
      setParseError("");
      try {
        const wb = XLSX.read(buffer, { type: "array" });
        const ws = wb.Sheets[SHEET] ?? wb.Sheets[wb.SheetNames[0]];
        const ref = ws ? ws["!ref"] : undefined;
        if (!ws || !ref) throw new Error("Could not read the sheet.");
        const range = XLSX.utils.decode_range(ref);
        const rows: OrderRow[] = [];
        for (let r0 = DATA_START; r0 <= range.e.r; r0++) {
          const styleColor = String(cellVal(ws, r0, COL.styleColor) ?? "").trim();
          const size = String(cellVal(ws, r0, COL.size) ?? "").trim();
          if (!styleColor || !size) continue;
          const age = String(cellVal(ws, r0, COL.age) ?? "").trim();
          rows.push({
            r0,
            styleColor,
            productName: String(cellVal(ws, r0, COL.productName) ?? "").trim(),
            franchise: String(cellVal(ws, r0, COL.franchise) ?? "").trim(),
            age,
            size,
            code: sizeToCode(size),
            run: ageToRun(age),
            wholesale: Number(cellVal(ws, r0, COL.wholesale)) || 0,
            retail: Number(cellVal(ws, r0, COL.retail)) || 0,
          });
        }
        if (rows.length === 0)
          throw new Error(
            "No style/size rows found. Is this the Nike.net 'Edit Quantities' export?"
          );
        bufferRef.current = buffer;
        setFileName(name);
        setOrderRows(rows);
      } catch (err) {
        setParseError(
          err instanceof Error ? err.message : "Could not read this file."
        );
        setOrderRows([]);
      }
    },
    [bufferRef]
  );

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".xlsx")) return;
    const buf = await file.arrayBuffer();
    parseOrder(buf, file.name);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };
  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  // ─── Recommend ───────────────────────────────────────────────────────────────

  const result = useMemo(
    () => recommend(orderRows, history, baseline),
    [orderRows, history, baseline]
  );

  const matchedStyles = result.styles.filter((s) => s.matched && s.pairs > 0);
  const blankStyles = result.styles.filter((s) => !(s.matched && s.pairs > 0));
  const totalPairs = matchedStyles.reduce((s, x) => s + x.pairs, 0);
  const totalWholesale = matchedStyles.reduce(
    (s, x) => s + x.wholesaleTotal,
    0
  );
  const totalRetail = matchedStyles.reduce((s, x) => s + x.retailTotal, 0);
  const blankFranchises = [
    ...new Set(blankStyles.map((s) => s.franchise).filter(Boolean)),
  ].sort();

  // ─── Download the filled workbook ────────────────────────────────────────────

  const download = () => {
    if (!bufferRef.current) return;
    const wb = XLSX.read(bufferRef.current, { type: "array" });
    const ws = wb.Sheets[SHEET] ?? wb.Sheets[wb.SheetNames[0]];
    for (const rec of result.rows.values()) {
      const [g, h, i] = rec.split;
      ws[XLSX.utils.encode_cell({ r: rec.r0, c: COL.g })] = { t: "n", v: g };
      ws[XLSX.utils.encode_cell({ r: rec.r0, c: COL.h })] = { t: "n", v: h };
      ws[XLSX.utils.encode_cell({ r: rec.r0, c: COL.i })] = { t: "n", v: i };
    }
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.replace(/\.xlsx$/i, "") + " - recommended.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  const noHistory = !historyLoading && !skus;

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Order Builder
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-5">
        Upload a Nike.net order form and get it back filled with size
        recommendations, driven by your imported stock status.
      </p>

      {/* History status */}
      {historyLoading ? (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-4 mb-5 text-sm font-body text-brand-text/50">
          Loading stock history…
        </div>
      ) : noHistory ? (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-5 text-center">
          <p className="text-brand-text/50 font-body text-sm mb-3">
            No stock status imported yet — the recommendations are built from it.
          </p>
          <Link
            href="/nike-planner/import"
            className="inline-block bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
          >
            Import Stock Status →
          </Link>
        </div>
      ) : (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-4 mb-5 text-sm font-body text-brand-text/60">
          Recommendations based on{" "}
          <strong className="text-brand-text">{historyName}</strong>
          {historyError && (
            <span className="text-red-600"> · {historyError}</span>
          )}
        </div>
      )}

      {!noHistory && !historyLoading && (
        <>
          {/* Upload */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={onDrop}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors mb-5 ${
              isDragging
                ? "border-brand-green bg-brand-green/5"
                : "border-brand-cream-dark hover:border-brand-green/40 bg-white"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={onInput}
              className="hidden"
            />
            <Upload className="w-7 h-7 mx-auto mb-2 text-brand-cream-dark" />
            {fileName ? (
              <p className="font-body text-sm text-brand-text">
                <span className="font-semibold">{fileName}</span>
                <span className="text-brand-text/40 text-xs block mt-1">
                  {orderRows.length.toLocaleString()} size rows · click to change
                </span>
              </p>
            ) : (
              <p className="font-body text-sm text-brand-text/50">
                Drag &amp; drop the Nike.net order form (.xlsx), or click to
                browse
              </p>
            )}
          </div>

          {parseError && (
            <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-4 mb-5 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <p className="font-body text-sm text-red-600">{parseError}</p>
            </div>
          )}

          {orderRows.length > 0 && (
            <>
              {/* Controls */}
              <div className="bg-white border border-brand-cream-dark rounded px-4 py-3 flex flex-wrap items-center gap-4 mb-5">
                <label className="flex items-center gap-2 font-body text-sm">
                  <span className="text-brand-text/60">
                    Baseline pairs / colorway
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={baseline}
                    onChange={(e) =>
                      setBaseline(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="w-20 border border-brand-cream-dark rounded px-2 py-1 text-sm text-brand-text focus:outline-none focus:border-brand-green"
                  />
                </label>
                <span className="font-body text-xs text-brand-text/40">
                  Depth = baseline × (0.5 + sell-through), so hot families buy
                  deeper. Spread by each family&apos;s historical size curve.
                </span>
                <button
                  onClick={download}
                  disabled={matchedStyles.length === 0}
                  className="ml-auto flex items-center gap-1.5 bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40"
                >
                  <Download className="w-4 h-4" />
                  Download filled form
                </button>
              </div>

              {/* Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                <StatCard
                  label="Styles recommended"
                  value={`${matchedStyles.length} / ${result.styles.length}`}
                />
                <StatCard
                  label="Total pairs"
                  value={totalPairs.toLocaleString()}
                />
                <StatCard
                  label="Wholesale cost"
                  value={fmtMoney(totalWholesale)}
                />
                <StatCard
                  label="Retail value"
                  value={fmtMoney(totalRetail)}
                />
              </div>

              {/* Recommended styles */}
              <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto mb-5">
                <table className="w-full text-sm font-body min-w-[820px]">
                  <thead>
                    <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                      <th className="px-3 py-2 font-normal">Product</th>
                      <th className="px-3 py-2 font-normal">Style-Color</th>
                      <th className="px-3 py-2 font-normal">Run</th>
                      <th className="px-3 py-2 font-normal text-right">Depth</th>
                      <th className="px-3 py-2 font-normal text-right">Pairs</th>
                      <th className="px-3 py-2 font-normal text-right">
                        Wholesale
                      </th>
                      <th className="px-3 py-2 font-normal">Size spread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchedStyles.map((s) => (
                      <tr
                        key={s.styleColor}
                        className="border-b border-brand-cream last:border-0"
                      >
                        <td className="px-3 py-2 text-brand-text">
                          {s.productName}
                          <span className="text-brand-text/40 text-xs block">
                            {s.franchise}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-brand-text/70 whitespace-nowrap">
                          {s.styleColor}
                        </td>
                        <td className="px-3 py-2 text-brand-text/60 text-xs">
                          {s.run}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {s.depth}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {s.pairs}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-brand-text/60">
                          {fmtMoney(s.wholesaleTotal)}
                        </td>
                        <td className="px-3 py-2 text-xs text-brand-text/60">
                          {s.sizes
                            .map((z) => `${z.size}:${z.qty}`)
                            .join("  ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Left blank */}
              {blankStyles.length > 0 && (
                <div className="bg-brand-cream/40 border border-brand-cream-dark rounded p-4 font-body text-sm text-brand-text/60">
                  <strong className="text-brand-text/80">
                    {blankStyles.length} style-colors
                  </strong>{" "}
                  were left blank — no matching sales history in this stock
                  status (you don&apos;t carry them, or they&apos;re brand new).
                  {blankFranchises.length > 0 && (
                    <div className="mt-1.5 text-xs text-brand-text/45">
                      Franchises skipped: {blankFranchises.join(", ")}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
