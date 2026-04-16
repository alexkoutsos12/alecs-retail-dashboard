"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
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
import type { ShoeClubCaptain } from "@/lib/parsers/shoeClubsParser";

// ─── Types ──────────────────────────────────────────────────────

interface ReportMeta {
  id: string;
  importDate: string;
  totalCaptains: number;
  outstandingCount: number;
  completedCount: number;
  newClubCount: number;
  storagePath: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function fmtDate(iso: string) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y.slice(2)}`;
}

function money(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function fullName(c: ShoeClubCaptain) {
  return `${c.firstName} ${c.lastName}`.trim();
}

/** "3 weeks behind" / "2 weeks ahead" / "On pace". */
function paceLabel(c: ShoeClubCaptain): string {
  if (c.weeksBehind === 0) return "On pace";
  if (c.weeksBehind > 0) {
    return `${c.weeksBehind} week${c.weeksBehind === 1 ? "" : "s"} ahead`;
  }
  const n = -c.weeksBehind;
  return `${n} week${n === 1 ? "" : "s"} behind`;
}

// ─── Skeleton ───────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="bg-white border-l-[3px] border-brand-green rounded p-5"
        >
          <div className="h-5 w-48 bg-brand-cream-dark rounded animate-pulse mb-3" />
          {[1, 2, 3].map((j) => (
            <div
              key={j}
              className="h-8 bg-brand-cream-dark/40 rounded animate-pulse mb-2"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────

export default function ClubStatusPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportMeta | null>(null);
  const [captains, setCaptains] = useState<ShoeClubCaptain[]>([]);

  useEffect(() => {
    document.title = "Club Status · Shoe Clubs";
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", "shoe-clubs"),
        orderBy("uploadedAt", "desc"),
        limit(1)
      );
      const snap = await getDocs(q);
      if (snap.docs.length === 0) {
        setReport(null);
        setCaptains([]);
        setLoading(false);
        return;
      }

      const d = snap.docs[0];
      const data = d.data();
      const meta: ReportMeta = {
        id: d.id,
        importDate: data.importDate ?? "",
        totalCaptains: data.totalCaptains ?? 0,
        outstandingCount: data.outstandingCount ?? 0,
        completedCount: data.completedCount ?? 0,
        newClubCount: data.newClubCount ?? 0,
        storagePath: data.storagePath ?? "",
      };
      setReport(meta);

      const url = await getDownloadURL(storageRef(storage, meta.storagePath));
      const res = await fetch(
        `/api/storage-proxy?url=${encodeURIComponent(url)}`
      );
      if (!res.ok) throw new Error("Failed to download captains data.");
      const json: ShoeClubCaptain[] = await res.json();
      setCaptains(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load captains data."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const groups = useMemo(() => {
    return {
      outstanding: captains.filter((c) => c.category === "outstanding"),
      completed: captains.filter((c) => c.category === "completed"),
      newClub: captains.filter((c) => c.category === "new-club"),
    };
  }, [captains]);

  // ─── Render ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
          Club Status
        </h1>
        <Skeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
          Club Status
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
          Club Status
        </h1>
        <div className="bg-white border-l-[3px] border-brand-green rounded p-10 text-center">
          <p className="font-body text-sm text-brand-text/50 mb-4">
            No captains list imported yet.
          </p>
          <Link
            href="/shoe-clubs/import"
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
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Club Status
      </h1>
      <p className="text-brand-text/50 text-sm font-body mb-6">
        {report.totalCaptains} captain{report.totalCaptains === 1 ? "" : "s"} ·
        as of {fmtDate(report.importDate)}
      </p>

      {/* Outstanding Balance */}
      <Section
        title="Outstanding Balance"
        subtitle="Active clubs with a remaining balance — most delinquent first."
        count={groups.outstanding.length}
      >
        {groups.outstanding.length === 0 ? (
          <EmptyRow text="No active clubs with outstanding balances." />
        ) : (
          <CaptainTable captains={groups.outstanding} showPace />
        )}
      </Section>

      {/* Completed Clubs */}
      <Section
        title="Completed Clubs"
        subtitle="Clubs that have finished and are fully paid."
        count={groups.completed.length}
      >
        {groups.completed.length === 0 ? (
          <EmptyRow text="No completed clubs." />
        ) : (
          <CaptainTable captains={groups.completed} />
        )}
      </Section>

      {/* New Clubs */}
      <Section
        title="New Clubs"
        subtitle="Captains who just started a new club — balance hasn't been reset in RICS yet."
        count={groups.newClub.length}
      >
        {groups.newClub.length === 0 ? (
          <EmptyRow text="No new clubs pending." />
        ) : (
          <CaptainTable captains={groups.newClub} />
        )}
      </Section>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────

function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="font-heading text-brand-green text-lg font-bold">
          {title}
        </h2>
        <span className="font-body text-sm text-brand-text/40">({count})</span>
      </div>
      <p className="font-body text-xs text-brand-text/50 mb-3">{subtitle}</p>
      {children}
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded p-5 text-center">
      <p className="font-body text-sm text-brand-text/40">{text}</p>
    </div>
  );
}

function CaptainTable({
  captains,
  showPace = false,
}: {
  captains: ShoeClubCaptain[];
  showPace?: boolean;
}) {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
      <table className="w-full text-sm font-body min-w-[720px]">
        <thead>
          <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
            <th className="px-4 py-2 font-normal">Captain</th>
            <th className="px-4 py-2 font-normal">Phone</th>
            <th className="px-4 py-2 font-normal">Started</th>
            <th className="px-4 py-2 font-normal text-right">Club Total</th>
            <th className="px-4 py-2 font-normal text-right">Weekly</th>
            <th className="px-4 py-2 font-normal text-right">Paid</th>
            <th className="px-4 py-2 font-normal text-right">Balance</th>
            {showPace && (
              <th className="px-4 py-2 font-normal">Pace</th>
            )}
          </tr>
        </thead>
        <tbody>
          {captains.map((c) => (
            <tr
              key={c.accountNumber}
              className="border-b border-brand-cream last:border-0"
            >
              <td className="px-4 py-2 whitespace-nowrap">
                <div className="flex items-center gap-1.5">
                  {c.isOverdue && (
                    <AlertTriangle
                      className="w-3.5 h-3.5 text-amber-600 shrink-0"
                      aria-label="Overdue"
                    />
                  )}
                  <span className="font-medium">{fullName(c)}</span>
                </div>
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-brand-text/70 font-mono text-xs">
                {c.phoneNumber || (
                  <span className="text-brand-text/30">—</span>
                )}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-brand-text/60">
                {fmtDate(c.clubStartDate)}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-right">
                {money(c.clubTotal)}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-right text-brand-text/60">
                {money(c.weeklyAmount)}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-right text-brand-text/60">
                {money(c.amountPaid)}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-right font-medium">
                {money(c.currentBalance)}
              </td>
              {showPace && (
                <td className="px-4 py-2 whitespace-nowrap">
                  <PaceBadge captain={c} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaceBadge({ captain: c }: { captain: ShoeClubCaptain }) {
  const label = paceLabel(c);
  if (c.isOverdue) {
    return (
      <span className="inline-block bg-red-100 text-red-700 font-semibold text-[11px] px-2 py-0.5 rounded">
        Overdue · {label}
      </span>
    );
  }
  if (c.weeksBehind === 0) {
    return (
      <span className="inline-block bg-brand-green/10 text-brand-green font-semibold text-[11px] px-2 py-0.5 rounded">
        {label}
      </span>
    );
  }
  if (c.weeksBehind > 0) {
    return (
      <span className="inline-block bg-emerald-100 text-emerald-700 font-semibold text-[11px] px-2 py-0.5 rounded">
        {label}
      </span>
    );
  }
  return (
    <span className="inline-block bg-amber-100 text-amber-700 font-semibold text-[11px] px-2 py-0.5 rounded">
      {label}
    </span>
  );
}
