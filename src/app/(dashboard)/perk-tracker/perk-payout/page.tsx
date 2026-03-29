"use client";

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import Link from "next/link";
import { ChevronRight, Download, Printer, ChevronDown, AlertTriangle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { db, storage } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
} from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { Transaction } from "@/lib/parsers/parseSalesJournal";
import ImportSelector, {
  ReportMeta,
} from "@/components/report/ImportSelector";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SavedState {
  selectedIds: string[];
  dateStart: string;
  dateEnd: string;
  salespeople: string[];
  selectedPerkAmounts: number[];
}

// ─── LocalStorage ────────────────────────────────────────────────────────────

function lsKey(uid: string) {
  return `${uid}:perk-payout:filters`;
}
function loadSaved(uid: string): SavedState | null {
  try {
    const raw = localStorage.getItem(lsKey(uid));
    return raw ? (JSON.parse(raw) as SavedState) : null;
  } catch {
    return null;
  }
}
function saveSaved(uid: string, s: SavedState) {
  try {
    localStorage.setItem(lsKey(uid), JSON.stringify(s));
  } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(d: string) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

function fmtMoney(n: number) {
  return `$${n.toFixed(2)}`;
}

function csvField(v: unknown): string {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function triggerDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function breakdownStr(txns: Transaction[]): string {
  const counts = new Map<number, number>();
  for (const t of txns) {
    counts.set(t.perks, (counts.get(t.perks) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([amt, cnt]) => `${cnt}× $${amt}`)
    .join(", ");
}

// ─── Sub-components ──────────────────────────────────────────────────────────

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

function SkeletonRows() {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden mb-4">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="h-12 flex items-center gap-4 px-4 border-b border-brand-cream last:border-0"
        >
          <div className="w-4 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-36 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-10 h-3 bg-brand-cream-dark rounded animate-pulse ml-auto" />
          <div className="w-16 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-24 h-3 bg-brand-cream-dark rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PerkPayoutPage() {
  const { user } = useAuth();

  // Reports metadata
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [loadingReports, setLoadingReports] = useState(true);

  // Import selector
  const [selectorCollapsed, setSelectorCollapsed] = useState(false);
  const [selectorSelectedIds, setSelectorSelectedIds] = useState<string[]>([]);

  // Loaded data
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const cacheRef = useRef<Map<string, Transaction[]>>(new Map());
  const autoLoadedRef = useRef(false);

  useEffect(() => {
    document.title = "Perk Payout · Perk Tracker";
  }, []);

  // Applied filters
  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");
  const [filterSalespeople, setFilterSalespeople] = useState<string[]>([]);
  const [filterPerkAmounts, setFilterPerkAmounts] = useState<number[]>([]);

  // Pending filters
  const [pendingStart, setPendingStart] = useState("");
  const [pendingEnd, setPendingEnd] = useState("");
  const [pendingSalespeople, setPendingSalespeople] = useState<string[]>([]);
  const [pendingPerkAmounts, setPendingPerkAmounts] = useState<number[]>([]);

  // UI
  const [spDropdownOpen, setSpDropdownOpen] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // ─── Derived ───────────────────────────────────────────────────────────────

  const allSalespeople = useMemo(
    () =>
      [...new Set(transactions.map((t) => t.salesperson))]
        .filter(Boolean)
        .sort(),
    [transactions]
  );

  const uniquePerkAmounts = useMemo(
    () =>
      [
        ...new Set(
          transactions.map((t) => t.perks).filter((p) => p > 0)
        ),
      ].sort((a, b) => a - b),
    [transactions]
  );

  const filteredTransactions = useMemo(() => {
    let result = transactions.filter((t) =>
      filterPerkAmounts.includes(t.perks)
    );

    if (filterStart) result = result.filter((t) => t.date >= filterStart);
    if (filterEnd) result = result.filter((t) => t.date <= filterEnd);

    if (
      filterSalespeople.length > 0 &&
      filterSalespeople.length < allSalespeople.length
    ) {
      result = result.filter((t) =>
        filterSalespeople.includes(t.salesperson)
      );
    }

    return result;
  }, [
    transactions,
    filterPerkAmounts,
    filterStart,
    filterEnd,
    filterSalespeople,
    allSalespeople.length,
  ]);

  const groupedData = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        txns: Transaction[];
        totalPerks: number;
      }
    >();

    for (const t of filteredTransactions) {
      if (!map.has(t.salesperson)) {
        map.set(t.salesperson, { name: t.salesperson, txns: [], totalPerks: 0 });
      }
      const g = map.get(t.salesperson)!;
      g.txns.push(t);
      g.totalPerks += t.perks;
    }

    return [...map.values()]
      .map((g) => ({
        ...g,
        txns: [...g.txns].sort((a, b) =>
          a.date !== b.date
            ? b.date.localeCompare(a.date)
            : b.time.localeCompare(a.time)
        ),
      }))
      .sort((a, b) => b.totalPerks - a.totalPerks);
  }, [filteredTransactions]);

  const grandTotalItems = filteredTransactions.length;
  const grandTotalPerks = filteredTransactions.reduce(
    (s, t) => s + t.perks,
    0
  );

  // ─── Load data ─────────────────────────────────────────────────────────────

  const loadData = useCallback(
    async (ids: string[], saved?: SavedState) => {
      setLoadingData(true);
      setDataError(null);

      try {
        const merged: Transaction[] = [];

        for (const id of ids) {
          if (cacheRef.current.has(id)) {
            merged.push(...cacheRef.current.get(id)!);
            continue;
          }
          const report = reports.find((r) => r.id === id);
          if (!report?.storagePath) continue;
          const downloadUrl = await getDownloadURL(storageRef(storage, report.storagePath));
          const res = await fetch(`/api/storage-proxy?url=${encodeURIComponent(downloadUrl)}`);
          if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
          const txns: Transaction[] = await res.json();
          cacheRef.current.set(id, txns);
          merged.push(...txns);
        }

        setTransactions(merged);

        const dates = merged.map((t) => t.date).filter(Boolean).sort();
        const defaultStart = dates[0] ?? "";
        const defaultEnd = dates[dates.length - 1] ?? "";
        const allSPs = [...new Set(merged.map((t) => t.salesperson))]
          .filter(Boolean)
          .sort();

        // All unique perk amounts > $1 (payable perks)
        const allAmounts = [
          ...new Set(merged.map((t) => t.perks).filter((p) => p > 0)),
        ].sort((a, b) => a - b);
        const defaultPayable = allAmounts.filter((a) => a > 1);

        const fs = saved?.dateStart || defaultStart;
        const fe = saved?.dateEnd || defaultEnd;
        const fsp =
          saved?.salespeople?.filter((s) => allSPs.includes(s)) ?? allSPs;
        const fpa =
          saved?.selectedPerkAmounts?.filter((a) =>
            allAmounts.includes(a)
          ) ?? defaultPayable;

        setFilterStart(fs);
        setFilterEnd(fe);
        setFilterSalespeople(fsp.length > 0 ? fsp : allSPs);
        setFilterPerkAmounts(fpa.length > 0 ? fpa : defaultPayable);
        setPendingStart(fs);
        setPendingEnd(fe);
        setPendingSalespeople(fsp.length > 0 ? fsp : allSPs);
        setPendingPerkAmounts(fpa.length > 0 ? fpa : defaultPayable);

        setDataLoaded(true);
        setSelectorCollapsed(true);
      } catch (err) {
        setDataError(
          err instanceof Error ? err.message : "Failed to load report data."
        );
      } finally {
        setLoadingData(false);
      }
    },
    [reports]
  );

  // ─── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    async function fetchReports() {
      try {
        const snap = await getDocs(
          query(
            collection(db, "reports"),
            where("module", "==", "perk-tracker"),
            orderBy("uploadedAt", "desc")
          )
        );
        setReports(
          snap.docs.map((d) => ({ id: d.id, ...d.data() } as ReportMeta))
        );
      } catch (err) {
        console.error("fetchReports error:", err);
      } finally {
        setLoadingReports(false);
      }
    }
    fetchReports();
  }, []);

  useEffect(() => {
    if (
      loadingReports ||
      reports.length === 0 ||
      !user ||
      autoLoadedRef.current
    )
      return;
    autoLoadedRef.current = true;

    const saved = loadSaved(user.uid);
    const validIds =
      saved?.selectedIds.filter((id) =>
        reports.some((r) => r.id === id)
      ) ?? [];

    if (validIds.length > 0) {
      setSelectorSelectedIds(validIds);
      loadData(validIds, saved ?? undefined);
    } else {
      setSelectorSelectedIds([reports[0].id]);
      loadData([reports[0].id]);
    }
  }, [loadingReports, reports, user, loadData]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleLoad = () => {
    loadData(selectorSelectedIds);
    if (user) {
      saveSaved(user.uid, {
        selectedIds: selectorSelectedIds,
        dateStart: filterStart,
        dateEnd: filterEnd,
        salespeople: filterSalespeople,
        selectedPerkAmounts: filterPerkAmounts,
      });
    }
  };

  const handleApply = () => {
    setFilterStart(pendingStart);
    setFilterEnd(pendingEnd);
    setFilterSalespeople(pendingSalespeople);
    setFilterPerkAmounts(pendingPerkAmounts);
    setSpDropdownOpen(false);
    if (user) {
      saveSaved(user.uid, {
        selectedIds: selectorSelectedIds,
        dateStart: pendingStart,
        dateEnd: pendingEnd,
        salespeople: pendingSalespeople,
        selectedPerkAmounts: pendingPerkAmounts,
      });
    }
  };

  const handleReset = () => {
    const dates = transactions.map((t) => t.date).filter(Boolean).sort();
    const start = dates[0] ?? "";
    const end = dates[dates.length - 1] ?? "";
    const defaultPayable = uniquePerkAmounts.filter((a) => a > 1);

    setPendingStart(start);
    setPendingEnd(end);
    setPendingSalespeople(allSalespeople);
    setPendingPerkAmounts(defaultPayable);
    setFilterStart(start);
    setFilterEnd(end);
    setFilterSalespeople(allSalespeople);
    setFilterPerkAmounts(defaultPayable);
  };

  const toggleRow = (name: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const exportCSV = () => {
    const header = [
      "Date", "Time", "Ticket#", "Salesperson", "SKU", "ProductName",
      "Size", "SalePrice", "PerkAmount", "Cashier",
    ];
    const rows = filteredTransactions.map((t) => [
      t.date, t.time, t.ticketNumber, t.salesperson, t.sku,
      t.productName, t.size, t.salePrice, t.perks, t.cashier,
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map(csvField).join(","))
      .join("\n");
    triggerDownload(csv, `perk-payout-${filterStart}-${filterEnd}.csv`);
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const noImports = !loadingReports && reports.length === 0;
  const noData =
    dataLoaded && !loadingData && !dataError && filteredTransactions.length === 0;

  // Check if $1 is currently included (for amber banner visibility control)
  const dollarOneIncluded = filterPerkAmounts.includes(1);

  return (
    <div className="print:p-6">
      {/* Print-only header */}
      <div className="hidden print:block mb-6 pb-4 border-b border-gray-300">
        <h1 className="font-heading text-2xl font-bold">
          Perk Payout Report
        </h1>
        <p className="text-sm text-gray-600 mt-0.5">
          Alec&apos;s Shoes · Perk Tracker ·{" "}
          {fmt(filterStart)} to {fmt(filterEnd)}
        </p>
      </div>

      {/* Screen header */}
      <div className="print:hidden">
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
          Perk Payout
        </h1>
        <p className="text-brand-text/50 font-body text-sm mb-5">
          Employee perk earnings — compensation report
        </p>
      </div>

      {/* Amber warning banner */}
      {dataLoaded && (
        <div
          className={`flex items-start gap-2.5 rounded p-3 mb-5 font-body text-sm print:hidden ${
            dollarOneIncluded
              ? "bg-orange-100 border border-orange-300 text-orange-800"
              : "bg-amber-50 border border-amber-200 text-amber-800"
          }`}
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {dollarOneIncluded
              ? "⚠ The $1 outlet tracking marker is currently included. This may inflate payout totals."
              : "Showing payable perks only ($2 and above). The $1 outlet tracking marker is excluded by default."}
          </span>
        </div>
      )}

      {/* Import selector */}
      <ImportSelector
        reports={reports}
        loadingReports={loadingReports}
        selectedIds={selectorSelectedIds}
        onSelectedChange={setSelectorSelectedIds}
        onLoad={handleLoad}
        loadingData={loadingData}
        collapsed={selectorCollapsed}
        onExpand={() => setSelectorCollapsed(false)}
      />

      {/* No imports */}
      {noImports && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center print:hidden">
          <p className="text-brand-text/50 font-body text-sm mb-3">
            No reports imported yet.
          </p>
          <Link
            href="/perk-tracker/import"
            className="inline-block bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
          >
            Import Sales Journal →
          </Link>
        </div>
      )}

      {/* Loading skeleton */}
      {loadingData && <SkeletonRows />}

      {/* Error state */}
      {dataError && !loadingData && (
        <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-5 print:hidden">
          <p className="font-body text-sm text-red-600 mb-3">
            Could not load report data: {dataError}
          </p>
          <button
            onClick={() => loadData(selectorSelectedIds)}
            className="bg-red-600 text-white font-body text-sm px-4 py-1.5 rounded hover:bg-red-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main report */}
      {dataLoaded && !loadingData && !dataError && (
        <>
          {/* Sticky filters bar */}
          <div className="sticky top-0 z-20 bg-brand-cream pb-3 pt-1 print:hidden">
            <div className="bg-white border border-brand-cream-dark rounded px-4 py-3 flex flex-wrap gap-3 items-start">
              {/* Date range */}
              <label className="flex items-center gap-1.5 font-body text-sm">
                <span className="text-brand-text/50 text-xs">From</span>
                <input
                  type="date"
                  value={pendingStart}
                  onChange={(e) => setPendingStart(e.target.value)}
                  className="border border-brand-cream-dark rounded px-2 py-1 text-sm bg-white text-brand-text focus:outline-none focus:border-brand-green"
                />
              </label>
              <label className="flex items-center gap-1.5 font-body text-sm">
                <span className="text-brand-text/50 text-xs">To</span>
                <input
                  type="date"
                  value={pendingEnd}
                  onChange={(e) => setPendingEnd(e.target.value)}
                  className="border border-brand-cream-dark rounded px-2 py-1 text-sm bg-white text-brand-text focus:outline-none focus:border-brand-green"
                />
              </label>

              {/* Salesperson dropdown */}
              <div className="relative">
                {spDropdownOpen && (
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setSpDropdownOpen(false)}
                  />
                )}
                <button
                  onClick={() => setSpDropdownOpen((o) => !o)}
                  className="relative z-40 flex items-center gap-1.5 font-body text-sm border border-brand-cream-dark rounded px-3 py-1 bg-white text-brand-text hover:border-brand-green transition-colors"
                >
                  {pendingSalespeople.length === allSalespeople.length
                    ? "All Salespeople"
                    : `${pendingSalespeople.length} selected`}
                  <ChevronDown className="w-3.5 h-3.5 text-brand-text/50" />
                </button>
                {spDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-brand-cream-dark rounded shadow-md z-40 min-w-[200px] max-h-56 overflow-y-auto">
                    <label className="flex items-center gap-2 px-3 py-2 border-b border-brand-cream hover:bg-brand-cream cursor-pointer">
                      <input
                        type="checkbox"
                        checked={
                          pendingSalespeople.length === allSalespeople.length
                        }
                        onChange={() =>
                          setPendingSalespeople(
                            pendingSalespeople.length === allSalespeople.length
                              ? []
                              : [...allSalespeople]
                          )
                        }
                        className="accent-brand-green"
                      />
                      <span className="font-body text-xs font-medium text-brand-text/60">
                        Select All
                      </span>
                    </label>
                    {allSalespeople.map((sp) => (
                      <label
                        key={sp}
                        className="flex items-center gap-2 px-3 py-1.5 hover:bg-brand-cream cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={pendingSalespeople.includes(sp)}
                          onChange={() =>
                            setPendingSalespeople(
                              pendingSalespeople.includes(sp)
                                ? pendingSalespeople.filter((s) => s !== sp)
                                : [...pendingSalespeople, sp]
                            )
                          }
                          className="accent-brand-green"
                        />
                        <span className="font-body text-sm text-brand-text">
                          {sp}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Perk amount checkboxes */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 items-center">
                <span className="font-body text-xs text-brand-text/50 mr-1">
                  Perk $:
                </span>
                {uniquePerkAmounts.map((amt) => (
                  <label
                    key={amt}
                    className={`flex items-center gap-1.5 cursor-pointer font-body text-sm ${
                      amt === 1 ? "text-amber-700" : "text-brand-text"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={pendingPerkAmounts.includes(amt)}
                      onChange={() =>
                        setPendingPerkAmounts(
                          pendingPerkAmounts.includes(amt)
                            ? pendingPerkAmounts.filter((a) => a !== amt)
                            : [...pendingPerkAmounts, amt]
                        )
                      }
                      className="accent-brand-green"
                    />
                    ${amt}
                    {amt === 1 && (
                      <span className="text-xs text-amber-600">
                        (outlet marker)
                      </span>
                    )}
                  </label>
                ))}
              </div>

              <div className="flex gap-2 ml-auto self-center">
                <button
                  onClick={handleReset}
                  className="font-body text-xs text-brand-text/50 hover:text-brand-text transition-colors"
                >
                  Reset
                </button>
                <button
                  onClick={handleApply}
                  className="bg-brand-green text-brand-cream font-body text-sm px-4 py-1 rounded hover:bg-brand-green-mid transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <StatCard
              label="Perk Items Sold"
              value={grandTotalItems.toLocaleString()}
            />
            <StatCard
              label="Salespeople with Perks"
              value={groupedData.length.toLocaleString()}
            />
            <StatCard
              label="Total Perk $ Owed"
              value={fmtMoney(grandTotalPerks)}
            />
            <StatCard
              label="Date Range"
              value={`${fmt(filterStart)} – ${fmt(filterEnd)}`}
            />
          </div>

          {/* Export buttons */}
          <div className="flex gap-2 justify-end mb-4 print:hidden">
            <button
              onClick={exportCSV}
              className="flex items-center gap-1.5 font-body text-sm border border-brand-cream-dark rounded px-3 py-1.5 bg-white hover:bg-brand-cream transition-colors"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </button>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 font-body text-sm border border-brand-cream-dark rounded px-3 py-1.5 bg-white hover:bg-brand-cream transition-colors"
            >
              <Printer className="w-4 h-4" />
              Print / Save as PDF
            </button>
          </div>

          {/* No data */}
          {noData ? (
            <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
              <p className="text-brand-text/50 font-body text-sm">
                No transactions found for the selected filters.
              </p>
            </div>
          ) : (
            <>
              {/* Interactive table */}
              <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto print:hidden">
                <table className="w-full text-sm font-body min-w-[560px]">
                  <thead>
                    <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                      <th className="w-8 px-3 py-2 font-normal" />
                      <th className="px-3 py-2 font-normal">Salesperson</th>
                      <th className="px-3 py-2 font-normal">Items Sold</th>
                      <th className="px-3 py-2 font-normal">Total Perk $</th>
                      <th className="px-3 py-2 font-normal">Breakdown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedData.map((group) => {
                      const isExpanded = expandedRows.has(group.name);
                      return (
                        <>
                          <tr
                            key={group.name}
                            onClick={() => toggleRow(group.name)}
                            className="cursor-pointer hover:bg-brand-cream/50 border-b border-brand-cream transition-colors"
                          >
                            <td className="px-3 py-3 text-brand-text/30">
                              <ChevronRight
                                className={`w-4 h-4 transition-transform duration-150 ${
                                  isExpanded ? "rotate-90" : ""
                                }`}
                              />
                            </td>
                            <td className="px-3 py-3 font-medium">
                              {group.name}
                            </td>
                            <td className="px-3 py-3">{group.txns.length}</td>
                            <td className="px-3 py-3 font-medium">
                              {fmtMoney(group.totalPerks)}
                            </td>
                            <td className="px-3 py-3 text-brand-text/60 text-xs">
                              {breakdownStr(group.txns)}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr
                              key={`${group.name}-expanded`}
                              className="border-b border-brand-cream"
                            >
                              <td colSpan={5} className="p-0">
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs font-body min-w-[700px]">
                                    <thead>
                                      <tr className="bg-brand-cream/60 text-brand-text/50">
                                        {[
                                          "Date", "Time", "Ticket #", "SKU",
                                          "Product Name", "Size", "Sale Price",
                                          "Perk $", "Cashier",
                                        ].map((h, i) => (
                                          <th
                                            key={h}
                                            className={`${
                                              i === 0 ? "pl-10 pr-3" : "px-3"
                                            } py-2 font-normal text-left`}
                                          >
                                            {h}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {group.txns.map((t, idx) => (
                                        <tr
                                          key={t.id}
                                          className={
                                            idx % 2 === 0
                                              ? "bg-white"
                                              : "bg-brand-cream/30"
                                          }
                                        >
                                          <td className="pl-10 pr-3 py-1.5">
                                            {fmt(t.date)}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {t.time}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {t.ticketNumber}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {t.sku}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {t.productName}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {t.size}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {fmtMoney(t.salePrice)}
                                          </td>
                                          <td className="px-3 py-1.5 font-medium">
                                            {fmtMoney(t.perks)}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {t.cashier}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                  {/* Grand total row — always visible */}
                  <tfoot>
                    <tr className="border-t-2 border-brand-green bg-brand-cream/30">
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3 font-heading font-bold text-brand-green">
                        TOTAL
                      </td>
                      <td className="px-3 py-3 font-heading font-bold text-brand-green">
                        {grandTotalItems}
                      </td>
                      <td className="px-3 py-3 font-heading font-bold text-brand-green">
                        {fmtMoney(grandTotalPerks)}
                      </td>
                      <td className="px-3 py-3 text-brand-text/40 text-xs">—</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Print-only layout — one section per salesperson */}
              <div className="hidden print:block">
                {groupedData.map((group) => (
                  <div
                    key={group.name}
                    className="mb-10"
                    style={{ breakInside: "avoid" }}
                  >
                    <h3 className="font-heading font-bold text-base mb-0.5">
                      {group.name}
                    </h3>
                    <p className="text-xs text-gray-500 mb-2">
                      {breakdownStr(group.txns)}
                    </p>
                    <table className="w-full text-xs border-collapse mb-2">
                      <thead>
                        <tr className="border-b border-gray-300">
                          {[
                            "Date", "Ticket #", "SKU", "Product", "Size",
                            "Sale Price", "Perk $", "Cashier",
                          ].map((h) => (
                            <th
                              key={h}
                              className="py-1 pr-3 text-left font-medium text-gray-500"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {group.txns.map((t) => (
                          <tr key={t.id} className="border-b border-gray-100">
                            <td className="py-0.5 pr-3">{fmt(t.date)}</td>
                            <td className="py-0.5 pr-3">{t.ticketNumber}</td>
                            <td className="py-0.5 pr-3">{t.sku}</td>
                            <td className="py-0.5 pr-3">{t.productName}</td>
                            <td className="py-0.5 pr-3">{t.size}</td>
                            <td className="py-0.5 pr-3">
                              {fmtMoney(t.salePrice)}
                            </td>
                            <td className="py-0.5 pr-3 font-bold">
                              {fmtMoney(t.perks)}
                            </td>
                            <td className="py-0.5 pr-3">{t.cashier}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-sm font-bold border-t border-gray-400 pt-1">
                      {group.name} total: {fmtMoney(group.totalPerks)}
                    </p>
                  </div>
                ))}
                <div className="border-t-2 border-black pt-3 mt-4">
                  <p className="font-heading font-bold text-lg">
                    Grand Total: {fmtMoney(grandTotalPerks)}
                  </p>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* Print-only footer */}
      <div className="hidden print:block mt-10 pt-4 border-t border-gray-300 text-xs text-gray-400">
        Alec&apos;s Shoes · Confidential · Internal Use Only ·{" "}
        {new Date().toLocaleDateString()}
      </div>
    </div>
  );
}
