"use client";

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import Link from "next/link";
import {
  ChevronRight,
  Download,
  Printer,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
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
import { PerformanceTransaction } from "@/lib/parsers/parseSalesJournalPerformance";
import ImportSelector, {
  ReportMeta,
} from "@/components/report/ImportSelector";

// ─── Types ───────────────────────────────────────────────────────────────────

type SortCol =
  | "unitsSold"
  | "transactions"
  | "netSales"
  | "avgTicket"
  | "returnRate";
type SortDir = "asc" | "desc";
type ChartMode = "month" | "week" | "dow";

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT: Record<string, string> = {
  Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed",
  Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun",
};

interface SavedState {
  selectedIds: string[];
  dateStart: string;
  dateEnd: string;
  daysOfWeek: string[];
}

interface LeaderboardRow {
  name: string;
  unitsSold: number;
  transactions: number;
  netSales: number;
  avgTicket: number;
  returnRate: number;
  txns: PerformanceTransaction[];
}

// ─── LocalStorage ────────────────────────────────────────────────────────────

function lsKey(uid: string) {
  return `${uid}:team-performance-salesperson:filters`;
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

function getWeekSunday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function formatWeekLabel(sundayStr: string): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [, m, d] = sundayStr.split("-");
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

function getMonthLabel(dateStr: string): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const m = parseInt(dateStr.split("-")[1], 10);
  return months[m - 1];
}

function getMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // YYYY-MM
}

// ─── Info Bubble ─────────────────────────────────────────────────────────────

function InfoBubble({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex items-center ml-1">
      <span className="w-3.5 h-3.5 rounded-full bg-brand-text/10 text-brand-text/40 text-[9px] font-bold flex items-center justify-center cursor-help">
        ?
      </span>
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded bg-brand-green text-brand-cream text-[10px] font-body leading-snug whitespace-normal w-52 text-center opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 shadow-md">
        {text}
      </span>
    </span>
  );
}

// ─── Bar Chart ───────────────────────────────────────────────────────────────

function BarChart({
  data,
}: {
  data: { label: string; value: number }[];
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex items-end gap-1.5 h-36">
      {data.map((d) => (
        <div
          key={d.label}
          className="flex-1 flex flex-col items-center justify-end h-full min-w-0"
        >
          <span className="text-[10px] font-body text-brand-text/60 mb-1 tabular-nums">
            {d.value > 0 ? d.value : ""}
          </span>
          <div
            className="w-full rounded-t transition-all duration-200"
            style={{
              height: `${Math.max((d.value / max) * 100, d.value > 0 ? 4 : 0)}%`,
              backgroundColor: "#023a09",
            }}
          />
          <span className="text-[9px] font-body text-brand-text/40 mt-1 truncate w-full text-center">
            {d.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden mb-4">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="h-12 flex items-center gap-4 px-4 border-b border-brand-cream last:border-0"
        >
          <div className="w-4 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-6 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-36 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-10 h-3 bg-brand-cream-dark rounded animate-pulse ml-auto" />
          <div className="w-10 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-16 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-14 h-3 bg-brand-cream-dark rounded animate-pulse" />
          <div className="w-12 h-3 bg-brand-cream-dark rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Expanded Row ────────────────────────────────────────────────────────────

function ExpandedRow({
  row,
  filterStart,
  filterEnd,
  filterDays,
}: {
  row: LeaderboardRow;
  filterStart: string;
  filterEnd: string;
  filterDays: string[];
}) {
  const [chartMode, setChartMode] = useState<ChartMode>("month");

  const chartData = useMemo(() => {
    const sales = row.txns.filter((t) => !t.isReturn);

    if (chartMode === "dow") {
      const counts: Record<string, number[]> = {};
      const dateSet = new Set<string>();
      for (const t of sales) {
        if (!counts[t.dayOfWeek]) counts[t.dayOfWeek] = [];
        counts[t.dayOfWeek].push(1);
        dateSet.add(t.date + t.dayOfWeek);
      }
      // Count unique dates per DOW for averaging
      const dateCounts: Record<string, Set<string>> = {};
      for (const t of sales) {
        if (!dateCounts[t.dayOfWeek]) dateCounts[t.dayOfWeek] = new Set();
        dateCounts[t.dayOfWeek].add(t.date);
      }
      return ALL_DAYS
        .filter((d) => filterDays.includes(d))
        .map((d) => {
          const total = counts[d]?.length ?? 0;
          const days = dateCounts[d]?.size ?? 1;
          return { label: DAY_SHORT[d], value: Math.round(total / days) };
        });
    }

    if (chartMode === "week") {
      const weekMap = new Map<string, number>();
      for (const t of sales) {
        const sun = getWeekSunday(t.date);
        weekMap.set(sun, (weekMap.get(sun) ?? 0) + 1);
      }
      const sorted = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      return sorted.map(([sun, count]) => ({
        label: formatWeekLabel(sun),
        value: count,
      }));
    }

    // month
    const monthMap = new Map<string, number>();
    for (const t of sales) {
      const key = getMonthKey(t.date);
      monthMap.set(key, (monthMap.get(key) ?? 0) + 1);
    }
    const sorted = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.map(([key, count]) => ({
      label: getMonthLabel(key + "-01"),
      value: count,
    }));
  }, [row.txns, chartMode, filterDays]);

  const sortedTxns = useMemo(
    () =>
      [...row.txns].sort((a, b) =>
        a.date !== b.date
          ? b.date.localeCompare(a.date)
          : b.time.localeCompare(a.time)
      ),
    [row.txns]
  );

  return (
    <td colSpan={8} className="p-0">
      <div className="px-4 py-4 bg-brand-cream/30">
        {/* Chart */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-body text-xs text-brand-text/50 flex items-center">
              Units Sold
              {chartMode === "dow" && (
                <InfoBubble text="Average units sold per day. Total units on each day of the week divided by the number of times that day appears in the filtered date range." />
              )}
            </span>
            <div className="flex border border-brand-cream-dark rounded overflow-hidden font-body text-xs ml-auto">
              {(["month", "week", "dow"] as ChartMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setChartMode(mode)}
                  className={`px-2.5 py-0.5 transition-colors ${
                    chartMode === mode
                      ? "bg-brand-green text-brand-cream"
                      : "bg-white text-brand-text/70 hover:bg-brand-cream"
                  }`}
                >
                  {mode === "month"
                    ? "By Month"
                    : mode === "week"
                    ? "By Week"
                    : "By Day of Week"}
                </button>
              ))}
            </div>
          </div>
          {chartData.length > 0 ? (
            <BarChart data={chartData} />
          ) : (
            <p className="text-brand-text/40 text-xs font-body text-center py-6">
              No data for this view.
            </p>
          )}
        </div>

        {/* Transaction detail table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-body min-w-[800px]">
            <thead>
              <tr className="bg-brand-cream/60 text-brand-text/50">
                <th className="px-3 py-2 font-normal text-left">Date</th>
                <th className="px-3 py-2 font-normal text-left">Time</th>
                <th className="px-3 py-2 font-normal text-left">Ticket #</th>
                <th className="px-3 py-2 font-normal text-left">SKU</th>
                <th className="px-3 py-2 font-normal text-left">Product Name</th>
                <th className="px-3 py-2 font-normal text-left">Size</th>
                <th className="px-3 py-2 font-normal text-left">Sale Price</th>
                <th className="px-3 py-2 font-normal text-left">Type</th>
                <th className="px-3 py-2 font-normal text-left">Cashier</th>
              </tr>
            </thead>
            <tbody>
              {sortedTxns.map((t, idx) => (
                <tr
                  key={t.id}
                  className={idx % 2 === 0 ? "bg-white" : "bg-brand-cream/30"}
                >
                  <td className="px-3 py-1.5">{fmt(t.date)}</td>
                  <td className="px-3 py-1.5">{t.time}</td>
                  <td className="px-3 py-1.5">{t.ticketNumber}</td>
                  <td className="px-3 py-1.5">{t.sku}</td>
                  <td className="px-3 py-1.5">{t.productName}</td>
                  <td className="px-3 py-1.5">{t.size}</td>
                  <td className="px-3 py-1.5">{fmtMoney(t.salePrice)}</td>
                  <td className="px-3 py-1.5">
                    {t.isReturn ? (
                      <span className="text-red-600">Return</span>
                    ) : (
                      "Sale"
                    )}
                  </td>
                  <td className="px-3 py-1.5">{t.cashier}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </td>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SalespersonPage() {
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
  const [transactions, setTransactions] = useState<PerformanceTransaction[]>([]);
  const cacheRef = useRef<Map<string, PerformanceTransaction[]>>(new Map());
  const autoLoadedRef = useRef(false);

  useEffect(() => {
    document.title = "Salesperson · Team Performance";
  }, []);

  // Filters
  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");
  const [filterDays, setFilterDays] = useState<string[]>([...ALL_DAYS]);

  // Sort
  const [sortCol, setSortCol] = useState<SortCol>("unitsSold");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // UI
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // ─── Derived ───────────────────────────────────────────────────────────────

  const filteredTransactions = useMemo(() => {
    let result = transactions;
    if (filterStart) result = result.filter((t) => t.date >= filterStart);
    if (filterEnd) result = result.filter((t) => t.date <= filterEnd);
    if (filterDays.length < ALL_DAYS.length) {
      result = result.filter((t) => filterDays.includes(t.dayOfWeek));
    }
    return result;
  }, [transactions, filterStart, filterEnd, filterDays]);

  const leaderboard = useMemo(() => {
    const map = new Map<string, PerformanceTransaction[]>();
    for (const t of filteredTransactions) {
      if (!t.salesperson) continue;
      if (!map.has(t.salesperson)) map.set(t.salesperson, []);
      map.get(t.salesperson)!.push(t);
    }

    const rows: LeaderboardRow[] = [];
    for (const [name, txns] of map) {
      const sales = txns.filter((t) => !t.isReturn);
      const returns = txns.filter((t) => t.isReturn);
      const unitsSold = sales.length - returns.length;
      const tickets = new Set(txns.map((t) => t.ticketNumber));
      const netSales =
        sales.reduce((s, t) => s + t.salePrice, 0) -
        returns.reduce((s, t) => s + t.salePrice, 0);
      const avgTicket = tickets.size > 0 ? netSales / tickets.size : 0;
      const returnRate = sales.length > 0 ? (returns.length / sales.length) * 100 : 0;

      rows.push({
        name,
        unitsSold,
        transactions: tickets.size,
        netSales,
        avgTicket,
        returnRate,
        txns,
      });
    }

    rows.sort((a, b) => {
      const aVal = a[sortCol];
      const bVal = b[sortCol];
      return sortDir === "desc" ? (bVal as number) - (aVal as number) : (aVal as number) - (bVal as number);
    });

    return rows;
  }, [filteredTransactions, sortCol, sortDir]);

  const storeAverage = useMemo(() => {
    if (leaderboard.length === 0) return null;
    const n = leaderboard.length;
    return {
      unitsSold: leaderboard.reduce((s, r) => s + r.unitsSold, 0) / n,
      transactions: leaderboard.reduce((s, r) => s + r.transactions, 0) / n,
      netSales: leaderboard.reduce((s, r) => s + r.netSales, 0) / n,
      avgTicket: leaderboard.reduce((s, r) => s + r.avgTicket, 0) / n,
      returnRate: leaderboard.reduce((s, r) => s + r.returnRate, 0) / n,
    };
  }, [leaderboard]);

  // ─── Load data ─────────────────────────────────────────────────────────────

  const loadData = useCallback(
    async (ids: string[], saved?: SavedState) => {
      setLoadingData(true);
      setDataError(null);

      try {
        const merged: PerformanceTransaction[] = [];

        for (const id of ids) {
          if (cacheRef.current.has(id)) {
            merged.push(...cacheRef.current.get(id)!);
            continue;
          }
          const report = reports.find((r) => r.id === id);
          if (!report?.storagePath) continue;
          const downloadUrl = await getDownloadURL(
            storageRef(storage, report.storagePath)
          );
          const res = await fetch(
            `/api/storage-proxy?url=${encodeURIComponent(downloadUrl)}`
          );
          if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
          const txns: PerformanceTransaction[] = await res.json();
          cacheRef.current.set(id, txns);
          merged.push(...txns);
        }

        setTransactions(merged);

        const dates = merged.map((t) => t.date).filter(Boolean).sort();
        const defaultStart = dates[0] ?? "";
        const defaultEnd = dates[dates.length - 1] ?? "";

        const fs = saved?.dateStart || defaultStart;
        const fe = saved?.dateEnd || defaultEnd;
        const fd =
          saved?.daysOfWeek && saved.daysOfWeek.length > 0
            ? saved.daysOfWeek
            : [...ALL_DAYS];

        setFilterStart(fs);
        setFilterEnd(fe);
        setFilterDays(fd);

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
            where("module", "==", "team-performance"),
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

  const persistFilters = useCallback(() => {
    if (!user) return;
    saveSaved(user.uid, {
      selectedIds: selectorSelectedIds,
      dateStart: filterStart,
      dateEnd: filterEnd,
      daysOfWeek: filterDays,
    });
  }, [user, selectorSelectedIds, filterStart, filterEnd, filterDays]);

  const handleLoad = () => {
    loadData(selectorSelectedIds);
    persistFilters();
  };

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const handleFilterChange = (
    start: string,
    end: string,
    days: string[]
  ) => {
    setFilterStart(start);
    setFilterEnd(end);
    setFilterDays(days);
  };

  // Persist on filter change
  useEffect(() => {
    if (dataLoaded) persistFilters();
  }, [filterStart, filterEnd, filterDays, dataLoaded, persistFilters]);

  const handleReset = () => {
    const dates = transactions.map((t) => t.date).filter(Boolean).sort();
    const start = dates[0] ?? "";
    const end = dates[dates.length - 1] ?? "";
    handleFilterChange(start, end, [...ALL_DAYS]);
  };

  const toggleRow = (name: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleDay = (day: string) => {
    setFilterDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const exportCSV = () => {
    const header = [
      "Date", "Time", "DayOfWeek", "Ticket#", "Salesperson", "SKU",
      "ProductName", "Size", "SalePrice", "Type", "Cashier",
    ];
    const rows = filteredTransactions.map((t) => [
      t.date, t.time, t.dayOfWeek, t.ticketNumber, t.salesperson, t.sku,
      t.productName, t.size, t.salePrice,
      t.isReturn ? "Return" : "Sale", t.cashier,
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map(csvField).join(","))
      .join("\n");
    triggerDownload(
      csv,
      `salesperson-performance-${filterStart}-${filterEnd}.csv`
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (sortCol !== col) return null;
    return sortDir === "desc" ? (
      <ArrowDown className="w-3 h-3 inline ml-0.5" />
    ) : (
      <ArrowUp className="w-3 h-3 inline ml-0.5" />
    );
  };

  const thClass =
    "px-3 py-2 font-normal cursor-pointer hover:text-brand-green transition-colors select-none";

  const noImports = !loadingReports && reports.length === 0;
  const noData =
    dataLoaded && !loadingData && !dataError && filteredTransactions.length === 0;

  return (
    <div className="print:p-6">
      {/* Print-only header */}
      <div className="hidden print:block mb-6 pb-4 border-b border-gray-300">
        <h1 className="font-heading text-2xl font-bold">
          Salesperson Performance Report — {fmt(filterStart)} to{" "}
          {fmt(filterEnd)}
        </h1>
        <p className="text-sm text-gray-600 mt-0.5">
          Alec&apos;s Shoes · Team Performance
        </p>
      </div>

      {/* Screen header */}
      <div className="print:hidden">
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
          Salesperson Report
        </h1>
        <p className="text-brand-text/50 font-body text-sm mb-5">
          Individual salesperson performance metrics
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
            No Team Performance reports imported yet.
          </p>
          <Link
            href="/team-performance/import"
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
          {/* Filters bar */}
          <div className="sticky top-0 z-20 bg-brand-cream pb-3 pt-1 print:hidden">
            <div className="bg-white border border-brand-cream-dark rounded px-4 py-3 flex flex-wrap gap-3 items-center">
              <label className="flex items-center gap-1.5 font-body text-sm">
                <span className="text-brand-text/50 text-xs">From</span>
                <input
                  type="date"
                  value={filterStart}
                  onChange={(e) => setFilterStart(e.target.value)}
                  className="border border-brand-cream-dark rounded px-2 py-1 text-sm bg-white text-brand-text focus:outline-none focus:border-brand-green"
                />
              </label>
              <label className="flex items-center gap-1.5 font-body text-sm">
                <span className="text-brand-text/50 text-xs">To</span>
                <input
                  type="date"
                  value={filterEnd}
                  onChange={(e) => setFilterEnd(e.target.value)}
                  className="border border-brand-cream-dark rounded px-2 py-1 text-sm bg-white text-brand-text focus:outline-none focus:border-brand-green"
                />
              </label>

              {/* Day of week checkboxes */}
              <div className="flex items-center gap-1.5">
                {ALL_DAYS.map((day) => (
                  <label
                    key={day}
                    className="flex items-center gap-1 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={filterDays.includes(day)}
                      onChange={() => toggleDay(day)}
                      className="accent-brand-green w-3.5 h-3.5"
                    />
                    <span className="font-body text-xs text-brand-text/70">
                      {DAY_SHORT[day]}
                    </span>
                  </label>
                ))}
              </div>

              <button
                onClick={handleReset}
                className="ml-auto font-body text-xs text-brand-text/50 hover:text-brand-text transition-colors"
              >
                Reset
              </button>
            </div>
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
              {/* Leaderboard table */}
              <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
                <table className="w-full text-sm font-body min-w-[760px]">
                  <thead>
                    <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                      <th className="w-8 px-3 py-2 font-normal print:hidden" />
                      <th className="w-10 px-3 py-2 font-normal">#</th>
                      <th className="px-3 py-2 font-normal">Salesperson</th>
                      <th
                        className={thClass}
                        onClick={() => handleSort("unitsSold")}
                      >
                        Units Sold
                        <SortIcon col="unitsSold" />
                      </th>
                      <th
                        className={thClass}
                        onClick={() => handleSort("transactions")}
                      >
                        Transactions
                        <SortIcon col="transactions" />
                      </th>
                      <th
                        className={thClass}
                        onClick={() => handleSort("netSales")}
                      >
                        Net Sales $
                        <SortIcon col="netSales" />
                      </th>
                      <th
                        className={thClass}
                        onClick={() => handleSort("avgTicket")}
                      >
                        Avg Ticket $
                        <SortIcon col="avgTicket" />
                      </th>
                      <th
                        className={thClass}
                        onClick={() => handleSort("returnRate")}
                      >
                        Return Rate %
                        <SortIcon col="returnRate" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map((row, idx) => {
                      const isExpanded = expandedRows.has(row.name);
                      return (
                        <>
                          <tr
                            key={row.name}
                            onClick={() => toggleRow(row.name)}
                            className="cursor-pointer hover:bg-brand-cream/50 border-b border-brand-cream last:border-0 transition-colors"
                          >
                            <td className="px-3 py-3 text-brand-text/30 print:hidden">
                              <ChevronRight
                                className={`w-4 h-4 transition-transform duration-150 ${
                                  isExpanded ? "rotate-90" : ""
                                }`}
                              />
                            </td>
                            <td className="px-3 py-3 text-brand-text/40 tabular-nums">
                              {idx + 1}
                            </td>
                            <td className="px-3 py-3 font-medium">
                              {row.name}
                            </td>
                            <td className="px-3 py-3 tabular-nums">
                              {row.unitsSold}
                            </td>
                            <td className="px-3 py-3 tabular-nums">
                              {row.transactions}
                            </td>
                            <td className="px-3 py-3 tabular-nums">
                              {fmtMoney(row.netSales)}
                            </td>
                            <td className="px-3 py-3 tabular-nums">
                              {fmtMoney(row.avgTicket)}
                            </td>
                            <td className="px-3 py-3 tabular-nums">
                              {row.returnRate.toFixed(1)}%
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr
                              key={`${row.name}-expanded`}
                              className="border-b border-brand-cream print:hidden"
                            >
                              <ExpandedRow
                                row={row}
                                filterStart={filterStart}
                                filterEnd={filterEnd}
                                filterDays={filterDays}
                              />
                            </tr>
                          )}
                        </>
                      );
                    })}

                    {/* Store Average row */}
                    {storeAverage && (
                      <tr className="bg-brand-cream/60 border-t-2 border-brand-green/20 font-medium">
                        <td className="px-3 py-3 print:hidden" />
                        <td className="px-3 py-3" />
                        <td className="px-3 py-3 text-brand-text/70 italic">
                          Store Average
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {Math.round(storeAverage.unitsSold)}
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {Math.round(storeAverage.transactions)}
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {fmtMoney(storeAverage.netSales)}
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {fmtMoney(storeAverage.avgTicket)}
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {storeAverage.returnRate.toFixed(1)}%
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
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
