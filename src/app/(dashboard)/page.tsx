"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { appModules } from "@/lib/modules";

interface ReportRow {
  id: string;
  module: string;
  filename: string;
  dateRange: { start: string; end: string };
  totalTransactions: number;
  uploadedByName: string;
  uploadedAt: { toDate: () => Date } | null;
}

interface ModuleStats {
  totalOutletItems: number;
  totalPerkItems: number;
  totalTransactions: number;
  totalSkus: number;
  uniqueSalespeople: string[];
  uniqueCashiers: string[];
  dateRange: { start: string; end: string } | null;
  importDate: string | null;
  lastImportDate: string | null;
  genderBreakdown: { mens: number; womens: number; childrens: number } | null;
}

function fmt(d: string) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

function SkeletonCard() {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded p-5">
      <div className="h-5 w-32 bg-brand-cream-dark rounded animate-pulse mb-1" />
      <div className="h-3 w-48 bg-brand-cream-dark rounded animate-pulse mb-3" />
      <div className="h-3 w-40 bg-brand-cream-dark rounded animate-pulse mb-4" />
      <div className="flex gap-2">
        <div className="h-7 w-28 bg-brand-cream-dark rounded animate-pulse" />
        <div className="h-7 w-28 bg-brand-cream-dark rounded animate-pulse" />
      </div>
    </div>
  );
}

export default function HomePage() {
  const [recentImports, setRecentImports] = useState<ReportRow[]>([]);
  const [moduleStats, setModuleStats] = useState<Record<string, ModuleStats>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Alec's Dashboard";
  }, []);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const reportsRef = collection(db, "reports");

      // Last 5 imports across all modules
      const recentSnap = await getDocs(
        query(reportsRef, orderBy("uploadedAt", "desc"), limit(5))
      );
      const recent = recentSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as ReportRow[];
      setRecentImports(recent);

      // Per-module stats from most recent import
      const statsMap: Record<string, ModuleStats> = {};
      for (const mod of appModules) {
        const modSnap = await getDocs(
          query(
            reportsRef,
            where("module", "==", mod.firestoreModule),
            orderBy("uploadedAt", "desc"),
            limit(1)
          )
        );
        if (modSnap.docs.length > 0) {
          const data = modSnap.docs[0].data();
          statsMap[mod.id] = {
            totalOutletItems: data.totalOutletItems ?? 0,
            totalPerkItems: data.totalPerkItems ?? 0,
            totalTransactions: data.totalTransactions ?? 0,
            totalSkus: data.totalSkus ?? 0,
            uniqueSalespeople: data.uniqueSalespeople ?? [],
            uniqueCashiers: data.uniqueCashiers ?? [],
            dateRange: data.dateRange ?? null,
            importDate: data.importDate ?? null,
            genderBreakdown: data.genderBreakdown ?? null,
            lastImportDate: data.uploadedAt
              ? data.uploadedAt.toDate().toLocaleDateString("en-US", {
                  month: "2-digit",
                  day: "2-digit",
                  year: "numeric",
                })
              : null,
          };
        }
      }
      setModuleStats(statsMap);
    } catch {
      setError("Failed to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasData = recentImports.length > 0;

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
        Alec&apos;s Dashboard
      </h1>

      {/* Error state */}
      {error && !loading && (
        <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-5 mb-6">
          <p className="font-body text-sm text-red-600 mb-3">{error}</p>
          <button
            onClick={fetchData}
            className="bg-red-600 text-white font-body text-sm px-4 py-1.5 rounded hover:bg-red-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Module cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {loading
          ? appModules.map((mod) => <SkeletonCard key={mod.id} />)
          : appModules.map((mod) => {
              const stats = moduleStats[mod.id];
              return (
                <div
                  key={mod.id}
                  className="bg-white border-l-[3px] border-brand-green rounded p-5"
                >
                  <h2 className="font-heading text-brand-green text-lg font-bold mb-1">
                    {mod.name}
                  </h2>
                  <p className="text-brand-text/60 text-sm font-body mb-3">
                    {mod.description}
                  </p>
                  {stats ? (
                    <div className="text-brand-text/40 text-xs font-body mb-4">
                      {mod.id === "perk-tracker" ? (
                        <p>{stats.totalOutletItems} outlet items &middot; {stats.totalPerkItems} perk items &middot; Last import: {stats.lastImportDate}</p>
                      ) : mod.id === "perk-inventory" ? (
                        <>
                          <p>{stats.totalSkus} active incentives &middot; As of {stats.importDate ? fmt(stats.importDate) : stats.lastImportDate}</p>
                          {stats.genderBreakdown && (
                            <p>{stats.genderBreakdown.mens} Men&apos;s &middot; {stats.genderBreakdown.womens} Women&apos;s &middot; {stats.genderBreakdown.childrens} Children&apos;s</p>
                          )}
                        </>
                      ) : (
                        <p>{stats.uniqueSalespeople.length} salespeople &middot; {stats.uniqueCashiers.length} cashiers &middot; Last import: {stats.dateRange ? `${fmt(stats.dateRange.start)} – ${fmt(stats.dateRange.end)}` : stats.lastImportDate}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-brand-text/40 text-xs font-body mb-4">
                      {mod.id === "perk-inventory"
                        ? "No perk inventory imported yet."
                        : "No data yet — import your first file"}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {mod.reportRoutes.map((r) => (
                      <Link
                        key={r.href}
                        href={r.href}
                        className="bg-brand-green text-brand-cream text-xs font-body px-3 py-1.5 rounded hover:bg-brand-green-mid transition-colors"
                      >
                        {r.label}
                      </Link>
                    ))}
                    <Link
                      href={mod.importRoute}
                      className="border border-brand-cream-dark text-brand-text/60 text-xs font-body px-3 py-1.5 rounded hover:bg-brand-cream transition-colors"
                    >
                      Import →
                    </Link>
                  </div>
                </div>
              );
            })}

      </div>

      {/* Recent imports */}
      {loading ? (
        <div>
          <div className="h-5 w-36 bg-brand-cream-dark rounded animate-pulse mb-3" />
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-12 flex items-center gap-4 px-4 border-b border-brand-cream last:border-0"
              >
                <div className="h-3 w-24 bg-brand-cream-dark rounded animate-pulse" />
                <div className="h-3 w-40 bg-brand-cream-dark rounded animate-pulse" />
                <div className="h-3 w-20 bg-brand-cream-dark rounded animate-pulse ml-auto" />
              </div>
            ))}
          </div>
        </div>
      ) : hasData ? (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-heading text-brand-green text-lg font-bold">
              Recent Imports
            </h2>
            <Link
              href="/perk-tracker/import"
              className="font-body text-xs text-brand-green hover:underline"
            >
              View all imports →
            </Link>
          </div>
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
            <table className="w-full text-sm font-body min-w-[600px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Module</th>
                  <th className="px-4 py-2 font-normal">Filename</th>
                  <th className="px-4 py-2 font-normal">Date Range</th>
                  <th className="px-4 py-2 font-normal">Transactions</th>
                  <th className="px-4 py-2 font-normal">Uploaded By</th>
                  <th className="px-4 py-2 font-normal">Imported At</th>
                </tr>
              </thead>
              <tbody>
                {recentImports.map((row) => {
                  const modName =
                    appModules.find((m) => m.firestoreModule === row.module)
                      ?.name ?? row.module;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-brand-cream last:border-0"
                    >
                      <td className="px-4 py-2">{modName}</td>
                      <td className="px-4 py-2 max-w-[180px] truncate">
                        {row.filename}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {fmt(row.dateRange?.start)} –{" "}
                        {fmt(row.dateRange?.end)}
                      </td>
                      <td className="px-4 py-2">{row.totalTransactions}</td>
                      <td className="px-4 py-2">{row.uploadedByName}</td>
                      <td className="px-4 py-2">
                        {row.uploadedAt
                          ? row.uploadedAt.toDate().toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        !error && (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/50 font-body text-sm mb-3">
              No data yet — import your first Sales Journal to get started.
            </p>
            <Link
              href="/perk-tracker/import"
              className="inline-block bg-brand-green text-brand-cream text-sm font-body px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
            >
              Go to Import
            </Link>
          </div>
        )
      )}
    </div>
  );
}
