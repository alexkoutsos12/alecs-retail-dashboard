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
  Gender,
} from "@/lib/parsers/parseNikeStock";

const MODULE = "nike-planner";
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
  skus: NikeSku[];
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NikePlannerPage() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [selectedId, setSelectedId] = useState<string>("");
  const [salesWindow, setSalesWindow] = useState("");

  const [skus, setSkus] = useState<NikeSku[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, NikeSku[]>>(new Map());

  const [view, setView] = useState<View>("run");
  const [runFilter, setRunFilter] = useState<SizeRun | "All">("All");
  const [genderFilter, setGenderFilter] = useState<Gender | "All">("All");
  const [search, setSearch] = useState("");

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
        setSkus(data);
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
        const list = snap.docs.map(
          (d) => ({ id: d.id, ...d.data() } as ReportMeta)
        );
        setReports(list);
        if (list.length > 0) {
          setSelectedId(list[0].id);
          loadData(list[0]);
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skus.filter((k) => {
      if (runFilter !== "All" && k.run !== runFilter) return false;
      if (genderFilter !== "All" && k.gender !== genderFilter) return false;
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
  }, [skus, runFilter, genderFilter, search]);

  const runGroups = useMemo<RunGroup[]>(() => {
    const byRun = new Map<string, NikeSku[]>();
    for (const k of filtered) {
      if (!byRun.has(k.run)) byRun.set(k.run, []);
      byRun.get(k.run)!.push(k);
    }
    const groups: RunGroup[] = [];
    for (const run of RUN_ORDER) {
      const list = byRun.get(run);
      if (!list || list.length === 0) continue;
      const famMap = new Map<string, NikeSku[]>();
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
        ...agg(list),
      });
    }
    return groups;
  }, [filtered]);

  const reorderList = useMemo(() => {
    return filtered
      .filter((k) => k.sold > 0 && k.coverageGap > 0)
      .sort(
        (a, b) =>
          b.coverageGap - a.coverageGap ||
          b.sold - a.sold ||
          sellThru(b.sold, b.onHand) - sellThru(a.sold, a.onHand)
      );
  }, [filtered]);

  const totals = useMemo(() => agg(filtered), [filtered]);

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
            Sales shown for <strong>{salesWindow}</strong>.
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
                  value={filtered.length.toLocaleString()}
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
                  {(["All", "Boys", "Girls", "Unisex"] as const).map((g) => (
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

function Metrics({
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
      <td className="px-3 py-2 text-right tabular-nums">{onHand}</td>
      <td className="px-3 py-2 text-right tabular-nums">{onOrder}</td>
      <td className="px-3 py-2 text-right tabular-nums font-medium">{sold}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {pct(sellThru(sold, onHand))}
      </td>
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
    <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
      <table className="w-full text-sm font-body min-w-[640px]">
        <thead>
          <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
            <th className="w-8 px-3 py-2 font-normal" />
            <th className="px-3 py-2 font-normal">Size Run / Style / Color</th>
            <th className="px-3 py-2 font-normal text-right">On Hand</th>
            <th className="px-3 py-2 font-normal text-right">On Order</th>
            <th className="px-3 py-2 font-normal text-right">Sold</th>
            <th className="px-3 py-2 font-normal text-right">Sell-thru</th>
          </tr>
        </thead>
        <tbody>
          {runGroups.map((rg) => {
            const runOpen = expandedRuns.has(rg.run);
            return (
              <RunRow
                key={rg.run}
                rg={rg}
                runOpen={runOpen}
                expandedFamilies={expandedFamilies}
                expandedSkus={expandedSkus}
                onToggleRun={onToggleRun}
                onToggleFamily={onToggleFamily}
                onToggleSku={onToggleSku}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({
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
    <>
      <tr
        onClick={() => onToggleRun(rg.run)}
        className="cursor-pointer hover:bg-brand-cream/50 border-b border-brand-cream transition-colors"
      >
        <td className="px-3 py-2.5 text-brand-text/30">
          <ChevronRight
            className={`w-4 h-4 transition-transform ${runOpen ? "rotate-90" : ""}`}
          />
        </td>
        <td className="px-3 py-2.5 font-heading font-bold text-brand-green">
          {rg.run}{" "}
          <span className="font-body font-normal text-brand-text/40 text-xs">
            · {rg.families.length} styles · {rg.skuCount} colorways
          </span>
        </td>
        <Metrics onHand={rg.onHand} onOrder={rg.onOrder} sold={rg.sold} />
      </tr>

      {runOpen &&
        rg.families.map((fg) => {
          const fkey = `${rg.run}::${fg.family}`;
          const famOpen = expandedFamilies.has(fkey);
          return (
            <FamilyRow
              key={fkey}
              fkey={fkey}
              fg={fg}
              famOpen={famOpen}
              expandedSkus={expandedSkus}
              onToggleFamily={onToggleFamily}
              onToggleSku={onToggleSku}
            />
          );
        })}
    </>
  );
}

function FamilyRow({
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
    <>
      <tr
        onClick={() => onToggleFamily(fkey)}
        className="cursor-pointer hover:bg-brand-cream/40 border-b border-brand-cream transition-colors bg-brand-cream/20"
      >
        <td className="py-2 pl-8 pr-3 text-brand-text/30">
          <ChevronRight
            className={`w-3.5 h-3.5 transition-transform ${famOpen ? "rotate-90" : ""}`}
          />
        </td>
        <td className="px-3 py-2 font-medium text-brand-text">
          {fg.family}{" "}
          <span className="font-normal text-brand-text/40 text-xs">
            · {fg.skus.length}
          </span>
        </td>
        <Metrics onHand={fg.onHand} onOrder={fg.onOrder} sold={fg.sold} />
      </tr>

      {famOpen &&
        fg.skus.map((sku) => {
          const skuOpen = expandedSkus.has(sku.sku);
          return (
            <SkuRow
              key={sku.sku}
              sku={sku}
              skuOpen={skuOpen}
              onToggleSku={onToggleSku}
            />
          );
        })}
    </>
  );
}

function SkuRow({
  sku,
  skuOpen,
  onToggleSku,
}: {
  sku: NikeSku;
  skuOpen: boolean;
  onToggleSku: (k: string) => void;
}) {
  return (
    <>
      <tr
        onClick={() => onToggleSku(sku.sku)}
        className="cursor-pointer hover:bg-brand-cream/30 border-b border-brand-cream transition-colors"
      >
        <td className="py-1.5 pl-14 pr-3 text-brand-text/30">
          <ChevronRight
            className={`w-3 h-3 transition-transform ${skuOpen ? "rotate-90" : ""}`}
          />
        </td>
        <td className="px-3 py-1.5 text-brand-text/80">
          {sku.color || sku.description || sku.sku}{" "}
          <span className="text-brand-text/30 text-xs">{sku.gender}</span>
        </td>
        <Metrics onHand={sku.onHand} onOrder={sku.onOrder} sold={sku.sold} />
      </tr>
      {skuOpen && (
        <tr className="border-b border-brand-cream">
          <td colSpan={6} className="p-0">
            <SizeGrid sku={sku} />
          </td>
        </tr>
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
  list: NikeSku[];
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
          {list.map((sku) => (
            <ReorderRow
              key={sku.sku}
              sku={sku}
              open={expandedSkus.has(sku.sku)}
              onToggleSku={onToggleSku}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReorderRow({
  sku,
  open,
  onToggleSku,
}: {
  sku: NikeSku;
  open: boolean;
  onToggleSku: (k: string) => void;
}) {
  const sizes = reorderSizes(sku);
  return (
    <>
      <tr
        onClick={() => onToggleSku(sku.sku)}
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

// ─── Size grid (shared drill-down) ───────────────────────────────────────────

function SizeGrid({ sku }: { sku: NikeSku }) {
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
            </tr>
            <tr>
              <td className="pr-2 py-0.5 text-brand-text/40 text-right">On order</td>
              {sku.sizes.map((s) => (
                <td
                  key={s.code}
                  className="px-2 py-0.5 text-center tabular-nums text-brand-text/50"
                >
                  {s.onOrder || ""}
                </td>
              ))}
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
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-brand-text/40 mt-2">
        Amber = sold with none on hand (size gap). Green sold = selling faster
        than stocked.
      </p>
    </div>
  );
}
