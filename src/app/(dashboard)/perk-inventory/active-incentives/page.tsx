"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { Printer } from "lucide-react";
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
import { SkuItem } from "@/lib/parsers/parseStockStatus";

// ─── Types ──────────────────────────────────────────────────────

interface ReportMeta {
  id: string;
  importDate: string;
  totalSkus: number;
  storagePath: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function fmt(d: string) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

/** Format a single size entry — shows qty in parentheses when > 1 */
function formatSizeEntry(a: { size: string; qty: number }): string {
  const label = formatSizeLabel(a.size);
  return a.qty > 1 ? `${label}(${a.qty})` : label;
}

/** Compact sizes string with quantities: "D: 9, 10(2), 11 · W: 8.5, 9" */
function formatSizes(sku: SkuItem): string {
  const widths = sku.sizes.filter((w) => w.available.length > 0);
  if (widths.length === 0) return "—";

  // Sort sizes numerically within each width
  const sortedWidths = widths.map((w) => ({
    ...w,
    available: [...w.available].sort(
      (a, b) => parseFloat(a.size) - parseFloat(b.size)
    ),
  }));

  if (sortedWidths.length === 1) {
    const w = sortedWidths[0];
    return w.available.map(formatSizeEntry).join(", ");
  }

  return sortedWidths
    .map((w) => {
      const sizeList = w.available.map(formatSizeEntry).join(", ");
      return `${w.width}: ${sizeList}`;
    })
    .join(" \u00B7 ");
}

/** Format "090" → "9", "105" → "10.5", "100" → "10" */
function formatSizeLabel(raw: string): string {
  const n = parseFloat(raw);
  if (isNaN(n)) return raw;
  // RICS stores sizes as 3-digit strings: 090 = 9, 105 = 10.5
  if (/^\d{3}$/.test(raw)) {
    const whole = parseInt(raw.slice(0, 2), 10);
    const decimal = parseInt(raw.slice(2), 10);
    return decimal > 0 ? `${whole}.${decimal}` : String(whole);
  }
  return String(n);
}

// ─── Skeleton ───────────────────────────────────────────────────

function SkeletonTable() {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded p-6">
      <div className="h-5 w-48 bg-brand-cream-dark rounded animate-pulse mb-4" />
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-10 bg-brand-cream-dark/40 rounded animate-pulse mb-2"
        />
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────

const GENDERS = ["All", "Men's", "Women's", "Children's"] as const;

// Canonical section order within each gender
const GENDER_ORDER = ["Men's", "Women's", "Children's", "Other"];

export default function ActiveIncentivesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportMeta | null>(null);
  const [skus, setSkus] = useState<SkuItem[]>([]);

  // Filters
  const [genderFilter, setGenderFilter] = useState<string>("All");
  const [categoryFilter, setCategoryFilter] = useState<string>("All");

  useEffect(() => {
    document.title = "Active Incentives · Perk Inventory";
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", "perk-inventory"),
        orderBy("uploadedAt", "desc"),
        limit(1)
      );
      const snap = await getDocs(q);
      if (snap.docs.length === 0) {
        setReport(null);
        setSkus([]);
        setLoading(false);
        return;
      }

      const doc = snap.docs[0];
      const data = doc.data();
      const meta: ReportMeta = {
        id: doc.id,
        importDate: data.importDate ?? "",
        totalSkus: data.totalSkus ?? 0,
        storagePath: data.storagePath ?? "",
      };
      setReport(meta);

      // Download SKU JSON from Storage
      const url = await getDownloadURL(storageRef(storage, meta.storagePath));
      const res = await fetch(
        `/api/storage-proxy?url=${encodeURIComponent(url)}`
      );
      if (!res.ok) throw new Error("Failed to download inventory data.");
      const json: SkuItem[] = await res.json();
      setSkus(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load inventory data."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ─── Derived data ───────────────────────────────────────────

  const filtered = useMemo(() => {
    let items = skus;
    if (genderFilter !== "All") {
      items = items.filter((s) => s.gender === genderFilter);
    }
    if (categoryFilter !== "All") {
      if (genderFilter !== "All") {
        // Category is just the mainCategory name
        items = items.filter((s) => s.mainCategory === categoryFilter);
      } else {
        // Category is "Gender MainCategory" compound key
        items = items.filter(
          (s) => `${s.gender} ${s.mainCategory}` === categoryFilter
        );
      }
    }
    return items;
  }, [skus, genderFilter, categoryFilter]);

  // Categories available for current gender filter
  // When gender is "All", prefix with gender to disambiguate (e.g. "Men's Athletic")
  const availableCategories = useMemo(() => {
    const base =
      genderFilter !== "All"
        ? skus.filter((s) => s.gender === genderFilter)
        : skus;
    if (genderFilter !== "All") {
      return [...new Set(base.map((s) => s.mainCategory))].sort();
    }
    // "All" gender — prefix with gender name
    return [...new Set(base.map((s) => `${s.gender} ${s.mainCategory}`))].sort();
  }, [skus, genderFilter]);

  // Reset category when gender changes and category no longer available
  useEffect(() => {
    if (categoryFilter !== "All" && !availableCategories.includes(categoryFilter)) {
      setCategoryFilter("All");
    }
  }, [availableCategories, categoryFilter]);

  // Group by gender → category, sorted by perk descending within each
  const sections = useMemo(() => {
    const map = new Map<string, SkuItem[]>();
    for (const sku of filtered) {
      const key = `${sku.gender} — ${sku.mainCategory}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(sku);
    }

    // Sort within each section by perk descending
    for (const items of map.values()) {
      items.sort((a, b) => b.perk - a.perk);
    }

    // Sort sections by gender order, then category name
    return [...map.entries()].sort(([a], [b]) => {
      const gA = a.split(" — ")[0];
      const gB = b.split(" — ")[0];
      const gOrdA = GENDER_ORDER.indexOf(gA);
      const gOrdB = GENDER_ORDER.indexOf(gB);
      if (gOrdA !== gOrdB) return gOrdA - gOrdB;
      return a.localeCompare(b);
    });
  }, [filtered]);

  // ─── Render ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
          Active Incentives
        </h1>
        <SkeletonTable />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
          Active Incentives
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
          Active Incentives
        </h1>
        <div className="bg-white border-l-[3px] border-brand-green rounded p-10 text-center">
          <p className="font-body text-sm text-brand-text/50 mb-4">
            No perk inventory imported yet.
          </p>
          <Link
            href="/perk-inventory/import"
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
          /* Hide everything except main content */
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
            font-size: 11px !important;
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
          .print-section {
            break-inside: avoid;
          }
          .print-section .overflow-x-auto {
            overflow: visible !important;
          }
          .print-section table {
            min-width: 0 !important;
          }
          .print-gender-break {
            break-before: page;
          }
          table {
            font-size: 10px !important;
          }
          th,
          td {
            padding: 2px 6px !important;
          }
          @page {
            margin: 0.5in;
            @bottom-center {
              content: "Alec's Shoes · Internal Use Only · Printed ${new Date().toLocaleDateString()}";
              font-size: 8px;
              color: #999;
            }
          }
        }
      `}</style>

      {/* ─── Print header (hidden on screen) ─── */}
      <div className="print-only hidden">
        <h1
          style={{
            fontFamily: "Playfair Display, serif",
            fontSize: "22px",
            fontWeight: 700,
            marginBottom: "2px",
          }}
        >
          Active Perk Reference
        </h1>
        <p style={{ fontSize: "12px", color: "#666", marginBottom: "2px" }}>
          As of {fmt(report.importDate)}
        </p>
        <p
          style={{
            fontSize: "11px",
            color: "#999",
            marginBottom: "16px",
            borderBottom: "1px solid #ddd",
            paddingBottom: "8px",
          }}
        >
          Alec&apos;s Shoes &middot; Nashua, NH
        </p>
      </div>

      {/* ─── Screen header ─── */}
      <div className="no-print flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="font-heading text-brand-green text-2xl font-bold">
          Active Incentives
        </h1>
        <button
          onClick={() => window.print()}
          disabled={filtered.length === 0}
          title={
            filtered.length === 0
              ? "No active incentives to print"
              : "Print / Save as PDF"
          }
          className="flex items-center gap-1.5 bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Printer className="w-4 h-4" />
          Print / Save as PDF
        </button>
      </div>
      <p className="no-print text-brand-text/50 text-sm font-body mb-5">
        Current perk-eligible SKUs in stock — use this as a quick reference for which styles carry an active employee incentive.
      </p>

      {/* ─── Filters ─── */}
      <div className="no-print flex flex-col sm:flex-row gap-3 mb-6">
        {/* Gender tabs */}
        <div className="flex gap-1 bg-brand-cream rounded p-0.5">
          {GENDERS.map((g) => (
            <button
              key={g}
              onClick={() => setGenderFilter(g)}
              className={`px-3 py-1.5 rounded font-body text-xs transition-colors ${
                genderFilter === g
                  ? "bg-brand-green text-brand-cream"
                  : "text-brand-text/50 hover:text-brand-text"
              }`}
            >
              {g}
            </button>
          ))}
        </div>

        {/* Category dropdown */}
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="font-body text-sm border border-brand-cream-dark rounded px-3 py-1.5 bg-white focus:outline-none focus:border-brand-green"
        >
          <option value="All">All Categories</option>
          {availableCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* ─── No results ─── */}
      {filtered.length === 0 && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-10 text-center">
          <p className="font-body text-sm text-brand-text/50">
            No SKUs match the selected filters.
          </p>
        </div>
      )}

      {/* ─── Sections ─── */}
      {sections.map(([sectionName, items], idx) => {
        const gender = sectionName.split(" — ")[0];
        const prevGender = idx > 0 ? sections[idx - 1][0].split(" — ")[0] : null;
        const isNewGender = prevGender !== null && gender !== prevGender;
        return (
        <div key={sectionName} className={`mb-6 print-section${isNewGender ? " print-gender-break" : ""}`}>
          <h2 className="font-heading text-brand-green text-lg font-bold mb-2">
            {sectionName}
          </h2>
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
            <table className="w-full text-sm font-body min-w-[700px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">SKU</th>
                  <th className="px-4 py-2 font-normal">Description</th>
                  <th className="px-4 py-2 font-normal">Color</th>
                  <th className="px-4 py-2 font-normal">Supplier</th>
                  <th className="px-4 py-2 font-normal">Perk $</th>
                  <th className="px-4 py-2 font-normal">On Hand</th>
                  <th className="px-4 py-2 font-normal">Sizes</th>
                </tr>
              </thead>
              <tbody>
                {items.map((sku) => (
                  <tr
                    key={sku.id}
                    className="border-b border-brand-cream last:border-0"
                  >
                    <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">
                      {sku.sku}
                    </td>
                    <td className="px-4 py-2">{sku.description}</td>
                    <td className="px-4 py-2">{sku.color}</td>
                    <td className="px-4 py-2">{sku.supplier}</td>
                    <td className="px-4 py-2 font-semibold text-brand-green">
                      ${sku.perk}
                    </td>
                    <td className="px-4 py-2 text-brand-text/50">
                      {sku.totalOnHand}
                    </td>
                    <td className="px-4 py-2 text-xs text-brand-text/70">
                      {formatSizes(sku)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        );
      })}

      {/* ─── Total perk liability (screen only) ─── */}
      {filtered.length > 0 && (
        <div className="no-print bg-white border-l-[3px] border-brand-green rounded p-5 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <p className="font-heading text-brand-green text-base font-bold">
                Total Perk Liability
              </p>
              <p className="font-body text-xs text-brand-text/40">
                {filtered.length} SKU{filtered.length !== 1 ? "s" : ""} &middot;{" "}
                {filtered.reduce((s, sku) => s + sku.totalOnHand, 0).toLocaleString()} units on hand
              </p>
            </div>
            <p className="font-heading text-brand-green text-2xl font-bold">
              ${filtered.reduce((s, sku) => s + sku.perk * sku.totalOnHand, 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      )}

      {/* ─── Print footer (hidden on screen, shown in print) ─── */}
      <div className="print-only hidden" style={{ marginTop: "24px", borderTop: "1px solid #ddd", paddingTop: "8px" }}>
        <p style={{ fontSize: "9px", color: "#999", textAlign: "center" }}>
          Alec&apos;s Shoes &middot; Internal Use Only &middot; Printed{" "}
          {new Date().toLocaleDateString()}
        </p>
      </div>
    </div>
  );
}
