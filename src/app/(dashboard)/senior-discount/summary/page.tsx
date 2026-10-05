"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Link from "next/link";
import { ChevronRight, Download, Printer } from "lucide-react";
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
import {
  DiscountLine,
  DiscountAnalysis,
  DiscountCategory,
} from "@/lib/parsers/parseSeniorDiscount";
import ImportSelector, {
  ReportMeta,
} from "@/components/report/ImportSelector";

const MODULE = "senior-discount";

type View = "senior" | "other";

const CATEGORY_LABEL: Record<DiscountCategory, string> = {
  senior: "Senior",
  outlet: "Outlet",
  perk: "Perk",
  markdown: "Markdown",
  return: "Return",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtMoney(n: number): string {
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}
function fmtDate(d: string): string {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}
function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}
function dayLabel(d: string): string {
  if (!d) return "";
  const [y, m, day] = d.split("-").map((v) => parseInt(v, 10));
  const dow = DOW[new Date(y, m - 1, day).getDay()];
  return `${dow}, ${MONTHS[m - 1].slice(0, 3)} ${day}`;
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

// ─── Types ───────────────────────────────────────────────────────────────────

interface DayGroup {
  day: string;
  lines: DiscountLine[];
  total: number;
}
interface MonthGroup {
  month: string;
  days: DayGroup[];
  total: number;
  count: number;
}
interface YearGroup {
  year: string;
  months: MonthGroup[];
  total: number;
  count: number;
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
          <div className="w-16 h-3 bg-brand-cream-dark rounded animate-pulse ml-auto" />
        </div>
      ))}
    </div>
  );
}

function ReconRow({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 py-1.5 text-sm font-body ${
        strong ? "border-t border-brand-cream-dark mt-1 pt-2" : ""
      }`}
    >
      <span className={muted ? "text-brand-text/50" : "text-brand-text/70"}>
        {label}
      </span>
      <span
        className={`tabular-nums ${
          strong ? "font-bold text-brand-green" : "text-brand-text"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SeniorDiscountSummaryPage() {
  const { user } = useAuth();

  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [loadingReports, setLoadingReports] = useState(true);

  const [selectorCollapsed, setSelectorCollapsed] = useState(false);
  const [selectorSelectedIds, setSelectorSelectedIds] = useState<string[]>([]);

  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [lines, setLines] = useState<DiscountLine[]>([]);
  const [reportedTotal, setReportedTotal] = useState<number | null>(null);
  const cacheRef = useRef<Map<string, DiscountAnalysis>>(new Map());
  const autoLoadedRef = useRef(false);

  const [view, setView] = useState<View>("senior");
  const [filterStart, setFilterStart] = useState("");
  const [filterEnd, setFilterEnd] = useState("");

  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  useEffect(() => {
    document.title = "Discount Summary · Senior Discount";
  }, []);

  // ─── Reconciliation (whole import, unfiltered) ───────────────────────────────

  const seniorTotalAll = useMemo(
    () =>
      lines
        .filter((l) => l.category === "senior")
        .reduce((s, l) => s + l.discountAmount, 0),
    [lines]
  );
  const otherTotalAll = useMemo(
    () =>
      lines
        .filter((l) => l.category !== "senior")
        .reduce((s, l) => s + l.discountAmount, 0),
    [lines]
  );
  const parsedTotalAll = seniorTotalAll + otherTotalAll;

  // ─── Current view (date-filtered) ────────────────────────────────────────────

  const viewLines = useMemo(() => {
    let result = lines.filter((l) =>
      view === "senior" ? l.category === "senior" : l.category !== "senior"
    );
    if (filterStart) result = result.filter((l) => l.date >= filterStart);
    if (filterEnd) result = result.filter((l) => l.date <= filterEnd);
    return result;
  }, [lines, view, filterStart, filterEnd]);

  const years = useMemo<YearGroup[]>(() => {
    const yearMap = new Map<
      string,
      Map<string, Map<string, DiscountLine[]>>
    >();
    for (const l of viewLines) {
      if (!l.date) continue;
      const yKey = l.date.slice(0, 4);
      const mKey = l.date.slice(0, 7);
      if (!yearMap.has(yKey)) yearMap.set(yKey, new Map());
      const monthMap = yearMap.get(yKey)!;
      if (!monthMap.has(mKey)) monthMap.set(mKey, new Map());
      const dayMap = monthMap.get(mKey)!;
      if (!dayMap.has(l.date)) dayMap.set(l.date, []);
      dayMap.get(l.date)!.push(l);
    }
    return [...yearMap.entries()]
      .map(([year, monthMap]) => {
        const months: MonthGroup[] = [...monthMap.entries()]
          .map(([month, dayMap]) => {
            const days: DayGroup[] = [...dayMap.entries()]
              .map(([day, dayLines]) => ({
                day,
                lines: [...dayLines].sort((a, b) =>
                  a.time !== b.time
                    ? a.time.localeCompare(b.time)
                    : a.ticketNumber.localeCompare(b.ticketNumber)
                ),
                total: dayLines.reduce((s, l) => s + l.discountAmount, 0),
              }))
              .sort((a, b) => a.day.localeCompare(b.day));
            return {
              month,
              days,
              total: days.reduce((s, d) => s + d.total, 0),
              count: days.reduce((s, d) => s + d.lines.length, 0),
            };
          })
          .sort((a, b) => a.month.localeCompare(b.month));
        return {
          year,
          months,
          total: months.reduce((s, m) => s + m.total, 0),
          count: months.reduce((s, m) => s + m.count, 0),
        };
      })
      .sort((a, b) => a.year.localeCompare(b.year));
  }, [viewLines]);

  const viewTotal = viewLines.reduce((s, l) => s + l.discountAmount, 0);
  const viewCount = viewLines.length;
  const viewDayCount = useMemo(
    () => new Set(viewLines.map((l) => l.date)).size,
    [viewLines]
  );

  // ─── Load data ─────────────────────────────────────────────────────────────

  const loadData = useCallback(
    async (ids: string[]) => {
      setLoadingData(true);
      setDataError(null);
      try {
        const merged: DiscountLine[] = [];
        let reported: number | null = null;
        for (const id of ids) {
          let analysis = cacheRef.current.get(id);
          if (!analysis) {
            const report = reports.find((r) => r.id === id);
            if (!report?.storagePath) continue;
            const downloadUrl = await getDownloadURL(
              storageRef(storage, report.storagePath)
            );
            const res = await fetch(
              `/api/storage-proxy?url=${encodeURIComponent(downloadUrl)}`
            );
            if (!res.ok)
              throw new Error(`Download failed (HTTP ${res.status})`);
            const raw = await res.json();
            // Tolerate the earlier array-only storage shape, whose lines were
            // all senior and carried no `category`. Tag them so they still
            // classify correctly; a re-import adds the full reconciliation.
            analysis = Array.isArray(raw)
              ? {
                  lines: (raw as DiscountLine[]).map((l) => ({
                    ...l,
                    category: l.category ?? "senior",
                  })),
                  reportedTotalDiscount: null,
                }
              : (raw as DiscountAnalysis);
            cacheRef.current.set(id, analysis);
          }
          if (!analysis) continue;
          merged.push(...analysis.lines);
          if (analysis.reportedTotalDiscount != null) {
            reported = (reported ?? 0) + analysis.reportedTotalDiscount;
          }
        }

        setLines(merged);
        setReportedTotal(reported);

        const dates = merged.map((l) => l.date).filter(Boolean).sort();
        setFilterStart(dates[0] ?? "");
        setFilterEnd(dates[dates.length - 1] ?? "");
        // Default: years expanded to show months; days/transactions collapsed.
        setExpandedYears(new Set(merged.map((l) => l.date.slice(0, 4))));
        setExpandedMonths(new Set());
        setExpandedDays(new Set());

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
            where("module", "==", MODULE),
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
    setSelectorSelectedIds([reports[0].id]);
    loadData([reports[0].id]);
  }, [loadingReports, reports, user, loadData]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const toggleYear = (key: string) =>
    setExpandedYears((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleMonth = (key: string) =>
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleDay = (key: string) =>
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const exportCSV = () => {
    const header = [
      "Category", "Year", "Month", "Date", "Time", "Ticket#", "Cashier", "SKU",
      "ProductName", "Size", "Retail", "SalePrice", "DiscountPct",
      "DiscountAmount",
    ];
    const rows = viewLines.map((l) => [
      CATEGORY_LABEL[l.category],
      l.date.slice(0, 4),
      monthLabel(l.date.slice(0, 7)),
      l.date,
      l.time,
      l.ticketNumber,
      l.cashier,
      l.sku,
      l.productName,
      l.size,
      l.retailPrice.toFixed(2),
      l.salePrice.toFixed(2),
      `${(l.discountPct * 100).toFixed(1)}%`,
      l.discountAmount.toFixed(2),
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map(csvField).join(","))
      .join("\n");
    triggerDownload(
      csv,
      `${view}-discounts-${filterStart}-${filterEnd}.csv`
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const noImports = !loadingReports && reports.length === 0;
  const noData =
    dataLoaded && !loadingData && !dataError && viewLines.length === 0;
  const showCategory = view === "other";

  const detailHeaders = [
    ...(showCategory ? ["Type"] : []),
    "Time", "Ticket #", "Cashier", "SKU", "Product", "Size",
    "Retail", "Sale Price", "Disc %", "Discount $",
  ];

  return (
    <div className="print:p-6">
      {/* Print-only header */}
      <div className="hidden print:block mb-6 pb-4 border-b border-gray-300">
        <h1 className="font-heading text-2xl font-bold">
          {view === "senior" ? "Senior Discount Report" : "Other Discounts Report"}
        </h1>
        <p className="text-sm text-gray-600 mt-0.5">
          Alec&apos;s Shoes · Senior Discount · {fmtDate(filterStart)} to{" "}
          {fmtDate(filterEnd)}
        </p>
      </div>

      {/* Screen header */}
      <div className="print:hidden">
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
          Discount Summary
        </h1>
        <p className="text-brand-text/50 font-body text-sm mb-5">
          Estimated senior citizen discount (full-price items discounted ~10%),
          the other discounts given, and how they reconcile to the report&apos;s
          own total.
        </p>
      </div>

      {/* Import selector */}
      <ImportSelector
        reports={reports}
        loadingReports={loadingReports}
        selectedIds={selectorSelectedIds}
        onSelectedChange={setSelectorSelectedIds}
        onLoad={() => loadData(selectorSelectedIds)}
        loadingData={loadingData}
        collapsed={selectorCollapsed}
        onExpand={() => setSelectorCollapsed(false)}
        onCollapse={() => setSelectorCollapsed(true)}
      />

      {noImports && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center print:hidden">
          <p className="text-brand-text/50 font-body text-sm mb-3">
            No reports imported yet.
          </p>
          <Link
            href="/senior-discount/import"
            className="inline-block bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
          >
            Import Sales Journal →
          </Link>
        </div>
      )}

      {loadingData && <SkeletonRows />}

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

      {dataLoaded && !loadingData && !dataError && (
        <>
          {/* Reconciliation panel — whole import */}
          <div className="bg-white border-l-[3px] border-brand-green rounded p-5 mb-5 max-w-md">
            <p className="font-body text-[10px] uppercase tracking-wider text-brand-text/40 mb-2">
              Reconciliation · full import
            </p>
            <ReconRow
              label="Senior discount (~10%, non-perked)"
              value={fmtMoney(seniorTotalAll)}
            />
            <ReconRow
              label="Other discounts (outlet, perks, markdowns, returns)"
              value={fmtMoney(otherTotalAll)}
            />
            <ReconRow
              label="Parsed total discount"
              value={fmtMoney(parsedTotalAll)}
              strong
            />
            <ReconRow
              label="Report's total discount (Store Totals)"
              value={reportedTotal != null ? fmtMoney(reportedTotal) : "—"}
            />
            {reportedTotal != null && (
              <ReconRow
                label="Unreconciled (ticket-level / layaway)"
                value={fmtMoney(reportedTotal - parsedTotalAll)}
                muted
              />
            )}
          </div>

          {/* View toggle */}
          <div className="flex items-center gap-1 mb-4 print:hidden">
            <button
              onClick={() => setView("senior")}
              className={`font-body text-sm px-4 py-1.5 rounded transition-colors ${
                view === "senior"
                  ? "bg-brand-green text-brand-cream"
                  : "bg-white text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream"
              }`}
            >
              Senior Discount
            </button>
            <button
              onClick={() => setView("other")}
              className={`font-body text-sm px-4 py-1.5 rounded transition-colors ${
                view === "other"
                  ? "bg-brand-green text-brand-cream"
                  : "bg-white text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream"
              }`}
            >
              Other Discounts
            </button>
          </div>

          {/* Date filter + export */}
          <div className="bg-white border border-brand-cream-dark rounded px-4 py-3 flex flex-wrap gap-3 items-center mb-5 print:hidden">
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
            <div className="flex gap-2 ml-auto">
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
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <StatCard
              label={
                view === "senior"
                  ? "Senior Discount (range)"
                  : "Other Discounts (range)"
              }
              value={fmtMoney(viewTotal)}
            />
            <StatCard label="Lines" value={viewCount.toLocaleString()} />
            <StatCard label="Days" value={String(viewDayCount)} />
            <StatCard
              label="Date Range"
              value={`${fmtDate(filterStart)} – ${fmtDate(filterEnd)}`}
            />
          </div>

          {/* Per-year comparison */}
          {years.length > 1 && (
            <div className="mb-5">
              <p className="font-body text-[10px] uppercase tracking-wider text-brand-text/40 mb-2">
                {view === "senior"
                  ? "Senior discount by year"
                  : "Other discounts by year"}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {years.map((yr) => (
                  <StatCard
                    key={yr.year}
                    label={`${yr.year} · ${yr.count.toLocaleString()} lines`}
                    value={fmtMoney(yr.total)}
                  />
                ))}
              </div>
            </div>
          )}

          {noData ? (
            <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
              <p className="text-brand-text/50 font-body text-sm">
                No {view === "senior" ? "senior discounts" : "other discounts"}{" "}
                found for the selected date range.
              </p>
            </div>
          ) : (
            <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto print:hidden">
              <table className="w-full text-sm font-body min-w-[520px]">
                <thead>
                  <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                    <th className="w-8 px-3 py-2 font-normal" />
                    <th className="px-3 py-2 font-normal">Period</th>
                    <th className="px-3 py-2 font-normal">Lines</th>
                    <th className="px-3 py-2 font-normal">Discount $</th>
                  </tr>
                </thead>
                <tbody>
                  {years.map((yr) => (
                    <YearRows
                      key={yr.year}
                      yr={yr}
                      yearOpen={expandedYears.has(yr.year)}
                      expandedMonths={expandedMonths}
                      expandedDays={expandedDays}
                      detailHeaders={detailHeaders}
                      showCategory={showCategory}
                      onToggleYear={toggleYear}
                      onToggleMonth={toggleMonth}
                      onToggleDay={toggleDay}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-brand-green bg-brand-cream/30">
                    <td className="px-3 py-3" />
                    <td className="px-3 py-3 font-heading font-bold text-brand-green">
                      TOTAL
                    </td>
                    <td className="px-3 py-3 font-heading font-bold text-brand-green">
                      {viewCount}
                    </td>
                    <td className="px-3 py-3 font-heading font-bold text-brand-green">
                      {fmtMoney(viewTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Print-only layout */}
          {!noData && (
            <div className="hidden print:block">
              {years.map((yr) => (
                <div key={yr.year} className="mb-10">
                  <h2 className="font-heading font-bold text-lg mb-3 border-b-2 border-gray-400 pb-1">
                    {yr.year} — {fmtMoney(yr.total)} ({yr.count} lines)
                  </h2>
                  {yr.months.map((mo) => (
                    <div key={mo.month} className="mb-8 pl-2">
                      <h3 className="font-heading font-bold text-base mb-2 border-b border-gray-300 pb-1">
                        {monthLabel(mo.month)} — {fmtMoney(mo.total)} ({mo.count}{" "}
                        lines)
                      </h3>
                  {mo.days.map((d) => (
                    <div key={d.day} className="mb-3">
                      <p className="text-sm font-bold">
                        {dayLabel(d.day)} — {fmtMoney(d.total)}
                      </p>
                      <table className="w-full text-xs border-collapse mb-1">
                        <thead>
                          <tr className="border-b border-gray-300">
                            {detailHeaders.map((h) => (
                              <th
                                key={h}
                                className="py-0.5 pr-3 text-left font-medium text-gray-500"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {d.lines.map((l) => (
                            <tr key={l.id} className="border-b border-gray-100">
                              {showCategory && (
                                <td className="py-0.5 pr-3">
                                  {CATEGORY_LABEL[l.category]}
                                </td>
                              )}
                              <td className="py-0.5 pr-3">{l.time}</td>
                              <td className="py-0.5 pr-3">{l.ticketNumber}</td>
                              <td className="py-0.5 pr-3">{l.cashier}</td>
                              <td className="py-0.5 pr-3">{l.sku}</td>
                              <td className="py-0.5 pr-3">{l.productName}</td>
                              <td className="py-0.5 pr-3">{l.size}</td>
                              <td className="py-0.5 pr-3">
                                {fmtMoney(l.retailPrice)}
                              </td>
                              <td className="py-0.5 pr-3">
                                {fmtMoney(l.salePrice)}
                              </td>
                              <td className="py-0.5 pr-3">
                                {(l.discountPct * 100).toFixed(1)}%
                              </td>
                              <td className="py-0.5 pr-3 font-bold">
                                {fmtMoney(l.discountAmount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              <div className="border-t-2 border-black pt-3 mt-4">
                <p className="font-heading font-bold text-lg">
                  Total: {fmtMoney(viewTotal)}
                </p>
              </div>
            </div>
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

// ─── Year + Month + Day rows ─────────────────────────────────────────────────

function YearRows({
  yr,
  yearOpen,
  expandedMonths,
  expandedDays,
  detailHeaders,
  showCategory,
  onToggleYear,
  onToggleMonth,
  onToggleDay,
}: {
  yr: YearGroup;
  yearOpen: boolean;
  expandedMonths: Set<string>;
  expandedDays: Set<string>;
  detailHeaders: string[];
  showCategory: boolean;
  onToggleYear: (key: string) => void;
  onToggleMonth: (key: string) => void;
  onToggleDay: (key: string) => void;
}) {
  return (
    <>
      <tr
        onClick={() => onToggleYear(yr.year)}
        className="cursor-pointer hover:bg-brand-cream/50 border-b border-brand-cream transition-colors"
      >
        <td className="px-3 py-3 text-brand-text/30">
          <ChevronRight
            className={`w-4 h-4 transition-transform duration-150 ${
              yearOpen ? "rotate-90" : ""
            }`}
          />
        </td>
        <td className="px-3 py-3 font-heading font-bold text-brand-green">
          {yr.year}
        </td>
        <td className="px-3 py-3 font-bold">{yr.count}</td>
        <td className="px-3 py-3 font-bold">{fmtMoney(yr.total)}</td>
      </tr>

      {yearOpen &&
        yr.months.map((mo) => (
          <MonthRows
            key={mo.month}
            mo={mo}
            monthOpen={expandedMonths.has(mo.month)}
            expandedDays={expandedDays}
            detailHeaders={detailHeaders}
            showCategory={showCategory}
            onToggleMonth={onToggleMonth}
            onToggleDay={onToggleDay}
          />
        ))}
    </>
  );
}

function MonthRows({
  mo,
  monthOpen,
  expandedDays,
  detailHeaders,
  showCategory,
  onToggleMonth,
  onToggleDay,
}: {
  mo: MonthGroup;
  monthOpen: boolean;
  expandedDays: Set<string>;
  detailHeaders: string[];
  showCategory: boolean;
  onToggleMonth: (key: string) => void;
  onToggleDay: (key: string) => void;
}) {
  return (
    <>
      <tr
        onClick={() => onToggleMonth(mo.month)}
        className="cursor-pointer hover:bg-brand-cream/40 border-b border-brand-cream transition-colors"
      >
        <td className="pl-8 pr-3 py-3 text-brand-text/30">
          <ChevronRight
            className={`w-4 h-4 transition-transform duration-150 ${
              monthOpen ? "rotate-90" : ""
            }`}
          />
        </td>
        <td className="px-3 py-3 font-medium">{monthLabel(mo.month)}</td>
        <td className="px-3 py-3">{mo.count}</td>
        <td className="px-3 py-3 font-medium">{fmtMoney(mo.total)}</td>
      </tr>

      {monthOpen &&
        mo.days.map((d) => (
          <DayRows
            key={d.day}
            d={d}
            dayOpen={expandedDays.has(d.day)}
            detailHeaders={detailHeaders}
            showCategory={showCategory}
            onToggleDay={onToggleDay}
          />
        ))}
    </>
  );
}

function DayRows({
  d,
  dayOpen,
  detailHeaders,
  showCategory,
  onToggleDay,
}: {
  d: DayGroup;
  dayOpen: boolean;
  detailHeaders: string[];
  showCategory: boolean;
  onToggleDay: (key: string) => void;
}) {
  return (
    <>
      <tr
        onClick={() => onToggleDay(d.day)}
        className="cursor-pointer hover:bg-brand-cream/40 border-b border-brand-cream transition-colors bg-brand-cream/20"
      >
        <td className="py-2.5 pl-16 pr-3 text-brand-text/30">
          <ChevronRight
            className={`w-3.5 h-3.5 transition-transform duration-150 ${
              dayOpen ? "rotate-90" : ""
            }`}
          />
        </td>
        <td className="px-3 py-2.5 text-brand-text/80">{dayLabel(d.day)}</td>
        <td className="px-3 py-2.5 text-brand-text/70">{d.lines.length}</td>
        <td className="px-3 py-2.5 text-brand-text/80">{fmtMoney(d.total)}</td>
      </tr>

      {dayOpen && (
        <tr className="border-b border-brand-cream">
          <td colSpan={4} className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-body min-w-[820px]">
                <thead>
                  <tr className="bg-brand-cream/60 text-brand-text/50">
                    {detailHeaders.map((h, i) => (
                      <th
                        key={h}
                        className={`${i === 0 ? "pl-24 pr-3" : "px-3"} py-2 font-normal text-left`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l, idx) => (
                    <tr
                      key={l.id}
                      className={idx % 2 === 0 ? "bg-white" : "bg-brand-cream/30"}
                    >
                      {showCategory && (
                        <td className="pl-24 pr-3 py-1.5">
                          {CATEGORY_LABEL[l.category]}
                        </td>
                      )}
                      <td className={`${showCategory ? "px-3" : "pl-24 pr-3"} py-1.5`}>
                        {l.time}
                      </td>
                      <td className="px-3 py-1.5">{l.ticketNumber}</td>
                      <td className="px-3 py-1.5">{l.cashier}</td>
                      <td className="px-3 py-1.5">{l.sku}</td>
                      <td className="px-3 py-1.5">{l.productName}</td>
                      <td className="px-3 py-1.5">{l.size}</td>
                      <td className="px-3 py-1.5">{fmtMoney(l.retailPrice)}</td>
                      <td className="px-3 py-1.5">{fmtMoney(l.salePrice)}</td>
                      <td className="px-3 py-1.5">
                        {(l.discountPct * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-1.5 font-medium">
                        {fmtMoney(l.discountAmount)}
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
}
