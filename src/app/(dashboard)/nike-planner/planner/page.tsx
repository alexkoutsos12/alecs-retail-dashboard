"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";
import { db, storage } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
} from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import {
  NikeSku,
  SizeRun,
  SizeCell,
  Gender,
  sizeOrder,
} from "@/lib/parsers/parseNikeStock";
import { OnOrderSku, OnOrderPO } from "@/lib/parsers/parseNikeOnOrder";

const MODULE = "nike-planner";

// A stock SKU with its purchase-order breakdown merged in (by SKU).
type PlannerSku = NikeSku & { pos?: OnOrderPO[] };

function onOrderToSku(oo: OnOrderSku): PlannerSku {
  return {
    sku: oo.sku,
    supplierSku: "",
    description: oo.description,
    styleFamily: oo.styleFamily,
    color: oo.color,
    classCode: oo.classCode,
    className: oo.className,
    gender: oo.gender,
    run: oo.run,
    retailPrice: oo.retailPrice,
    cost: oo.cost,
    marginPct:
      oo.retailPrice > 0 ? (oo.retailPrice - oo.cost) / oo.retailPrice : 0,
    daysFirstReceived: 0,
    daysLastReceived: 0,
    sizes: oo.sizes.map((s) => ({
      code: s.code,
      label: s.label,
      order: s.order,
      onHand: 0,
      onOrder: s.onOrder,
      sold: 0,
    })),
    onHand: 0,
    onOrder: oo.onOrder,
    sold: 0,
    sellThrough: 0,
    coverageGap: 0,
    pos: oo.pos,
  };
}

function mergeOnOrder(
  stock: NikeSku[],
  onOrder: OnOrderSku[]
): PlannerSku[] {
  const ooMap = new Map(onOrder.map((o) => [o.sku, o]));
  // The on-order report is the single source of truth for on-order. Every SKU's
  // on-order is taken from it — the stock-status report's on-order column is
  // always disregarded, because the PO report is the precise, detailed
  // breakdown. A SKU with no open PO therefore shows nothing on order, and the
  // size-summary "On order" row reconciles exactly with the per-PO grid.
  const out: PlannerSku[] = [];
  const seen = new Set<string>();
  for (const s of stock) {
    seen.add(s.sku);
    const oo = ooMap.get(s.sku);
    if (!oo) {
      if (s.onOrder > 0 || s.sizes.some((z) => z.onOrder > 0)) {
        out.push({
          ...s,
          onOrder: 0,
          sizes: s.sizes.map((z) => ({ ...z, onOrder: 0 })),
        });
      } else {
        out.push(s);
      }
      continue;
    }
    // Rebuild sizes: keep on-hand/sold from stock, take on-order from the CSV,
    // and add any size only seen on order so no incoming pairs are dropped.
    const sizeMap = new Map(
      s.sizes.map((z) => [z.code, { ...z, onOrder: 0 }])
    );
    for (const z of oo.sizes) {
      const ex = sizeMap.get(z.code);
      if (ex) ex.onOrder = z.onOrder;
      else
        sizeMap.set(z.code, {
          code: z.code,
          label: z.label,
          order: z.order,
          onHand: 0,
          onOrder: z.onOrder,
          sold: 0,
        });
    }
    const sizes = [...sizeMap.values()].sort((a, b) => a.order - b.order);
    out.push({ ...s, sizes, onOrder: oo.onOrder, pos: oo.pos });
  }
  for (const oo of onOrder) {
    if (!seen.has(oo.sku)) out.push(onOrderToSku(oo));
  }
  return out;
}

// ─── Size-run classification ─────────────────────────────────────────────────
// RICS size codes are size×10 with no C/Y marker, so sizes 4–7 (codes 40–70)
// are ambiguous between Infant (4–10) and Big Kid (3.5–7). We resolve that per
// SKU from its full size span, then route each size to the run it belongs to.
// A shoe that spans runs (e.g. a 1Y–7Y shoe) contributes its sizes to each run
// — so each run's size summary only ever shows its own sizes.
//   Infant (Toddler): 4–10   (codes 40–100)
//   Little Kid:       10.5–3 (codes 105–135, then 1–3 = 10–30)
//   Big Kid:          3.5–7  (codes 35–70)

function isInfantContext(sku: PlannerSku): boolean {
  const u = ` ${sku.description.toUpperCase()} `;
  if (/\bTD\b|\(TD\)/.test(u)) return true;
  if (/\bGS\b|\bBG\b|\(GS\)|\bPS\b|\(PS\)/.test(u)) return false;
  const codes = sku.sizes.map((s) => s.code);
  // Any youth signal — 3.5, 1–3, or 10.5–13.5 — means 4–7 are Big Kid.
  if (
    codes.some(
      (c) => c === 35 || (c >= 10 && c <= 30) || (c >= 105 && c <= 135)
    )
  )
    return false;
  // Otherwise, 8–10 present (the infant ceiling) makes 4–7 infant.
  if (codes.some((c) => c >= 80 && c <= 100)) return true;
  return false; // default to youth (Big Kid) when nothing distinguishes
}

function runForCode(code: number, infant: boolean): SizeRun | null {
  if (code < 10 || code > 135) return null; // not a valid kids size (drops 14,15)
  if (code >= 105) return "Little Kid"; // 10.5–13.5
  if (code <= 30) return "Little Kid"; // 1–3 (youth tail)
  if (code === 35) return "Big Kid"; // 3.5
  if (code <= 70) return infant ? "Toddler" : "Big Kid"; // 4–7 overlap
  return "Toddler"; // 7.5–10 (infant only)
}

/** Split a SKU into one slice per run it has sizes in (on-hand/sold/on-order
 *  and purchase orders divided to match), so cross-range shoes land correctly. */
function sliceByRun(sku: PlannerSku): PlannerSku[] {
  const infant = isInfantContext(sku);
  const buckets = new Map<SizeRun, SizeCell[]>();
  for (const s of sku.sizes) {
    const run = runForCode(s.code, infant);
    if (!run) continue;
    if (!buckets.has(run)) buckets.set(run, []);
    buckets.get(run)!.push({ ...s, order: sizeOrder(s.code, run) });
  }
  const out: PlannerSku[] = [];
  for (const [run, sizes] of buckets) {
    sizes.sort((a, b) => a.order - b.order);
    const codeSet = new Set(sizes.map((s) => s.code));
    const onHand = sizes.reduce((a, s) => a + s.onHand, 0);
    const onOrder = sizes.reduce((a, s) => a + s.onOrder, 0);
    const sold = sizes.reduce((a, s) => a + s.sold, 0);
    const pos = sku.pos
      ?.map((po) => {
        const psizes = po.sizes.filter((p) => codeSet.has(p.code));
        return {
          ...po,
          sizes: psizes,
          total: psizes.reduce((a, p) => a + p.open, 0),
        };
      })
      .filter((po) => po.sizes.length > 0);
    out.push({
      ...sku,
      run,
      sizes,
      onHand,
      onOrder,
      sold,
      pos,
      sellThrough: sold + onHand > 0 ? sold / (sold + onHand) : 0,
      coverageGap: sold - (onHand + onOrder),
    });
  }
  return out;
}

const RUN_ORDER: SizeRun[] = ["Toddler", "Little Kid", "Big Kid", "Other"];

type View = "run" | "reorder";

interface ReportMeta {
  id: string;
  filename: string;
  salesWindow: string;
  storagePath: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Render a ship date plainly, whatever form it was stored in. Older imports
 * saved the Excel date serial (e.g. "46296") the CSV reader produced; newer
 * ones store "Mar 1, 2027". This normalizes both (and raw "M/D/YYYY").
 */
function plainDate(v: string): string {
  if (!v) return "";
  if (/^\d+$/.test(v)) {
    const d = new Date((parseInt(v, 10) - 25569) * 86400000);
    if (!Number.isNaN(d.getTime()))
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${MONTHS[+m[1] - 1]} ${+m[2]}, ${m[3]}`;
  return v;
}

/** Sizes selling faster than they're stocked — the reorder candidates. */
function reorderSizes(sku: NikeSku): string[] {
  return sku.sizes
    .filter((s) => s.sold > s.onHand)
    .map((s) => s.label);
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

// ─── Grouping types ──────────────────────────────────────────────────────────

interface FamilyGroup {
  family: string;
  skus: PlannerSku[];
  onHand: number;
  onOrder: number;
  sold: number;
}
interface RunGroup {
  run: SizeRun;
  families: FamilyGroup[];
  onHand: number;
  onOrder: number;
  sold: number;
  skuCount: number;
  reorderCount: number;
}

function agg(skus: NikeSku[]) {
  return {
    onHand: skus.reduce((s, k) => s + k.onHand, 0),
    onOrder: skus.reduce((s, k) => s + k.onOrder, 0),
    sold: skus.reduce((s, k) => s + k.sold, 0),
  };
}
function sellThru(sold: number, onHand: number): number {
  return sold + onHand > 0 ? sold / (sold + onHand) : 0;
}

// ─── Status signals (make opportunities and dead weight pop) ──────────────────

type SignalKey = "reorder" | "selling" | "over" | "healthy" | "none";

function getSignal(sold: number, onHand: number, onOrder: number): SignalKey {
  if (sold <= 0) return onHand > 0 ? "over" : "none";
  if (sold > onHand + onOrder) return "reorder"; // selling beyond coverage
  if (sellThru(sold, onHand) >= 0.5) return "selling"; // moving well, covered
  if (onHand >= 6 && sellThru(sold, onHand) < 0.2) return "over";
  return "healthy";
}

function SellThruBar({ value }: { value: number }) {
  const w = Math.round(value * 100);
  const color =
    value >= 0.6
      ? "bg-emerald-500"
      : value >= 0.35
      ? "bg-lime-500"
      : value >= 0.15
      ? "bg-amber-500"
      : "bg-rose-400";
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-12 h-1.5 rounded-full bg-brand-cream-dark/50 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="tabular-nums text-xs w-8 text-right text-brand-text/60">
        {w}%
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NikePlannerPage() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [selectedId, setSelectedId] = useState<string>("");
  const [salesWindow, setSalesWindow] = useState("");

  const [stockSkus, setStockSkus] = useState<NikeSku[]>([]);
  const [onOrderSkus, setOnOrderSkus] = useState<OnOrderSku[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, NikeSku[]>>(new Map());

  const skus = useMemo<PlannerSku[]>(
    () => mergeOnOrder(stockSkus, onOrderSkus),
    [stockSkus, onOrderSkus]
  );

  const [view, setView] = useState<View>("run");
  const [runFilter, setRunFilter] = useState<SizeRun | "All">("All");
  const [genderFilter, setGenderFilter] = useState<Gender | "All">("All");
  const [onOrderFilter, setOnOrderFilter] = useState<"all" | "on" | "off">(
    "all"
  );
  const [classFilter, setClassFilter] = useState<string>("All");
  const [search, setSearch] = useState("");

  // Distinct classes present in the current snapshot, for the class filter.
  const classOptions = useMemo(() => {
    const set = new Set<string>();
    for (const k of skus) if (k.className) set.add(k.className);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [skus]);

  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(
    new Set()
  );
  const [expandedSkus, setExpandedSkus] = useState<Set<string>>(new Set());

  useEffect(() => {
    document.title = "Planner · Nike Planner";
  }, []);

  // ─── Load ──────────────────────────────────────────────────────────────────

  const loadData = useCallback(
    async (report: ReportMeta) => {
      setLoadingData(true);
      setDataError(null);
      setSalesWindow(report.salesWindow);
      try {
        let data = cacheRef.current.get(report.id);
        if (!data) {
          const url = await getDownloadURL(
            storageRef(storage, report.storagePath)
          );
          const res = await fetch(
            `/api/storage-proxy?url=${encodeURIComponent(url)}`
          );
          if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
          data = (await res.json()) as NikeSku[];
          cacheRef.current.set(report.id, data);
        }
        setStockSkus(data);
      } catch (err) {
        setDataError(
          err instanceof Error ? err.message : "Failed to load report data."
        );
      } finally {
        setLoadingData(false);
      }
    },
    []
  );

  useEffect(() => {
    async function fetchReports() {
      try {
        const snap = await getDocs(
          query(
            collection(db, "reports"),
            where("module", "==", MODULE),
            orderBy("uploadedAt", "desc")
          )
        );
        const all = snap.docs.map(
          (d) =>
            ({ id: d.id, ...d.data() } as ReportMeta & {
              kind?: string;
              storagePath: string;
            })
        );
        const stock = all.filter((r) => r.kind !== "on-order");
        const onOrder = all.filter((r) => r.kind === "on-order");
        setReports(stock);
        if (stock.length > 0) {
          setSelectedId(stock[0].id);
          loadData(stock[0]);
        }
        if (onOrder.length > 0) {
          try {
            const url = await getDownloadURL(
              storageRef(storage, onOrder[0].storagePath)
            );
            const res = await fetch(
              `/api/storage-proxy?url=${encodeURIComponent(url)}`
            );
            if (res.ok) setOnOrderSkus((await res.json()) as OnOrderSku[]);
          } catch (err) {
            console.error("on-order load error:", err);
          }
        }
      } catch (err) {
        console.error("fetchReports error:", err);
      } finally {
        setLoadingReports(false);
      }
    }
    fetchReports();
  }, [loadData]);

  const onSelectReport = (id: string) => {
    setSelectedId(id);
    const r = reports.find((x) => x.id === id);
    if (r) loadData(r);
  };

  // ─── Derived ─────────────────────────────────────────────────────────────────

  // SKU-level filters (gender, class, search). Run and on-order are applied
  // per slice below, since one shoe can live in more than one run.
  const filteredSkus = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skus.filter((k) => {
      if (genderFilter !== "All" && k.gender !== genderFilter) return false;
      if (classFilter !== "All" && k.className !== classFilter) return false;
      if (
        q &&
        !k.styleFamily.toLowerCase().includes(q) &&
        !k.description.toLowerCase().includes(q) &&
        !k.color.toLowerCase().includes(q) &&
        !k.sku.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [skus, genderFilter, classFilter, search]);

  // Split each SKU into per-run slices, then apply the run and on-order filters.
  const slices = useMemo<PlannerSku[]>(() => {
    const out: PlannerSku[] = [];
    for (const k of filteredSkus) {
      for (const slice of sliceByRun(k)) {
        if (runFilter !== "All" && slice.run !== runFilter) continue;
        const hasOnOrder =
          (slice.pos && slice.pos.length > 0) || slice.onOrder > 0;
        if (onOrderFilter === "on" && !hasOnOrder) continue;
        if (onOrderFilter === "off" && hasOnOrder) continue;
        out.push(slice);
      }
    }
    return out;
  }, [filteredSkus, runFilter, onOrderFilter]);

  const colorwayCount = useMemo(
    () => new Set(slices.map((s) => s.sku)).size,
    [slices]
  );

  const runGroups = useMemo<RunGroup[]>(() => {
    const byRun = new Map<string, PlannerSku[]>();
    for (const k of slices) {
      if (!byRun.has(k.run)) byRun.set(k.run, []);
      byRun.get(k.run)!.push(k);
    }
    const groups: RunGroup[] = [];
    for (const run of RUN_ORDER) {
      const list = byRun.get(run);
      if (!list || list.length === 0) continue;
      const famMap = new Map<string, PlannerSku[]>();
      for (const k of list) {
        if (!famMap.has(k.styleFamily)) famMap.set(k.styleFamily, []);
        famMap.get(k.styleFamily)!.push(k);
      }
      const families: FamilyGroup[] = [...famMap.entries()]
        .map(([family, fskus]) => ({
          family,
          skus: [...fskus].sort((a, b) => b.sold - a.sold),
          ...agg(fskus),
        }))
        .sort((a, b) => b.sold - a.sold || b.onHand - a.onHand);
      groups.push({
        run: run,
        families,
        skuCount: list.length,
        reorderCount: list.filter(
          (k) => getSignal(k.sold, k.onHand, k.onOrder) === "reorder"
        ).length,
        ...agg(list),
      });
    }
    return groups;
  }, [slices]);

  const reorderList = useMemo(() => {
    return slices
      .filter((k) => k.sold > 0 && k.coverageGap > 0)
      .sort(
        (a, b) =>
          b.coverageGap - a.coverageGap ||
          b.sold - a.sold ||
          sellThru(b.sold, b.onHand) - sellThru(a.sold, a.onHand)
      );
  }, [slices]);

  const totals = useMemo(() => agg(slices), [slices]);

  const reorderColorways = useMemo(
    () =>
      slices.filter(
        (k) => getSignal(k.sold, k.onHand, k.onOrder) === "reorder"
      ),
    [slices]
  );
  const shortUnits = reorderColorways.reduce((s, k) => s + k.coverageGap, 0);

  // ─── Handlers ────────────────────────────────────────────────────────────────

  const toggleRun = (key: string) =>
    setExpandedRuns((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toggleFamily = (key: string) =>
    setExpandedFamilies((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toggleSku = (key: string) =>
    setExpandedSkus((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const expandAll = () => {
    setExpandedRuns(new Set(runGroups.map((r) => r.run)));
    setExpandedFamilies(
      new Set(
        runGroups.flatMap((r) =>
          r.families.map((f) => `${r.run}::${f.family}`)
        )
      )
    );
    setExpandedSkus(
      new Set(
        runGroups.flatMap((r) =>
          r.families.flatMap((f) => f.skus.map((s) => `${r.run}::${s.sku}`))
        )
      )
    );
  };
  const collapseAll = () => {
    setExpandedRuns(new Set());
    setExpandedFamilies(new Set());
    setExpandedSkus(new Set());
  };

  // Open the runs by default once data loads, so styles are visible at a glance.
  useEffect(() => {
    if (skus.length > 0) setExpandedRuns(new Set(RUN_ORDER));
  }, [skus]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  const noReports = !loadingReports && reports.length === 0;

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Nike Planner
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-4">
        Kids Nike stock, organized by size run and style — with reorder signals.
        {salesWindow && (
          <>
            {" "}
            · <strong>{salesWindow}</strong>.
          </>
        )}
      </p>

      {noReports && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
          <p className="text-brand-text/50 font-body text-sm mb-3">
            No stock status imported yet.
          </p>
          <Link
            href="/nike-planner/import"
            className="inline-block bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
          >
            Import Stock Status →
          </Link>
        </div>
      )}

      {!noReports && (
        <>
          {/* Snapshot selector */}
          {reports.length > 1 && (
            <div className="mb-4 flex items-center gap-2 font-body text-sm">
              <span className="text-brand-text/50 text-xs">Snapshot:</span>
              <select
                value={selectedId}
                onChange={(e) => onSelectReport(e.target.value)}
                className="border border-brand-cream-dark rounded px-2 py-1 text-sm bg-white text-brand-text focus:outline-none focus:border-brand-green"
              >
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.filename}
                  </option>
                ))}
              </select>
            </div>
          )}

          {loadingData && (
            <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
              <p className="text-brand-text/40 font-body text-sm">Loading…</p>
            </div>
          )}

          {dataError && !loadingData && (
            <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-5">
              <p className="font-body text-sm text-red-600">{dataError}</p>
            </div>
          )}

          {!loadingData && !dataError && skus.length > 0 && (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <StatCard
                  label="Colorways (SKUs)"
                  value={colorwayCount.toLocaleString()}
                />
                <StatCard
                  label="Units On Hand"
                  value={totals.onHand.toLocaleString()}
                />
                <StatCard
                  label="Units On Order"
                  value={totals.onOrder.toLocaleString()}
                />
                <StatCard
                  label="Sold + Sell-through"
                  value={`${totals.sold.toLocaleString()} · ${pct(
                    sellThru(totals.sold, totals.onHand)
                  )}`}
                />
              </div>

              {/* Insight banner */}
              {view === "run" && reorderColorways.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded px-4 py-2.5 mb-4 font-body text-sm">
                  <span>
                    <strong>{reorderColorways.length}</strong> colorways are
                    selling beyond their on-hand + on-order coverage (
                    <strong>{shortUnits}</strong> units short).
                  </span>
                  <button
                    onClick={() => setView("reorder")}
                    className="ml-auto text-emerald-700 font-medium hover:underline"
                  >
                    View reorder winners →
                  </button>
                </div>
              )}

              {/* View toggle */}
              <div className="flex items-center gap-1 mb-3">
                <button
                  onClick={() => setView("run")}
                  className={`font-body text-sm px-4 py-1.5 rounded transition-colors ${
                    view === "run"
                      ? "bg-brand-green text-brand-cream"
                      : "bg-white text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream"
                  }`}
                >
                  By Size Run
                </button>
                <button
                  onClick={() => setView("reorder")}
                  className={`font-body text-sm px-4 py-1.5 rounded transition-colors ${
                    view === "reorder"
                      ? "bg-brand-green text-brand-cream"
                      : "bg-white text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream"
                  }`}
                >
                  Reorder Winners
                </button>
                {view === "run" && (
                  <div className="ml-auto flex gap-3">
                    <button
                      onClick={expandAll}
                      className="font-body text-xs text-brand-green hover:underline"
                    >
                      Expand all
                    </button>
                    <button
                      onClick={collapseAll}
                      className="font-body text-xs text-brand-text/50 hover:underline"
                    >
                      Collapse all
                    </button>
                  </div>
                )}
              </div>

              {/* Filters */}
              <div className="bg-white border border-brand-cream-dark rounded px-3 py-2.5 flex flex-wrap gap-2 items-center mb-4">
                <div className="flex gap-1">
                  {(["All", "Toddler", "Little Kid", "Big Kid"] as const).map(
                    (r) => (
                      <button
                        key={r}
                        onClick={() => setRunFilter(r as SizeRun | "All")}
                        className={`font-body text-xs px-2.5 py-1 rounded transition-colors ${
                          runFilter === r
                            ? "bg-brand-green text-brand-cream"
                            : "bg-brand-cream text-brand-text/70 hover:bg-brand-cream-dark"
                        }`}
                      >
                        {r}
                      </button>
                    )
                  )}
                </div>
                <div className="flex gap-1">
                  {(["All", "Boys", "Girls"] as const).map((g) => (
                    <button
                      key={g}
                      onClick={() => setGenderFilter(g as Gender | "All")}
                      className={`font-body text-xs px-2.5 py-1 rounded transition-colors ${
                        genderFilter === g
                          ? "bg-brand-green text-brand-cream"
                          : "bg-brand-cream text-brand-text/70 hover:bg-brand-cream-dark"
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1 border-l border-brand-cream-dark pl-2 ml-1">
                  {(
                    [
                      ["all", "All stock"],
                      ["on", "On order"],
                      ["off", "Not on order"],
                    ] as const
                  ).map(([val, lbl]) => (
                    <button
                      key={val}
                      onClick={() => setOnOrderFilter(val)}
                      className={`font-body text-xs px-2.5 py-1 rounded transition-colors ${
                        onOrderFilter === val
                          ? val === "on"
                            ? "bg-indigo-600 text-white"
                            : "bg-brand-green text-brand-cream"
                          : "bg-brand-cream text-brand-text/70 hover:bg-brand-cream-dark"
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 border-l border-brand-cream-dark pl-2 ml-1">
                  <span className="font-body text-[11px] text-brand-text/40">
                    Class
                  </span>
                  <select
                    value={classFilter}
                    onChange={(e) => setClassFilter(e.target.value)}
                    className={`font-body text-xs rounded px-2 py-1 border focus:outline-none focus:border-brand-green ${
                      classFilter === "All"
                        ? "bg-brand-cream text-brand-text/70 border-brand-cream-dark"
                        : "bg-brand-green text-brand-cream border-brand-green"
                    }`}
                  >
                    <option value="All">All classes</option>
                    {classOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-1.5 ml-auto border border-brand-cream-dark rounded px-2 py-1">
                  <Search className="w-3.5 h-3.5 text-brand-text/40" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search style, color, SKU"
                    className="font-body text-sm bg-transparent focus:outline-none w-48"
                  />
                </label>
              </div>

              {view === "run" ? (
                <RunView
                  runGroups={runGroups}
                  expandedRuns={expandedRuns}
                  expandedFamilies={expandedFamilies}
                  expandedSkus={expandedSkus}
                  onToggleRun={toggleRun}
                  onToggleFamily={toggleFamily}
                  onToggleSku={toggleSku}
                />
              ) : (
                <ReorderView
                  list={reorderList}
                  expandedSkus={expandedSkus}
                  onToggleSku={toggleSku}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── By Size Run view ────────────────────────────────────────────────────────
// Laid out as a CSS grid (not a table) so each summary and each style can be a
// self-contained bordered box, while the metric columns stay aligned across
// every row via one shared column template.

const GRID =
  "grid grid-cols-[1.75rem_minmax(0,1fr)_3.25rem_3.25rem_3.25rem_5.5rem] items-center gap-x-2";

function MetricCells({
  onHand,
  onOrder,
  sold,
}: {
  onHand: number;
  onOrder: number;
  sold: number;
}) {
  return (
    <>
      <div className="text-right tabular-nums">{onHand}</div>
      <div className="text-right tabular-nums text-brand-text/60">
        {onOrder || ""}
      </div>
      <div className="text-right tabular-nums font-medium">{sold}</div>
      <SellThruBar value={sellThru(sold, onHand)} />
    </>
  );
}

function RunView({
  runGroups,
  expandedRuns,
  expandedFamilies,
  expandedSkus,
  onToggleRun,
  onToggleFamily,
  onToggleSku,
}: {
  runGroups: RunGroup[];
  expandedRuns: Set<string>;
  expandedFamilies: Set<string>;
  expandedSkus: Set<string>;
  onToggleRun: (k: string) => void;
  onToggleFamily: (k: string) => void;
  onToggleSku: (k: string) => void;
}) {
  if (runGroups.length === 0) {
    return (
      <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
        <p className="text-brand-text/50 font-body text-sm">
          Nothing matches these filters.
        </p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[680px] text-sm font-body space-y-6">
        {/* Column header */}
        <div
          className={`${GRID} px-3 border-2 border-transparent text-brand-text/50 text-xs`}
        >
          <div />
          <div>Size Run / Style / Color</div>
          <div className="text-right">On Hand</div>
          <div className="text-right">On Order</div>
          <div className="text-right">Sold</div>
          <div className="text-right">Sell-thru</div>
        </div>

        {runGroups.map((rg) => (
          <RunSection
            key={rg.run}
            rg={rg}
            runOpen={expandedRuns.has(rg.run)}
            expandedFamilies={expandedFamilies}
            expandedSkus={expandedSkus}
            onToggleRun={onToggleRun}
            onToggleFamily={onToggleFamily}
            onToggleSku={onToggleSku}
          />
        ))}
      </div>
    </div>
  );
}

function RunSection({
  rg,
  runOpen,
  expandedFamilies,
  expandedSkus,
  onToggleRun,
  onToggleFamily,
  onToggleSku,
}: {
  rg: RunGroup;
  runOpen: boolean;
  expandedFamilies: Set<string>;
  expandedSkus: Set<string>;
  onToggleRun: (k: string) => void;
  onToggleFamily: (k: string) => void;
  onToggleSku: (k: string) => void;
}) {
  return (
    <section className="space-y-3">
      {/* Run header bar */}
      <div
        onClick={() => onToggleRun(rg.run)}
        className={`${GRID} px-3 py-3 cursor-pointer select-none rounded-lg border-2 border-brand-green bg-brand-green/10 hover:bg-brand-green/15 transition-colors`}
      >
        <div className="text-brand-green/60">
          <ChevronRight
            className={`w-5 h-5 transition-transform ${runOpen ? "rotate-90" : ""}`}
          />
        </div>
        <div className="font-heading font-bold text-brand-green text-[15px]">
          {rg.run}{" "}
          <span className="font-body font-normal text-brand-text/40 text-xs">
            · {rg.families.length} styles · {rg.skuCount} colorways
          </span>
        </div>
        <MetricCells onHand={rg.onHand} onOrder={rg.onOrder} sold={rg.sold} />
      </div>

      {runOpen && (
        <>
          {/* Run-level summary box */}
          <div className="rounded-lg border-2 border-brand-green/30 bg-white overflow-hidden">
            <SummaryBlock
              skus={rg.families.flatMap((f) => f.skus)}
              label={`${rg.run} summary · all ${rg.skuCount} colorways across ${rg.families.length} styles`}
            />
          </div>

          {/* One box per style */}
          {rg.families.map((fg) => {
            const fkey = `${rg.run}::${fg.family}`;
            return (
              <StyleSection
                key={fkey}
                fkey={fkey}
                fg={fg}
                famOpen={expandedFamilies.has(fkey)}
                expandedSkus={expandedSkus}
                onToggleFamily={onToggleFamily}
                onToggleSku={onToggleSku}
              />
            );
          })}
        </>
      )}
    </section>
  );
}

function StyleSection({
  fkey,
  fg,
  famOpen,
  expandedSkus,
  onToggleFamily,
  onToggleSku,
}: {
  fkey: string;
  fg: FamilyGroup;
  famOpen: boolean;
  expandedSkus: Set<string>;
  onToggleFamily: (k: string) => void;
  onToggleSku: (k: string) => void;
}) {
  return (
    <div className="rounded-lg border-2 border-brand-cream-dark bg-white overflow-hidden">
      {/* Style header */}
      <div
        onClick={() => onToggleFamily(fkey)}
        className={`${GRID} px-3 py-2.5 cursor-pointer select-none transition-colors ${
          famOpen
            ? "bg-brand-cream/60 hover:bg-brand-cream/70"
            : "hover:bg-brand-cream/30"
        }`}
      >
        <div className="text-brand-green/50">
          <ChevronRight
            className={`w-4 h-4 transition-transform ${famOpen ? "rotate-90" : ""}`}
          />
        </div>
        <div className="font-heading font-semibold text-brand-text">
          {fg.family}{" "}
          <span className="font-body font-normal text-brand-text/40 text-xs">
            · {fg.skus.length} colorway{fg.skus.length === 1 ? "" : "s"}
          </span>
        </div>
        <MetricCells onHand={fg.onHand} onOrder={fg.onOrder} sold={fg.sold} />
      </div>

      {famOpen && (
        <div className="border-t border-brand-cream-dark">
          <SummaryBlock skus={fg.skus} />
          {fg.skus.map((sku) => {
            const sk = `${sku.run}::${sku.sku}`;
            return (
              <SkuRow
                key={sk}
                skuKey={sk}
                sku={sku}
                skuOpen={expandedSkus.has(sk)}
                onToggleSku={onToggleSku}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SkuRow({
  sku,
  skuKey,
  skuOpen,
  onToggleSku,
}: {
  sku: PlannerSku;
  skuKey: string;
  skuOpen: boolean;
  onToggleSku: (k: string) => void;
}) {
  return (
    <>
      <div
        onClick={() => onToggleSku(skuKey)}
        className={`${GRID} px-3 py-1.5 cursor-pointer select-none hover:bg-brand-cream/30 border-t border-brand-cream transition-colors`}
      >
        <div className="pl-5 text-brand-text/30">
          <ChevronRight
            className={`w-3 h-3 transition-transform ${skuOpen ? "rotate-90" : ""}`}
          />
        </div>
        <div className="text-brand-text/80">
          {sku.color || sku.description || sku.sku}{" "}
          <span className="text-brand-text/30 text-xs">{sku.gender}</span>
        </div>
        <MetricCells onHand={sku.onHand} onOrder={sku.onOrder} sold={sku.sold} />
      </div>
      {skuOpen && (
        <div className="border-t border-brand-cream">
          <SizeGrid sku={sku} />
        </div>
      )}
    </>
  );
}

// ─── Reorder Winners view ────────────────────────────────────────────────────

function ReorderView({
  list,
  expandedSkus,
  onToggleSku,
}: {
  list: PlannerSku[];
  expandedSkus: Set<string>;
  onToggleSku: (k: string) => void;
}) {
  if (list.length === 0) {
    return (
      <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
        <p className="text-brand-text/50 font-body text-sm">
          No reorder candidates for these filters — nothing is selling beyond its
          on-hand + on-order coverage.
        </p>
      </div>
    );
  }
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
      <table className="w-full text-sm font-body min-w-[820px]">
        <thead>
          <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
            <th className="w-8 px-3 py-2 font-normal" />
            <th className="px-3 py-2 font-normal">Style / Color</th>
            <th className="px-3 py-2 font-normal">Run</th>
            <th className="px-3 py-2 font-normal text-right">Sold</th>
            <th className="px-3 py-2 font-normal text-right">On Hand</th>
            <th className="px-3 py-2 font-normal text-right">On Order</th>
            <th className="px-3 py-2 font-normal text-right">Short</th>
            <th className="px-3 py-2 font-normal">Reorder sizes</th>
          </tr>
        </thead>
        <tbody>
          {list.map((sku) => {
            const sk = `${sku.run}::${sku.sku}`;
            return (
              <ReorderRow
                key={sk}
                skuKey={sk}
                sku={sku}
                open={expandedSkus.has(sk)}
                onToggleSku={onToggleSku}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReorderRow({
  sku,
  skuKey,
  open,
  onToggleSku,
}: {
  sku: PlannerSku;
  skuKey: string;
  open: boolean;
  onToggleSku: (k: string) => void;
}) {
  const sizes = reorderSizes(sku);
  return (
    <>
      <tr
        onClick={() => onToggleSku(skuKey)}
        className="cursor-pointer hover:bg-brand-cream/40 border-b border-brand-cream transition-colors"
      >
        <td className="px-3 py-2 text-brand-text/30">
          <ChevronRight
            className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`}
          />
        </td>
        <td className="px-3 py-2">
          <span className="font-medium text-brand-text">{sku.styleFamily}</span>{" "}
          <span className="text-brand-text/60">
            {sku.color || sku.description}
          </span>
        </td>
        <td className="px-3 py-2 text-brand-text/60 text-xs">{sku.run}</td>
        <td className="px-3 py-2 text-right tabular-nums font-medium">
          {sku.sold}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{sku.onHand}</td>
        <td className="px-3 py-2 text-right tabular-nums">{sku.onOrder}</td>
        <td className="px-3 py-2 text-right tabular-nums font-semibold text-brand-green">
          {sku.coverageGap}
        </td>
        <td className="px-3 py-2 text-xs text-brand-text/70">
          {sizes.length > 0 ? sizes.join(", ") : "—"}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-brand-cream">
          <td colSpan={8} className="p-0">
            <SizeGrid sku={sku} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Family size summary (grid analysis across all colorways) ────────────────

interface CurveCell {
  code: number;
  label: string;
  order: number;
  onHand: number;
  onOrder: number;
  sold: number;
}

function familyCurve(skus: NikeSku[]): CurveCell[] {
  const m = new Map<number, CurveCell>();
  for (const k of skus) {
    for (const s of k.sizes) {
      const e =
        m.get(s.code) ??
        {
          code: s.code,
          label: s.label,
          order: s.order,
          onHand: 0,
          onOrder: 0,
          sold: 0,
        };
      e.onHand += s.onHand;
      e.onOrder += s.onOrder;
      e.sold += s.sold;
      m.set(s.code, e);
    }
  }
  return [...m.values()].sort((a, b) => a.order - b.order);
}

function heat(n: number, scale: "stock" | "sold"): string {
  if (n <= 0) return "";
  const stock = [
    "bg-emerald-50",
    "bg-emerald-100",
    "bg-emerald-200",
    "bg-emerald-300",
    "bg-emerald-400",
  ];
  const sold = [
    "bg-amber-50",
    "bg-amber-100",
    "bg-amber-200",
    "bg-amber-300",
    "bg-amber-400",
  ];
  const arr = scale === "stock" ? stock : sold;
  const idx = n <= 2 ? 0 : n <= 5 ? 1 : n <= 10 ? 2 : n <= 20 ? 3 : 4;
  return arr[idx];
}

interface PoCurveRow {
  poNumber: string;
  shipDate: string;
  shipSort: string;
  bySize: Map<number, number>;
  total: number;
}

/** Aggregate every purchase order feeding the given SKUs, grouped by PO. */
function onOrderSummary(skus: PlannerSku[]): {
  rows: PoCurveRow[];
  totalBySize: Map<number, number>;
  grandTotal: number;
} {
  const poMap = new Map<string, PoCurveRow>();
  for (const k of skus) {
    for (const po of k.pos ?? []) {
      let row = poMap.get(po.poNumber);
      if (!row) {
        row = {
          poNumber: po.poNumber,
          shipDate: po.shipDate,
          shipSort: po.shipSort,
          bySize: new Map(),
          total: 0,
        };
        poMap.set(po.poNumber, row);
      }
      for (const s of po.sizes) {
        if (s.open <= 0) continue;
        row.bySize.set(s.code, (row.bySize.get(s.code) || 0) + s.open);
        row.total += s.open;
      }
    }
  }
  const rows = [...poMap.values()].sort(
    (a, b) =>
      a.shipSort.localeCompare(b.shipSort) ||
      a.poNumber.localeCompare(b.poNumber)
  );
  const totalBySize = new Map<number, number>();
  let grandTotal = 0;
  for (const r of rows) {
    for (const [code, q] of r.bySize) {
      totalBySize.set(code, (totalBySize.get(code) || 0) + q);
      grandTotal += q;
    }
  }
  return { rows, totalBySize, grandTotal };
}

/**
 * One combined summary block: on-hand and sold by size up top, then each open
 * purchase order broken out by size (the on-order detail) and an "All POs"
 * total — all sharing the same size columns so it reads as a single section.
 */
function SummaryBlock({
  skus,
  label,
}: {
  skus: PlannerSku[];
  label?: string;
}) {
  const curve = familyCurve(skus);
  if (curve.length === 0) return null;
  const { rows: poRows, totalBySize, grandTotal } = onOrderSummary(skus);
  const totOh = curve.reduce((s, c) => s + c.onHand, 0);
  const totSo = curve.reduce((s, c) => s + c.sold, 0);
  const span = curve.length + 2;
  return (
    <div className="bg-white px-4 py-3">
      <p className="font-body text-[11px] uppercase tracking-wider text-brand-text/40 mb-2">
        {label ?? `Summary · all ${skus.length} colorways`}
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs font-body">
          <thead>
            <tr className="text-brand-text/40">
              <th className="pr-3 py-1 text-right font-normal" />
              {curve.map((c) => (
                <th
                  key={c.code}
                  className="px-1.5 py-1 text-center font-semibold text-brand-text/70 min-w-[34px]"
                >
                  {c.label}
                </th>
              ))}
              <th className="pl-3 py-1 text-center font-semibold text-brand-text/50 border-l border-brand-cream-dark">
                Tot
              </th>
            </tr>
          </thead>
          <tbody>
            {/* On hand */}
            <tr>
              <td className="pr-3 py-0.5 text-right text-brand-text/50">
                On hand
              </td>
              {curve.map((c) => {
                const gap = c.onHand === 0 && c.sold > 0;
                return (
                  <td
                    key={c.code}
                    className={`px-1.5 py-1 text-center tabular-nums ${
                      gap
                        ? "bg-red-100 text-red-700 font-semibold"
                        : heat(c.onHand, "stock")
                    }`}
                  >
                    {gap ? "0" : c.onHand || ""}
                  </td>
                );
              })}
              <td className="pl-3 py-1 text-center tabular-nums font-semibold border-l border-brand-cream-dark">
                {totOh}
              </td>
            </tr>
            {/* Sold */}
            <tr>
              <td className="pr-3 py-0.5 text-right text-brand-text/50">Sold</td>
              {curve.map((c) => (
                <td
                  key={c.code}
                  className={`px-1.5 py-1 text-center tabular-nums ${heat(
                    c.sold,
                    "sold"
                  )}`}
                >
                  {c.sold || ""}
                </td>
              ))}
              <td className="pl-3 py-1 text-center tabular-nums font-semibold border-l border-brand-cream-dark">
                {totSo}
              </td>
            </tr>

            {/* On-order section header */}
            <tr>
              <td
                colSpan={span}
                className="pt-3 pb-1 text-indigo-500 font-medium"
              >
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-indigo-500" />
                  On order · {poRows.length} purchase order
                  {poRows.length === 1 ? "" : "s"} · {grandTotal} pairs incoming
                </span>
              </td>
            </tr>

            {poRows.length > 0 ? (
              <>
                {poRows.map((r) => (
                  <tr
                    key={r.poNumber}
                    className="bg-indigo-50/70 border-t border-indigo-100"
                  >
                    <td className="pr-3 py-0.5 text-right whitespace-nowrap text-indigo-700">
                      <span className="font-semibold">{r.poNumber}</span>
                      {r.shipDate && (
                        <span className="text-indigo-400">
                          {" "}
                          · {plainDate(r.shipDate)}
                        </span>
                      )}
                    </td>
                    {curve.map((c) => {
                      const q = r.bySize.get(c.code) || 0;
                      return (
                        <td
                          key={c.code}
                          className={`px-1.5 py-1 text-center tabular-nums ${
                            q > 0
                              ? "bg-indigo-100 text-indigo-800 font-medium"
                              : "text-indigo-200"
                          }`}
                        >
                          {q || ""}
                        </td>
                      );
                    })}
                    <td className="pl-3 py-1 text-center tabular-nums font-semibold text-indigo-800 border-l border-indigo-200">
                      {r.total}
                    </td>
                  </tr>
                ))}
                <tr className="bg-indigo-50/70 border-t-2 border-indigo-200 font-semibold text-indigo-800">
                  <td className="pr-3 py-1 text-right">All POs</td>
                  {curve.map((c) => (
                    <td
                      key={c.code}
                      className="px-1.5 py-1 text-center tabular-nums"
                    >
                      {totalBySize.get(c.code) || ""}
                    </td>
                  ))}
                  <td className="pl-3 py-1 text-center tabular-nums border-l border-indigo-200">
                    {grandTotal}
                  </td>
                </tr>
              </>
            ) : (
              <tr className="bg-indigo-50/40">
                <td
                  colSpan={span}
                  className="py-1 text-indigo-400 text-[11px]"
                >
                  No open purchase orders for this group.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-brand-text/40 mt-2">
        Darker green = more on hand · darker amber = more sold · red 0 = sold
        with none on hand (size gap to chase).{" "}
        <span className="text-indigo-500">
          Indigo rows = each open purchase order's pairs by size, with ship
          date.
        </span>
      </p>
    </div>
  );
}

// ─── Size grid (shared drill-down) ───────────────────────────────────────────

function SizeGrid({ sku }: { sku: PlannerSku }) {
  const pos = sku.pos ?? [];
  const ohTot = sku.sizes.reduce((a, s) => a + s.onHand, 0);
  const soldTot = sku.sizes.reduce((a, s) => a + s.sold, 0);
  const ooTot = sku.sizes.reduce((a, s) => a + s.onOrder, 0);
  return (
    <div className="bg-brand-cream/30 px-4 py-3">
      <div className="flex flex-wrap gap-4 text-xs font-body text-brand-text/50 mb-2">
        <span>
          SKU <span className="text-brand-text/70">{sku.sku}</span>
        </span>
        <span>
          Price <span className="text-brand-text/70">${sku.retailPrice.toFixed(2)}</span>
        </span>
        <span>
          Margin <span className="text-brand-text/70">{pct(sku.marginPct)}</span>
        </span>
        <span>
          Last received{" "}
          <span className="text-brand-text/70">{sku.daysLastReceived}d ago</span>
        </span>
        <span>
          Class <span className="text-brand-text/70">{sku.className}</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs font-body border-collapse">
          <tbody>
            <tr>
              <td className="pr-2 py-0.5 text-brand-text/40 text-right">Size</td>
              {sku.sizes.map((s) => (
                <td
                  key={s.code}
                  className="px-2 py-0.5 text-center font-medium text-brand-text min-w-[34px]"
                >
                  {s.label}
                </td>
              ))}
              <td className="pl-3 py-0.5 text-center font-semibold text-brand-text/50 border-l border-brand-cream-dark">
                Tot
              </td>
            </tr>
            <tr>
              <td className="pr-2 py-0.5 text-brand-text/40 text-right">On hand</td>
              {sku.sizes.map((s) => (
                <td
                  key={s.code}
                  className={`px-2 py-0.5 text-center tabular-nums ${
                    s.onHand === 0 && s.sold > 0
                      ? "bg-amber-100 text-amber-800 font-semibold rounded"
                      : "text-brand-text/70"
                  }`}
                >
                  {s.onHand || ""}
                </td>
              ))}
              <td className="pl-3 py-0.5 text-center tabular-nums font-semibold border-l border-brand-cream-dark">
                {ohTot}
              </td>
            </tr>
            <tr>
              <td className="pr-2 py-0.5 text-brand-text/40 text-right">Sold</td>
              {sku.sizes.map((s) => (
                <td
                  key={s.code}
                  className={`px-2 py-0.5 text-center tabular-nums ${
                    s.sold > s.onHand
                      ? "text-brand-green font-semibold"
                      : "text-brand-text/70"
                  }`}
                >
                  {s.sold || ""}
                </td>
              ))}
              <td className="pl-3 py-0.5 text-center tabular-nums font-semibold border-l border-brand-cream-dark">
                {soldTot}
              </td>
            </tr>
            {pos.length > 0 ? (
              pos.map((po, i) => {
                const open = new Map(
                  po.sizes.map((s) => [s.code, s.open] as [number, number])
                );
                return (
                  <tr
                    key={`${po.poNumber}-${i}`}
                    className="bg-indigo-50/70 border-t border-indigo-100"
                  >
                    <td className="pr-2 py-0.5 text-right text-indigo-700 whitespace-nowrap">
                      <span className="font-semibold">{po.poNumber}</span>
                      {po.shipDate && (
                        <span className="text-indigo-400">
                          {" "}
                          · {plainDate(po.shipDate)}
                        </span>
                      )}
                    </td>
                    {sku.sizes.map((s) => {
                      const q = open.get(s.code) || 0;
                      return (
                        <td
                          key={s.code}
                          className={`px-2 py-0.5 text-center tabular-nums ${
                            q > 0
                              ? "bg-indigo-100 text-indigo-800 font-medium rounded"
                              : "text-indigo-300"
                          }`}
                        >
                          {q || ""}
                        </td>
                      );
                    })}
                    <td className="pl-3 py-0.5 text-center tabular-nums font-semibold text-indigo-800 border-l border-indigo-200">
                      {po.total}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="pr-2 py-0.5 text-brand-text/40 text-right">
                  On order
                </td>
                {sku.sizes.map((s) => (
                  <td
                    key={s.code}
                    className="px-2 py-0.5 text-center tabular-nums text-brand-text/50"
                  >
                    {s.onOrder || ""}
                  </td>
                ))}
                <td className="pl-3 py-0.5 text-center tabular-nums font-semibold text-brand-text/60 border-l border-brand-cream-dark">
                  {ooTot || ""}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-brand-text/40 mt-2">
        Amber = sold with none on hand (size gap). Green sold = selling faster
        than stocked.
        {pos.length > 0 && (
          <>
            {" "}
            <span className="text-indigo-500">
              Indigo rows = pairs on order by purchase order, with ship date.
            </span>
          </>
        )}
      </p>
    </div>
  );
}
