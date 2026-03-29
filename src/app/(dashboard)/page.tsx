"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, query, orderBy, limit, getDocs, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { modules } from "@/lib/module-config";

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
  lastImportDate: string | null;
}

export default function HomePage() {
  const [recentImports, setRecentImports] = useState<ReportRow[]>([]);
  const [moduleStats, setModuleStats] = useState<Record<string, ModuleStats>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const reportsRef = collection(db, "reports");

        const recentQuery = query(reportsRef, orderBy("uploadedAt", "desc"), limit(5));
        const recentSnap = await getDocs(recentQuery);
        const recent = recentSnap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as ReportRow[];
        setRecentImports(recent);

        const statsMap: Record<string, ModuleStats> = {};
        for (const mod of modules) {
          if (mod.placeholder) continue;
          const modQuery = query(
            reportsRef,
            where("module", "==", mod.firestoreModule),
            orderBy("uploadedAt", "desc"),
            limit(1)
          );
          const modSnap = await getDocs(modQuery);
          if (modSnap.docs.length > 0) {
            const data = modSnap.docs[0].data();
            statsMap[mod.id] = {
              totalOutletItems: data.totalOutletItems || 0,
              totalPerkItems: data.totalPerkItems || 0,
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
        // Firestore may not have data yet
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const hasData = recentImports.length > 0;

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
        Alec&apos;s Dashboard
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {modules.map((mod) => {
          if (mod.placeholder) {
            return (
              <div
                key={mod.id}
                className="border-2 border-dashed border-brand-cream-dark rounded p-6 flex items-center justify-center"
              >
                <p className="text-brand-text/30 font-body text-sm">
                  New module coming soon
                </p>
              </div>
            );
          }

          const stats = moduleStats[mod.id];

          return (
            <div
              key={mod.id}
              className="bg-white border-l-[3px] border-brand-green rounded p-5"
            >
              <h2 className="font-heading text-brand-green text-lg font-bold mb-1">
                {mod.title}
              </h2>
              <p className="text-brand-text/60 text-sm font-body mb-3">
                {mod.description}
              </p>
              {stats ? (
                <p className="text-brand-text/40 text-xs font-body mb-4">
                  {stats.totalOutletItems} outlet items · {stats.totalPerkItems}{" "}
                  perk items · Last import: {stats.lastImportDate}
                </p>
              ) : (
                !loading && (
                  <p className="text-brand-text/40 text-xs font-body mb-4">
                    No data yet
                  </p>
                )
              )}
              <div className="flex gap-2">
                {mod.buttons.map((btn) => (
                  <Link
                    key={btn.href}
                    href={btn.href}
                    className="bg-brand-green text-brand-cream text-xs font-body px-3 py-1.5 rounded hover:bg-brand-green-mid transition-colors"
                  >
                    {btn.label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {hasData ? (
        <div>
          <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
            Recent Imports
          </h2>
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Module</th>
                  <th className="px-4 py-2 font-normal">Filename</th>
                  <th className="px-4 py-2 font-normal">Date Range</th>
                  <th className="px-4 py-2 font-normal">Transactions</th>
                  <th className="px-4 py-2 font-normal">Uploaded By</th>
                  <th className="px-4 py-2 font-normal">When</th>
                </tr>
              </thead>
              <tbody>
                {recentImports.map((row) => (
                  <tr key={row.id} className="border-b border-brand-cream last:border-0">
                    <td className="px-4 py-2">{row.module}</td>
                    <td className="px-4 py-2">{row.filename}</td>
                    <td className="px-4 py-2">
                      {row.dateRange?.start} – {row.dateRange?.end}
                    </td>
                    <td className="px-4 py-2">{row.totalTransactions}</td>
                    <td className="px-4 py-2">{row.uploadedByName}</td>
                    <td className="px-4 py-2">
                      {row.uploadedAt
                        ? row.uploadedAt.toDate().toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        !loading && (
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
