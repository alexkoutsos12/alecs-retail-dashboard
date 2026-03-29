"use client";

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import Link from "next/link";
import { ChevronRight, Download, Printer, ChevronDown } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
} from "firebase/firestore";
import { Transaction } from "@/lib/parsers/parseSalesJournal";
import ImportSelector, {
  ReportMeta,
} from "@/components/report/ImportSelector";

// ─── Types ───────────────────────────────────────────────────────────────────

type ViewMode = "outlet-only" | "all-perks";

interface SavedState {
  selectedIds: string[];
  dateStart: string;
  dateEnd: string;
  salespeople: string[];
  viewMode: ViewMode;
}

// ─── LocalStorage ────────────────────────────────────────────────────────────

function lsKey(uid: string) {
  return `${uid}:outlet-sales:filters`;
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
          <div className="w-10 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-16 h-3 bg-brand-cream-dark rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OutletSalesPage() {
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
    document.title = "Outlet Sales · Perk Tracker";
  }, []);

  // Applied filters
  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");
  const [filterSalespeople, setFilterSalespeople] = useState<string[]>([]);
  const [filterViewMode, setFilterViewMode] = useState<ViewMode>("outlet-only");

  // Pending filters (UI controls, before Apply)
  const [pendingStart, setPendingStart] = useState("");
  const [pendingEnd, setPendingEnd] = useState("");
  const [pendingSalespeople, setPendingSalespeople] = useState<string[]>([]);
  const [pendingViewMode, setPendingViewMode] = useState<ViewMode>("outlet-only");

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

  const filteredTransactions = useMemo(() => {
    let result =
      filterViewMode === "outlet-only"
        ? transactions.filter((t) => t.isOutlet)
        : transactions.filter((t) => t.hasPerk);

    if (filterStart) result = result.filter((t) => t.date >= filterStart);
    if (filterEnd) result = result.filter((t) => t.date <= filterEnd);

    if (
      filterSalespeople.length > 0 &&
      filterSalespeople.length < allSalespeople.length
    ) {
      result = result.filter((t) => filterSalespeople.includes(t.salesperson));
    }

    return result;
  }, [
    transactions,
    filterViewMode,
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
        outletCount: number;
        totalMarkdown: number;
      }
    >();

    for (const t of filteredTransactions) {
      if (!map.has(t.salesperson)) {
        map.set(t.salesperson, {
          name: t.salesperson,
          txns: [],
          outletCount: 0,
          totalMarkdown: 0,
        });
      }
      const g = map.get(t.salesperson)!;
      g.txns.push(t);
      if (t.isOutlet) g.outletCount++;
      g.totalMarkdown += t.markdown;
    }

    return [...map.values()]
      .map((g) => ({
        ...g,
        ticketCount: new Set(g.txns.map((t) => t.ticketNumber)).size,
        avgMarkdown: g.txns.length > 0 ? g.totalMarkdown / g.txns.length : 0,
        txns: [...g.txns].sort((a, b) =>
          a.date !== b.date
            ? b.date.localeCompare(a.date)
            : b.time.localeCompare(a.time)
        ),
      }))
      .sort((a, b) => b.outletCount - a.outletCount);
  }, [filteredTransactions]);

  const totalMarkdownSum = filteredTransactions.reduce(
    (s, t) => s + t.markdown,
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
          const txnsSnap = await getDocs(
            collection(db, "reports", id, "transactions")
          );
          const txns: Transaction[] = txnsSnap.docs.map(
            (d) => d.data() as Transaction
          );
          cacheRef.current.set(id, txns);
          merged.push(...txns);
        }

        setTransactions(merged);

        const dates = merged
          .map((t) => t.date)
          .filter(Boolean)
          .sort();
        const defaultStart = dates[0] ?? "";
        const defaultEnd = dates[dates.length - 1] ?? "";
        const allSPs = [
          ...new Set(merged.map((t) => t.salesperson)),
        ]
          .filter(Boolean)
          .sort();

        const fs = saved?.dateStart || defaultStart;
        const fe = saved?.dateEnd || defaultEnd;
        const fsp =
          saved?.salespeople?.filter((s) => allSPs.includes(s)) ?? allSPs;
        const fvm = saved?.viewMode ?? "outlet-only";

        setFilterStart(fs);
        setFilterEnd(fe);
        setFilterSalespeople(fsp.length > 0 ? fsp : allSPs);
        setFilterViewMode(fvm);
        setPendingStart(fs);
        setPendingEnd(fe);
        setPendingSalespeople(fsp.length > 0 ? fsp : allSPs);
        setPendingViewMode(fvm);

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
        setLoadingReports(false);
      } finally {
        setLoadingReports(false);
      }
    }
    fetchReports();
  }, []);

  useEffect(() => {
    if (loadingReports || reports.length === 0 || !user || autoLoadedRef.current)
      return;
    autoLoadedRef.current = true;

    const saved = loadSaved(user.uid);
    const validIds =
      saved?.selectedIds.filter((id) => reports.some((r) => r.id === id)) ?? [];

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
        viewMode: filterViewMode,
      });
    }
  };

  const handleApply = () => {
    setFilterStart(pendingStart);
    setFilterEnd(pendingEnd);
    setFilterSalespeople(pendingSalespeople);
    setFilterViewMode(pendingViewMode);
    setSpDropdownOpen(false);
    if (user) {
      saveSaved(user.uid, {
        selectedIds: selectorSelectedIds,
        dateStart: pendingStart,
        dateEnd: pendingEnd,
        salespeople: pendingSalespeople,
        viewMode: pendingViewMode,
      });
    }
  };

  const handleReset = () => {
    const dates = transactions
      .map((t) => t.date)
      .filter(Boolean)
      .sort();
    const start = dates[0] ?? "";
    const end = dates[dates.length - 1] ?? "";
    setPendingStart(start);
    setPendingEnd(end);
    setPendingSalespeople(allSalespeople);
    setPendingViewMode("outlet-only");
    setFilterStart(start);
    setFilterEnd(end);
    setFilterSalespeople(allSalespeople);
    setFilterViewMode("outlet-only");
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
      "Size", "RetailPrice", "SalePrice", "PerkAmount", "Markdown",
      "Cashier", "Customer",
    ];
    const rows = filteredTransactions.map((t) => [
      t.date, t.time, t.ticketNumber, t.salesperson, t.sku,
      t.productName, t.size, t.retailPrice, t.salePrice, t.perks,
      t.markdown, t.cashier, t.customerName,
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n");
    triggerDownload(
      csv,
      `outlet-sales-${filterStart}-${filterEnd}.csv`
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const noImports = !loadingReports && reports.length === 0;
  const noData =
    dataLoaded && !loadingData && !dataError && filteredTransactions.length === 0;

  return (
    <div className="print:p-6">
      {/* Print-only header */}
      <div className="hidden print:block mb-6 pb-4 border-b border-gray-300">
        <h1 className="font-heading text-2xl font-bold">
          Outlet Sales Report —{" "}
          {filterViewMode === "outlet-only" ? "Outlet Only" : "All Perks"}
        </h1>
        <p className="text-sm text-gray-600 mt-0.5">
          Alec&apos;s Shoes · Perk Tracker ·{" "}
          {fmt(filterStart)} to {fmt(filterEnd)}
        </p>
      </div>

      {/* Screen header */}
      <div className="print:hidden">
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
          Outlet Sales
        </h1>
        <p className="text-brand-text/50 font-body text-sm mb-5">
          Outlet items sold per salesperson
        </p>
      </div>

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

      {/* No imports state */}
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
            <div className="bg-white border border-brand-cream-dark rounded px-4 py-3 flex flex-wrap gap-3 items-center">
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

              {/* Salesperson multi-select */}
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

              {/* View mode toggle */}
              <div className="flex border border-brand-cream-dark rounded overflow-hidden font-body text-sm">
                <button
                  onClick={() => setPendingViewMode("outlet-only")}
                  className={`px-3 py-1 transition-colors ${
                    pendingViewMode === "outlet-only"
                      ? "bg-brand-green text-brand-cream"
                      : "bg-white text-brand-text/70 hover:bg-brand-cream"
                  }`}
                >
                  Outlet Only ($1)
                </button>
                <button
                  onClick={() => setPendingViewMode("all-perks")}
                  className={`px-3 py-1 transition-colors ${
                    pendingViewMode === "all-perks"
                      ? "bg-brand-green text-brand-cream"
                      : "bg-white text-brand-text/70 hover:bg-brand-cream"
                  }`}
                >
                  All Perks
                </button>
              </div>

              <div className="flex gap-2 ml-auto">
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
              label="Outlet Items Sold"
              value={filteredTransactions
                .filter((t) => t.isOutlet)
                .length.toLocaleString()}
            />
            <StatCard
              label="Unique Salespeople"
              value={groupedData.length.toLocaleString()}
            />
            <StatCard
              label="Total Markdown"
              value={fmtMoney(totalMarkdownSum)}
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

          {/* No data after filtering */}
          {noData ? (
            <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
              <p className="text-brand-text/50 font-body text-sm">
                No transactions found for the selected filters.
              </p>
            </div>
          ) : (
            <>
              {/* Interactive table (screen only) */}
              <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto print:hidden">
                <table className="w-full text-sm font-body min-w-[640px]">
                  <thead>
                    <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                      <th className="w-8 px-3 py-2 font-normal" />
                      <th className="px-3 py-2 font-normal">Salesperson</th>
                      <th className="px-3 py-2 font-normal">
                        {filterViewMode === "outlet-only"
                          ? "Outlet Items"
                          : "Perk Items"}
                      </th>
                      <th className="px-3 py-2 font-normal">Tickets</th>
                      <th className="px-3 py-2 font-normal">Total Markdown</th>
                      <th className="px-3 py-2 font-normal">
                        Avg Markdown/Item
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedData.map((group) => {
                      const isExpanded = expandedRows.has(group.name);
                      const displayCount =
                        filterViewMode === "outlet-only"
                          ? group.outletCount
                          : group.txns.length;
                      return (
                        <>
                          <tr
                            key={group.name}
                            onClick={() => toggleRow(group.name)}
                            className="cursor-pointer hover:bg-brand-cream/50 border-b border-brand-cream last:border-0 transition-colors"
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
                            <td className="px-3 py-3">{displayCount}</td>
                            <td className="px-3 py-3">{group.ticketCount}</td>
                            <td className="px-3 py-3">
                              {fmtMoney(group.totalMarkdown)}
                            </td>
                            <td className="px-3 py-3">
                              {fmtMoney(group.avgMarkdown)}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr
                              key={`${group.name}-expanded`}
                              className="border-b border-brand-cream"
                            >
                              <td colSpan={6} className="p-0">
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs font-body min-w-[800px]">
                                    <thead>
                                      <tr className="bg-brand-cream/60 text-brand-text/50">
                                        <th className="pl-10 pr-3 py-2 font-normal text-left">
                                          Date
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          Time
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          Ticket #
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          SKU
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          Product Name
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          Size
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          Retail
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          Sale
                                        </th>
                                        <th className="px-3 py-2 font-normal text-left">
                                          Markdown
                                        </th>
                                        {filterViewMode === "all-perks" && (
                                          <th className="px-3 py-2 font-normal text-left">
                                            Perk $
                                          </th>
                                        )}
                                        <th className="px-3 py-2 font-normal text-left">
                                          Cashier
                                        </th>
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
                                            {fmtMoney(t.retailPrice)}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {fmtMoney(t.salePrice)}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            {fmtMoney(t.markdown)}
                                          </td>
                                          {filterViewMode === "all-perks" && (
                                            <td className="px-3 py-1.5">
                                              {fmtMoney(t.perks)}
                                            </td>
                                          )}
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
                </table>
              </div>

              {/* Print-only detailed table */}
              <div className="hidden print:block">
                {groupedData.map((group) => (
                  <div
                    key={group.name}
                    className="mb-8"
                    style={{ breakInside: "avoid" }}
                  >
                    <h3 className="font-heading font-bold text-base mb-1">
                      {group.name}
                    </h3>
                    <p className="text-xs text-gray-500 mb-2">
                      {group.outletCount} outlet items · {group.ticketCount}{" "}
                      tickets · {fmtMoney(group.totalMarkdown)} markdown
                    </p>
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-gray-300">
                          {[
                            "Date", "Ticket #", "SKU", "Product", "Size",
                            "Retail", "Sale", "Markdown", "Cashier",
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
                              {fmtMoney(t.retailPrice)}
                            </td>
                            <td className="py-0.5 pr-3">
                              {fmtMoney(t.salePrice)}
                            </td>
                            <td className="py-0.5 pr-3">
                              {fmtMoney(t.markdown)}
                            </td>
                            <td className="py-0.5 pr-3">{t.cashier}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Print-only footer */}
      <div className="hidden print:block mt-10 pt-4 border-t border-gray-300 text-xs text-gray-400">
        Alec&apos;s Shoes · Internal Use Only ·{" "}
        {new Date().toLocaleDateString()}
      </div>
    </div>
  );
}
