"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { Printer, Search } from "lucide-react";
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
import type {
  SpecialOrderCustomer,
  OutstandingItem,
} from "@/lib/parsers/parseSpecialOrders";

// ─── Types ──────────────────────────────────────────────────────

interface ReportMeta {
  id: string;
  importDate: string;
  totalCustomers: number;
  totalOutstanding: number;
  storagePath: string;
}

type SortMode = "first-name" | "last-name" | "date-oldest" | "date-newest";

// ─── Helpers ────────────────────────────────────────────────────

function fmt(d: string) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

function fmtOrderDate(iso: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y.slice(2)}`;
}

/** RICS stores sizes as 3-digit strings: 090 = 9, 105 = 10.5. */
function formatSize(raw: string): string {
  if (!raw) return "";
  if (/^\d{3}$/.test(raw)) {
    const whole = parseInt(raw.slice(0, 2), 10);
    const decimal = parseInt(raw.slice(2), 10);
    return decimal > 0 ? `${whole}.${decimal}` : String(whole);
  }
  return raw;
}

/** Last token of a name — "Pete And Tracey Levesque" -> "Levesque". */
function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || name;
}

/** Earliest order date in outstanding list, for date-sort. */
function earliestDate(c: SpecialOrderCustomer): string {
  let best = "";
  for (const o of c.outstanding) {
    if (o.date && (!best || o.date < best)) best = o.date;
  }
  return best;
}

function latestDate(c: SpecialOrderCustomer): string {
  let best = "";
  for (const o of c.outstanding) {
    if (o.date && o.date > best) best = o.date;
  }
  return best;
}

// ─── Skeleton ───────────────────────────────────────────────────

function SkeletonList() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="bg-white border-l-[3px] border-brand-green rounded p-4"
        >
          <div className="h-4 w-48 bg-brand-cream-dark rounded animate-pulse mb-3" />
          <div className="h-3 w-full bg-brand-cream-dark/60 rounded animate-pulse mb-1" />
          <div className="h-3 w-2/3 bg-brand-cream-dark/60 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────

export default function CurrentSpecialOrdersPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportMeta | null>(null);
  const [customers, setCustomers] = useState<SpecialOrderCustomer[]>([]);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("last-name");

  useEffect(() => {
    document.title = "Current Orders · Special Orders";
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", "special-orders"),
        orderBy("uploadedAt", "desc"),
        limit(1)
      );
      const snap = await getDocs(q);
      if (snap.docs.length === 0) {
        setReport(null);
        setCustomers([]);
        setLoading(false);
        return;
      }

      const d = snap.docs[0];
      const data = d.data();
      const meta: ReportMeta = {
        id: d.id,
        importDate: data.importDate ?? "",
        totalCustomers: data.totalCustomers ?? 0,
        totalOutstanding: data.totalOutstanding ?? 0,
        storagePath: data.storagePath ?? "",
      };
      setReport(meta);

      const url = await getDownloadURL(storageRef(storage, meta.storagePath));
      const res = await fetch(
        `/api/storage-proxy?url=${encodeURIComponent(url)}`
      );
      if (!res.ok) throw new Error("Failed to download special orders data.");
      const json: SpecialOrderCustomer[] = await res.json();
      setCustomers(json);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load special orders data."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Filter by search, then sort by selected mode.
  const sortedFiltered = useMemo(() => {
    const s = search.trim().toLowerCase();
    let list = customers;
    if (s) {
      list = list.filter((c) => {
        if (c.name.toLowerCase().includes(s)) return true;
        if (c.accountNumber.toLowerCase().includes(s)) return true;
        if (c.phone.replace(/\D/g, "").includes(s.replace(/\D/g, ""))) {
          // phone-digit match (only when user typed at least one digit)
          if (/\d/.test(s)) return true;
        }
        return c.outstanding.some(
          (o) =>
            o.sku.toLowerCase().includes(s) ||
            o.ticket.toLowerCase().includes(s)
        );
      });
    }
    const copy = [...list];
    switch (sortMode) {
      case "first-name":
        copy.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "last-name":
        copy.sort((a, b) =>
          lastName(a.name).localeCompare(lastName(b.name)) ||
          a.name.localeCompare(b.name)
        );
        break;
      case "date-oldest":
        copy.sort((a, b) => {
          const da = earliestDate(a);
          const db_ = earliestDate(b);
          if (!da && !db_) return 0;
          if (!da) return 1;
          if (!db_) return -1;
          return da.localeCompare(db_);
        });
        break;
      case "date-newest":
        copy.sort((a, b) => {
          const da = latestDate(a);
          const db_ = latestDate(b);
          if (!da && !db_) return 0;
          if (!da) return 1;
          if (!db_) return -1;
          return db_.localeCompare(da);
        });
        break;
    }
    return copy;
  }, [customers, search, sortMode]);

  const filteredOutstanding = useMemo(
    () => sortedFiltered.reduce((sum, c) => sum + c.outstanding.length, 0),
    [sortedFiltered]
  );

  // ─── Render ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
          Current Orders
        </h1>
        <SkeletonList />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
          Current Orders
        </h1>
        <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-5">
          <p className="font-body text-sm text-red-600 mb-3">{error}</p>
          <button
            onClick={fetchData}
            className="bg-red-600 text-white font-body text-sm px-4 py-1.5 rounded hover:bg-red-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
          Current Orders
        </h1>
        <div className="bg-white border-l-[3px] border-brand-green rounded p-10 text-center">
          <p className="font-body text-sm text-brand-text/50 mb-4">
            No special orders imported yet.
          </p>
          <Link
            href="/special-orders/import"
            className="inline-block bg-brand-green text-brand-cream text-sm font-body px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
          >
            Go to Import
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* ─── Print styles ─── */}
      <style jsx global>{`
        @media print {
          nav,
          aside,
          header,
          [data-sidebar],
          [data-topbar],
          .no-print {
            display: none !important;
          }
          body {
            background: white !important;
            color: black !important;
            font-size: 10pt !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          main,
          [data-main] {
            padding: 0 !important;
            margin: 0 !important;
            max-width: 100% !important;
          }
          .print-only {
            display: block !important;
          }
          .customer-card {
            break-inside: avoid;
            page-break-inside: avoid;
            border: 1px solid #999 !important;
            border-left: 1px solid #999 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            margin-bottom: 6px !important;
            padding: 5px 8px !important;
            background: white !important;
          }
          .customer-card h2 {
            color: black !important;
            font-size: 11pt !important;
            margin-bottom: 3px !important;
          }
          .customer-card table {
            font-size: 9.5pt !important;
          }
          .customer-card th,
          .customer-card td {
            padding: 1px 6px !important;
            color: black !important;
            border-color: #ccc !important;
          }
          .print-special {
            font-weight: 600 !important;
            border: 1px solid #000 !important;
            padding: 0 3px !important;
            border-radius: 2px !important;
            background: white !important;
            color: black !important;
          }
          @page {
            margin: 0.5in;
            @bottom-center {
              content: "Alec's Shoes · Outstanding Special Orders · Page "
                counter(page) " of " counter(pages);
              font-size: 8pt;
              color: #666;
            }
          }
        }
      `}</style>

      {/* ─── Print header ─── */}
      <div className="print-only hidden" style={{ marginBottom: "12pt" }}>
        <h1
          style={{
            fontFamily: "Playfair Display, serif",
            fontSize: "18pt",
            fontWeight: 700,
            marginBottom: "2pt",
            color: "black",
          }}
        >
          Alec&apos;s Shoes — Outstanding Special Orders
        </h1>
        <p
          style={{
            fontSize: "10pt",
            color: "#555",
            marginBottom: "6pt",
            borderBottom: "1px solid #999",
            paddingBottom: "4pt",
          }}
        >
          As of {fmt(report.importDate)} · {report.totalCustomers} customer
          {report.totalCustomers === 1 ? "" : "s"} · {report.totalOutstanding}{" "}
          outstanding item{report.totalOutstanding === 1 ? "" : "s"}
        </p>
      </div>

      {/* ─── Screen header ─── */}
      <div className="no-print flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="font-heading text-brand-green text-2xl font-bold">
          Current Orders
        </h1>
        <button
          onClick={() => window.print()}
          disabled={sortedFiltered.length === 0}
          title={
            sortedFiltered.length === 0
              ? "Nothing to print"
              : "Print / Save as PDF"
          }
          className="flex items-center gap-1.5 bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Printer className="w-4 h-4" />
          Print / Save as PDF
        </button>
      </div>
      <p className="no-print text-brand-text/50 text-sm font-body mb-5">
        {report.totalCustomers} customer{report.totalCustomers === 1 ? "" : "s"}{" "}
        with {report.totalOutstanding} outstanding item
        {report.totalOutstanding === 1 ? "" : "s"} as of{" "}
        {fmt(report.importDate)}.
      </p>

      {/* ─── Search + Sort ─── */}
      <div className="no-print flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-brand-text/40" />
          <input
            type="text"
            placeholder="Search customer, phone, SKU, or ticket..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full font-body text-sm border border-brand-cream-dark rounded pl-9 pr-3 py-1.5 bg-white focus:outline-none focus:border-brand-green"
          />
        </div>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="font-body text-sm border border-brand-cream-dark rounded px-3 py-1.5 bg-white focus:outline-none focus:border-brand-green"
        >
          <option value="last-name">Sort: Last name A–Z</option>
          <option value="first-name">Sort: First name A–Z</option>
          <option value="date-oldest">Sort: Oldest order first</option>
          <option value="date-newest">Sort: Newest order first</option>
        </select>
      </div>

      {/* ─── Cards ─── */}
      {sortedFiltered.length === 0 ? (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-10 text-center">
          <p className="font-body text-sm text-brand-text/50">
            No customers match your search.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedFiltered.map((c) => (
            <CustomerCard key={c.accountNumber} customer={c} />
          ))}
        </div>
      )}

      {/* ─── Screen-only footer summary ─── */}
      {sortedFiltered.length > 0 && search && (
        <div className="no-print mt-4 text-brand-text/50 font-body text-xs">
          Showing {sortedFiltered.length} of {customers.length} customers ·{" "}
          {filteredOutstanding} outstanding item
          {filteredOutstanding === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

// ─── Customer card ──────────────────────────────────────────────
//
// Every card uses the same fixed-width <colgroup>, so SKU / Size / Width /
// Ordered / Ticket columns align vertically across customers (answers the
// "alignment isn't consistent person-to-person" feedback).
// ────────────────────────────────────────────────────────────────

function CustomerCard({ customer }: { customer: SpecialOrderCustomer }) {
  return (
    <div className="customer-card bg-white border-l-[3px] border-brand-green rounded p-4">
      <div className="flex items-baseline flex-wrap gap-x-3 gap-y-1 mb-2">
        <h2 className="font-heading text-brand-green text-base font-bold leading-tight">
          {customer.name}
        </h2>
        {customer.phone && (
          <span className="font-body text-sm text-brand-text/70 font-mono">
            {customer.phone}
          </span>
        )}
        <span className="font-body text-xs text-brand-text/40 font-mono ml-auto">
          #{customer.accountNumber}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-body table-fixed min-w-[620px]">
          <colgroup>
            <col style={{ width: "38%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "22%" }} />
          </colgroup>
          <thead>
            <tr className="border-b border-brand-cream-dark text-left text-brand-text/50 text-xs">
              <th className="py-1 pr-3 font-normal">SKU</th>
              <th className="py-1 pr-3 font-normal">Size</th>
              <th className="py-1 pr-3 font-normal">Width</th>
              <th className="py-1 pr-3 font-normal">Ordered</th>
              <th className="py-1 pr-0 font-normal">Ticket</th>
            </tr>
          </thead>
          <tbody>
            {customer.outstanding.map((o: OutstandingItem, idx) => (
              <tr
                key={idx}
                className="border-b border-brand-cream last:border-0"
              >
                <td className="py-1 pr-3 font-mono text-xs">
                  {o.sku === "SPECIAL" ? (
                    <span className="print-special inline-block bg-amber-100 text-amber-800 font-semibold uppercase tracking-wide text-[10px] px-1.5 py-0.5 rounded">
                      Special (custom)
                    </span>
                  ) : (
                    o.sku
                  )}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {formatSize(o.size) || (
                    <span className="text-brand-text/30">—</span>
                  )}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {o.width || <span className="text-brand-text/30">—</span>}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap text-brand-text/60">
                  {fmtOrderDate(o.date)}
                </td>
                <td className="py-1 pr-0 whitespace-nowrap font-mono text-xs text-brand-text/60">
                  {o.ticket || <span className="text-brand-text/30">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
