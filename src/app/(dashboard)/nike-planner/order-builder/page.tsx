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
import { Upload, Download, AlertCircle, Check } from "lucide-react";
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
import { NikeSku, SizeRun } from "@/lib/parsers/parseNikeStock";
import {
  buildHistory,
  recommend,
  matchKey,
  ageToRun,
  sizeToCode,
  OrderRow,
} from "@/lib/nikeOrder";
import { extractRowImages } from "@/lib/xlsxImages";

const MODULE = "nike-planner";
const SHEET = "Edit Quantities";
const COL = {
  productName: 2,
  styleColor: 4,
  size: 5,
  g: 6,
  h: 7,
  i: 8,
  franchise: 11,
  color: 16, // Q Color Description
  wholesale: 17,
  retail: 19,
  age: 25,
};
const DATA_START = 5;

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

interface Colorway {
  styleColor: string;
  color: string;
  run: SizeRun;
  retail: number;
  wholesale: number;
  image?: string;
  hasHistory: boolean;
}
interface Product {
  styleNumber: string;
  name: string;
  franchise: string;
  runs: string;
  carried: boolean;
  sellThrough: number;
  colorways: Colorway[];
}

export default function OrderBuilderPage() {
  const [skus, setSkus] = useState<NikeSku[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyName, setHistoryName] = useState("");
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [bufferRef] = useState<{ current: ArrayBuffer | null }>({
    current: null,
  });
  const [orderRows, setOrderRows] = useState<OrderRow[]>([]);
  const [colorByStyle, setColorByStyle] = useState<Map<string, string>>(
    new Map()
  );
  const [images, setImages] = useState<Map<number, string>>(new Map());
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [kept, setKept] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"review" | "build">("review");
  const [reviewFilter, setReviewFilter] = useState<"all" | "carried" | "new">(
    "all"
  );
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

  // ─── Parse order form ────────────────────────────────────────────────────────
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
        const colors = new Map<string, string>();
        for (let r0 = DATA_START; r0 <= range.e.r; r0++) {
          const styleColor = String(
            cellVal(ws, r0, COL.styleColor) ?? ""
          ).trim();
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
          if (!colors.has(styleColor)) {
            colors.set(
              styleColor,
              String(cellVal(ws, r0, COL.color) ?? "").trim()
            );
          }
        }
        if (rows.length === 0)
          throw new Error(
            "No style/size rows found. Is this the Nike.net 'Edit Quantities' export?"
          );
        bufferRef.current = buffer;
        setFileName(name);
        setColorByStyle(colors);
        setImages(extractRowImages(buffer));
        setOrderRows(rows);
        setPhase("review");
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
    parseOrder(await file.arrayBuffer(), file.name);
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

  // ─── Products (by style number) ──────────────────────────────────────────────
  const products = useMemo<Product[]>(() => {
    const byNum = new Map<string, OrderRow[]>();
    for (const r of orderRows) {
      const num = r.styleColor.split("-")[0];
      if (!byNum.has(num)) byNum.set(num, []);
      byNum.get(num)!.push(r);
    }
    const out: Product[] = [];
    for (const [num, rows] of byNum) {
      const cwMap = new Map<string, OrderRow[]>();
      for (const r of rows) {
        if (!cwMap.has(r.styleColor)) cwMap.set(r.styleColor, []);
        cwMap.get(r.styleColor)!.push(r);
      }
      const colorways: Colorway[] = [];
      let carried = false;
      let sellThrough = 0;
      for (const [sc, crows] of cwMap) {
        const f = crows[0];
        const st = history.get(`${matchKey(f.franchise)}::${f.run}`);
        const has = !!st && st.totalSold > 0;
        if (has && st) {
          carried = true;
          sellThrough = Math.max(sellThrough, st.sellThrough);
        }
        let image: string | undefined;
        for (const r of crows) {
          const im = images.get(r.r0);
          if (im) {
            image = im;
            break;
          }
        }
        colorways.push({
          styleColor: sc,
          color: colorByStyle.get(sc) ?? "",
          run: f.run,
          retail: f.retail,
          wholesale: f.wholesale,
          image,
          hasHistory: has,
        });
      }
      const first = rows[0];
      out.push({
        styleNumber: num,
        name: first.productName,
        franchise: first.franchise,
        runs: [...new Set(rows.map((r) => r.run))].join(", "),
        carried,
        sellThrough,
        colorways,
      });
    }
    return out.sort(
      (a, b) => Number(b.carried) - Number(a.carried) || a.name.localeCompare(b.name)
    );
  }, [orderRows, colorByStyle, images, history]);

  // Pre-keep carried colorways once per upload.
  const initRef = useRef<OrderRow[] | null>(null);
  useEffect(() => {
    if (orderRows.length === 0 || initRef.current === orderRows) return;
    initRef.current = orderRows;
    const def = new Set<string>();
    const seen = new Set<string>();
    for (const r of orderRows) {
      if (seen.has(r.styleColor)) continue;
      seen.add(r.styleColor);
      const st = history.get(`${matchKey(r.franchise)}::${r.run}`);
      if (st && st.totalSold > 0) def.add(r.styleColor);
    }
    setKept(def);
  }, [orderRows, history]);

  const totalColorways = useMemo(
    () => new Set(orderRows.map((r) => r.styleColor)).size,
    [orderRows]
  );

  const keptRows = useMemo(
    () => orderRows.filter((r) => kept.has(r.styleColor)),
    [orderRows, kept]
  );
  const result = useMemo(
    () => recommend(keptRows, history, baseline),
    [keptRows, history, baseline]
  );
  const matchedStyles = result.styles.filter((s) => s.matched && s.pairs > 0);
  const totalPairs = matchedStyles.reduce((s, x) => s + x.pairs, 0);
  const totalWholesale = matchedStyles.reduce((s, x) => s + x.wholesaleTotal, 0);
  const totalRetail = matchedStyles.reduce((s, x) => s + x.retailTotal, 0);

  // ─── Keep toggles ────────────────────────────────────────────────────────────
  const toggleCw = (sc: string) =>
    setKept((p) => {
      const n = new Set(p);
      if (n.has(sc)) n.delete(sc);
      else n.add(sc);
      return n;
    });
  const setProduct = (p: Product, on: boolean) =>
    setKept((prev) => {
      const n = new Set(prev);
      for (const cw of p.colorways) {
        if (on) n.add(cw.styleColor);
        else n.delete(cw.styleColor);
      }
      return n;
    });
  const setAll = (on: boolean) =>
    setKept(on ? new Set(orderRows.map((r) => r.styleColor)) : new Set());

  const visibleProducts = products.filter((p) =>
    reviewFilter === "all"
      ? true
      : reviewFilter === "carried"
      ? p.carried
      : !p.carried
  );

  // ─── Download ────────────────────────────────────────────────────────────────
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

  const noHistory = !historyLoading && !skus;

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Order Builder
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-5">
        Pick the styles you want, then get the Nike.net form back filled with
        size recommendations from your stock history.
      </p>

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
          Based on <strong className="text-brand-text">{historyName}</strong>
          {historyError && <span className="text-red-600"> · {historyError}</span>}
        </div>
      )}

      {!noHistory && !historyLoading && (
        <>
          {/* Upload */}
          {orderRows.length === 0 && (
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
              <p className="font-body text-sm text-brand-text/50">
                Drag &amp; drop the Nike.net order form (.xlsx), or click to
                browse
              </p>
            </div>
          )}

          {parseError && (
            <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-4 mb-5 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <p className="font-body text-sm text-red-600">{parseError}</p>
            </div>
          )}

          {/* ─── REVIEW PHASE ─── */}
          {orderRows.length > 0 && phase === "review" && (
            <>
              <div className="sticky top-0 z-20 bg-brand-cream pt-1 pb-3 mb-3">
                <div className="bg-white border border-brand-cream-dark rounded px-4 py-3 flex flex-wrap items-center gap-3">
                  <span className="font-body text-sm text-brand-text">
                    <strong>{kept.size}</strong> of {totalColorways} colorways
                    kept
                    <span className="text-brand-text/40">
                      {" "}
                      · ~{totalPairs} pairs · {fmtMoney(totalWholesale)} wholesale
                    </span>
                  </span>
                  <div className="flex gap-1">
                    {(["all", "carried", "new"] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setReviewFilter(f)}
                        className={`font-body text-xs px-2.5 py-1 rounded transition-colors ${
                          reviewFilter === f
                            ? "bg-brand-green text-brand-cream"
                            : "bg-brand-cream text-brand-text/70 hover:bg-brand-cream-dark"
                        }`}
                      >
                        {f === "all"
                          ? "All"
                          : f === "carried"
                          ? "Carried"
                          : "New franchises"}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex gap-3 items-center">
                    <button
                      onClick={() => setAll(true)}
                      className="font-body text-xs text-brand-green hover:underline"
                    >
                      Keep all
                    </button>
                    <button
                      onClick={() => setAll(false)}
                      className="font-body text-xs text-brand-text/50 hover:underline"
                    >
                      Skip all
                    </button>
                    <button
                      onClick={() => setPhase("build")}
                      disabled={kept.size === 0}
                      className="bg-brand-green text-brand-cream font-body text-sm px-4 py-1.5 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40"
                    >
                      Build order →
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {visibleProducts.map((p) => (
                  <ProductCard
                    key={p.styleNumber}
                    product={p}
                    kept={kept}
                    onToggle={toggleCw}
                    onSetProduct={setProduct}
                  />
                ))}
              </div>
            </>
          )}

          {/* ─── BUILD PHASE ─── */}
          {orderRows.length > 0 && phase === "build" && (
            <>
              <div className="bg-white border border-brand-cream-dark rounded px-4 py-3 flex flex-wrap items-center gap-4 mb-5">
                <button
                  onClick={() => setPhase("review")}
                  className="font-body text-sm text-brand-text/60 hover:underline"
                >
                  ← Back to review
                </button>
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
                  Depth = baseline × (0.5 + sell-through); spread by each
                  family&apos;s historical size curve.
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

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                <StatCard
                  label="Styles ordered"
                  value={String(matchedStyles.length)}
                />
                <StatCard label="Total pairs" value={totalPairs.toLocaleString()} />
                <StatCard label="Wholesale cost" value={fmtMoney(totalWholesale)} />
                <StatCard label="Retail value" value={fmtMoney(totalRetail)} />
              </div>

              {matchedStyles.length === 0 ? (
                <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center font-body text-sm text-brand-text/50">
                  None of the kept styles have sales history to size from. Go
                  back and keep styles your stock status carries.
                </div>
              ) : (
                <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
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
                            {s.sizes.map((z) => `${z.size}:${z.qty}`).join("  ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Product review card ──────────────────────────────────────────────────────

function ProductCard({
  product,
  kept,
  onToggle,
  onSetProduct,
}: {
  product: Product;
  kept: Set<string>;
  onToggle: (sc: string) => void;
  onSetProduct: (p: Product, on: boolean) => void;
}) {
  const keptCount = product.colorways.filter((c) =>
    kept.has(c.styleColor)
  ).length;
  return (
    <div className="bg-white border border-brand-cream-dark rounded p-3">
      <div className="flex items-center gap-2 mb-2.5 flex-wrap">
        <span className="font-heading font-bold text-brand-text text-sm">
          {product.name}
        </span>
        <span className="font-body text-xs text-brand-text/40">
          {product.franchise} · {product.runs}
        </span>
        {product.carried ? (
          <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-body font-medium">
            You sell this · {Math.round(product.sellThrough * 100)}% sell-through
          </span>
        ) : (
          <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-body font-medium">
            New — no history
          </span>
        )}
        <div className="ml-auto flex gap-3 text-xs font-body">
          <button
            onClick={() => onSetProduct(product, true)}
            className="text-brand-green hover:underline"
          >
            Keep all
          </button>
          <button
            onClick={() => onSetProduct(product, false)}
            className="text-brand-text/50 hover:underline"
          >
            Skip all
          </button>
          <span className="text-brand-text/40">
            {keptCount}/{product.colorways.length}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {product.colorways.map((cw) => {
          const on = kept.has(cw.styleColor);
          return (
            <button
              key={cw.styleColor}
              onClick={() => onToggle(cw.styleColor)}
              title={cw.color}
              className={`relative w-[108px] text-left rounded border transition-all ${
                on
                  ? "border-brand-green ring-1 ring-brand-green bg-brand-green/5"
                  : "border-brand-cream-dark opacity-70 hover:opacity-100"
              }`}
            >
              {on && (
                <span className="absolute top-1 right-1 bg-brand-green text-brand-cream rounded-full p-0.5 z-10">
                  <Check className="w-3 h-3" />
                </span>
              )}
              <div className="h-[80px] bg-white rounded-t flex items-center justify-center overflow-hidden">
                {cw.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cw.image}
                    alt={cw.color}
                    className={`max-h-[78px] max-w-full object-contain ${
                      on ? "" : "grayscale"
                    }`}
                  />
                ) : (
                  <span className="text-[10px] text-brand-text/30 px-1 text-center">
                    no image
                  </span>
                )}
              </div>
              <div className="px-1.5 py-1 border-t border-brand-cream">
                <p className="text-[10px] leading-tight text-brand-text/70 truncate">
                  {cw.color || cw.styleColor}
                </p>
                <p className="text-[10px] text-brand-text/40">
                  {cw.styleColor.split("-")[1]
                    ? `-${cw.styleColor.split("-")[1]}`
                    : cw.styleColor}{" "}
                  · ${cw.retail}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
