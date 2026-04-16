"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { Printer, AlertTriangle } from "lucide-react";
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

function fmtDateLong(iso: string) {
  if (!iso) return "";
  const [y, m, day] = iso.split("-");
  return `${m}/${day}/${y}`;
}

function money(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/** "SMITH, J" — last name + first initial, used as the primary label. */
function displayName(c: ShoeClubCaptain) {
  const last = (c.lastName || "").toUpperCase();
  const initial = (c.firstName || "").trim().charAt(0).toUpperCase();
  if (!last && !initial) return "(no name)";
  if (!initial) return last;
  return `${last}, ${initial}`;
}

/** Week number out of 10 that the captain is currently in. */
function currentWeekOf10(c: ShoeClubCaptain): number {
  return Math.min(10, c.weeksElapsed + 1);
}

/** How many weekly installments have actually been paid. */
function weeksPaid(c: ShoeClubCaptain): number {
  if (c.weeklyAmount <= 0) return 0;
  return Math.max(0, Math.floor(c.amountPaid / c.weeklyAmount));
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

  // Parser already sorts within each category, but enforce it here in case
  // the JSON on disk ever arrives out of order.
  const groups = useMemo(() => {
    const byLast = (a: ShoeClubCaptain, b: ShoeClubCaptain) =>
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName);
    const outstanding = captains
      .filter((c) => c.category === "outstanding")
      .sort((a, b) => a.weeksBehind - b.weeksBehind || byLast(a, b));
    const completed = captains
      .filter((c) => c.category === "completed")
      .sort(byLast);
    const newClub = captains
      .filter((c) => c.category === "new-club")
      .sort(byLast);
    return { outstanding, completed, newClub };
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
            font-size: 9pt !important;
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

          /* Section containers — keep the header with its first rows so
             a section never starts alone at the bottom of a page. */
          .club-section {
            break-inside: avoid-page;
            page-break-inside: avoid;
            margin-bottom: 10pt;
          }
          .club-section h2 {
            break-after: avoid-page;
            page-break-after: avoid;
            color: black !important;
            font-size: 11pt !important;
            margin: 6pt 0 3pt 0 !important;
          }
          .club-section .section-lead {
            break-after: avoid-page;
            page-break-after: avoid;
          }

          /* Strip all decorative color/border treatments for print */
          .club-section .club-card {
            border: 1px solid #777 !important;
            border-left: 1px solid #777 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            background: white !important;
            padding: 0 !important;
          }

          table {
            font-size: 8.5pt !important;
            width: 100% !important;
          }
          thead {
            display: table-header-group; /* repeat header each page */
          }
          th,
          td {
            padding: 1px 5px !important;
            color: black !important;
            border-color: #ccc !important;
          }
          tr {
            break-inside: avoid;
            page-break-inside: avoid;
          }

          /* Pace badges — replace colored pills with plain text + an
             outlined "OVERDUE" marker so nothing depends on color. */
          .pace-badge {
            background: transparent !important;
            color: black !important;
            padding: 0 !important;
            border: none !important;
            font-weight: 500 !important;
          }
          .pace-badge.overdue {
            border: 1px solid #000 !important;
            padding: 0 3px !important;
            font-weight: 700 !important;
          }

          @page {
            margin: 0.4in;
            @bottom-center {
              content: "Alec's Shoes · Shoe Club Status · Page "
                counter(page) " of " counter(pages);
              font-size: 8pt;
              color: #666;
            }
          }
        }
      `}</style>

      {/* ─── Print-only header ─── */}
      <div className="print-only hidden" style={{ marginBottom: "8pt" }}>
        <h1
          style={{
            fontFamily: "Playfair Display, serif",
            fontSize: "16pt",
            fontWeight: 700,
            marginBottom: "2pt",
            color: "black",
          }}
        >
          Alec&apos;s Shoes — Shoe Club Status
        </h1>
        <p
          style={{
            fontSize: "9pt",
            color: "#555",
            borderBottom: "1px solid #999",
            paddingBottom: "3pt",
          }}
        >
          As of {fmtDateLong(report.importDate)} · {report.totalCaptains}{" "}
          captain{report.totalCaptains === 1 ? "" : "s"} ·{" "}
          {report.outstandingCount} outstanding · {report.completedCount}{" "}
          completed · {report.newClubCount} new
        </p>
      </div>

      {/* ─── Screen header ─── */}
      <div className="no-print flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="font-heading text-brand-green text-2xl font-bold">
          Club Status
        </h1>
        <button
          onClick={() => window.print()}
          disabled={captains.length === 0}
          title={captains.length === 0 ? "Nothing to print" : "Print / Save as PDF"}
          className="flex items-center gap-1.5 bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Printer className="w-4 h-4" />
          Print / Save as PDF
        </button>
      </div>
      <p className="no-print text-brand-text/50 text-sm font-body mb-5">
        {report.totalCaptains} captain{report.totalCaptains === 1 ? "" : "s"}{" "}
        &middot; {report.outstandingCount} outstanding &middot;{" "}
        {report.completedCount} completed &middot; {report.newClubCount} new
        &middot; as of {fmtDateLong(report.importDate)}
      </p>

      {/* ─── Summary tiles (screen) ─── */}
      <div className="no-print grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryTile
          label="Total Captains"
          value={report.totalCaptains}
          tone="neutral"
        />
        <SummaryTile
          label="Outstanding"
          value={report.outstandingCount}
          tone="amber"
        />
        <SummaryTile
          label="Completed"
          value={report.completedCount}
          tone="green"
        />
        <SummaryTile
          label="New Clubs"
          value={report.newClubCount}
          tone="blue"
        />
      </div>

      {/* ─── 1. Outstanding ─── */}
      <Section
        title="Outstanding Balance"
        subtitle="Active clubs with money still owed — most delinquent first."
        count={groups.outstanding.length}
      >
        {groups.outstanding.length === 0 ? (
          <EmptyCard text="No active clubs with outstanding balances." />
        ) : (
          <OutstandingTable captains={groups.outstanding} />
        )}
      </Section>

      {/* ─── 2. Completed ─── */}
      <Section
        title="Completed Clubs"
        subtitle="Clubs that have finished and are fully paid."
        count={groups.completed.length}
      >
        {groups.completed.length === 0 ? (
          <EmptyCard text="No completed clubs." />
        ) : (
          <CompletedTable captains={groups.completed} />
        )}
      </Section>

      {/* ─── 3. New Clubs ─── */}
      <Section
        title="New Clubs"
        subtitle="Negative balance — captain has started a new cycle that RICS hasn't adjusted yet."
        count={groups.newClub.length}
      >
        {groups.newClub.length === 0 ? (
          <EmptyCard text="No new clubs pending." />
        ) : (
          <NewClubTable captains={groups.newClub} />
        )}
      </Section>
    </div>
  );
}

// ─── Summary tile ───────────────────────────────────────────────

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "amber" | "green" | "blue";
}) {
  const bar = {
    neutral: "border-brand-green",
    amber: "border-amber-500",
    green: "border-emerald-500",
    blue: "border-sky-500",
  }[tone];
  return (
    <div className={`bg-white border-l-[3px] ${bar} rounded p-3`}>
      <p className="font-body text-[10px] uppercase tracking-wider text-brand-text/40 mb-0.5">
        {label}
      </p>
      <p className="font-heading text-brand-green text-2xl font-bold leading-none">
        {value}
      </p>
    </div>
  );
}

// ─── Section shell ──────────────────────────────────────────────

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
    <section className="club-section mb-8">
      <div className="section-lead">
        <div className="flex items-baseline gap-2 mb-1">
          <h2 className="font-heading text-brand-green text-lg font-bold">
            {title} <span className="text-brand-text/40 font-normal text-base">({count})</span>
          </h2>
        </div>
        <p className="font-body text-xs text-brand-text/50 mb-2">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div className="club-card bg-white border-l-[3px] border-brand-green rounded p-5 text-center">
      <p className="font-body text-sm text-brand-text/40">{text}</p>
    </div>
  );
}

// ─── Outstanding table ──────────────────────────────────────────

function OutstandingTable({ captains }: { captains: ShoeClubCaptain[] }) {
  return (
    <div className="club-card bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
      <table className="w-full text-sm font-body min-w-[960px]">
        <thead>
          <tr className="border-b border-brand-cream-dark text-left text-brand-text/50 text-xs">
            <th className="px-3 py-2 font-normal">Captain</th>
            <th className="px-3 py-2 font-normal">Account</th>
            <th className="px-3 py-2 font-normal">Phone</th>
            <th className="px-3 py-2 font-normal">Started</th>
            <th className="px-3 py-2 font-normal text-right">Total</th>
            <th className="px-3 py-2 font-normal text-right">Weekly</th>
            <th className="px-3 py-2 font-normal text-right">Balance</th>
            <th className="px-3 py-2 font-normal text-center">Wk&nbsp;/&nbsp;10</th>
            <th className="px-3 py-2 font-normal text-center">Paid</th>
            <th className="px-3 py-2 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {captains.map((c) => (
            <tr
              key={c.accountNumber}
              className="border-b border-brand-cream last:border-0"
            >
              <td className="px-3 py-1.5 whitespace-nowrap font-medium">
                {displayName(c)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs text-brand-text/60">
                {c.accountNumber}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-brand-text/70 font-mono text-xs">
                {c.phoneNumber || (
                  <span className="text-brand-text/30">—</span>
                )}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-brand-text/60">
                {fmtDate(c.clubStartDate)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-right">
                {money(c.clubTotal)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-right text-brand-text/60">
                {money(c.weeklyAmount)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-right font-semibold">
                {money(c.currentBalance)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-center text-brand-text/70">
                {currentWeekOf10(c)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-center text-brand-text/70">
                {weeksPaid(c)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <StatusBadge captain={c} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Completed table ────────────────────────────────────────────
//
// Mirrors the Outstanding layout so columns line up visually. Wk/10 and
// Paid are always 10 for completed clubs, and Status shows a green
// "Completed payment" badge.

function CompletedTable({ captains }: { captains: ShoeClubCaptain[] }) {
  return (
    <div className="club-card bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
      <table className="w-full text-sm font-body min-w-[960px]">
        <thead>
          <tr className="border-b border-brand-cream-dark text-left text-brand-text/50 text-xs">
            <th className="px-3 py-2 font-normal">Captain</th>
            <th className="px-3 py-2 font-normal">Account</th>
            <th className="px-3 py-2 font-normal">Phone</th>
            <th className="px-3 py-2 font-normal">Started</th>
            <th className="px-3 py-2 font-normal text-right">Total</th>
            <th className="px-3 py-2 font-normal text-right">Weekly</th>
            <th className="px-3 py-2 font-normal text-right">Balance</th>
            <th className="px-3 py-2 font-normal text-center">Wk&nbsp;/&nbsp;10</th>
            <th className="px-3 py-2 font-normal text-center">Paid</th>
            <th className="px-3 py-2 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {captains.map((c) => (
            <tr
              key={c.accountNumber}
              className="border-b border-brand-cream last:border-0"
            >
              <td className="px-3 py-1.5 whitespace-nowrap font-medium">
                {displayName(c)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs text-brand-text/60">
                {c.accountNumber}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-brand-text/70 font-mono text-xs">
                {c.phoneNumber || (
                  <span className="text-brand-text/30">—</span>
                )}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-brand-text/60">
                {fmtDate(c.clubStartDate)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-right">
                {money(c.clubTotal)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-right text-brand-text/60">
                {money(c.weeklyAmount)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-right text-brand-text/60">
                {money(0)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-center text-brand-text/70">
                10
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-center text-brand-text/70">
                10
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <span className="pace-badge inline-block bg-emerald-100 text-emerald-700 font-semibold text-[11px] px-2 py-0.5 rounded">
                  Completed payment
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── New-club table ─────────────────────────────────────────────
//
// New clubs show only captain, account number, phone, and the negative
// balance — the start/total/weekly fields in the CSV still reflect the
// *previous* cycle and would be misleading to display.

function NewClubTable({ captains }: { captains: ShoeClubCaptain[] }) {
  return (
    <div className="club-card bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
      <table className="w-full text-sm font-body min-w-[480px]">
        <thead>
          <tr className="border-b border-brand-cream-dark text-left text-brand-text/50 text-xs">
            <th className="px-3 py-2 font-normal">Captain</th>
            <th className="px-3 py-2 font-normal">Account</th>
            <th className="px-3 py-2 font-normal">Phone</th>
            <th className="px-3 py-2 font-normal text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {captains.map((c) => (
            <tr
              key={c.accountNumber}
              className="border-b border-brand-cream last:border-0"
            >
              <td className="px-3 py-1.5 whitespace-nowrap font-medium">
                {displayName(c)}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs text-brand-text/60">
                {c.accountNumber}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-brand-text/70 font-mono text-xs">
                {c.phoneNumber || (
                  <span className="text-brand-text/30">—</span>
                )}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-right text-sky-700 font-semibold">
                {money(c.currentBalance)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Status badge ───────────────────────────────────────────────
//
// Three tiers:
//   - Overdue (cycle past week 10, balance still positive) — red, with an
//     "OVERDUE — cycle ended" banner *in addition to* the weeks-behind count.
//   - Behind (weeksBehind < 0) — amber.
//   - Ahead or on pace (weeksBehind >= 0) — green.
// ────────────────────────────────────────────────────────────────

function StatusBadge({ captain: c }: { captain: ShoeClubCaptain }) {
  const label = paceLabel(c);
  if (c.isOverdue) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="pace-badge overdue inline-flex items-center gap-1 bg-red-600 text-white font-bold text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded w-fit">
          <AlertTriangle className="w-3 h-3" />
          Overdue — cycle ended
        </span>
        <span className="pace-badge text-red-700 font-semibold text-xs">
          {label}
        </span>
      </div>
    );
  }
  if (c.weeksBehind < 0) {
    return (
      <span className="pace-badge inline-block bg-amber-100 text-amber-800 font-semibold text-[11px] px-2 py-0.5 rounded">
        {label}
      </span>
    );
  }
  // Ahead or on pace.
  return (
    <span className="pace-badge inline-block bg-emerald-100 text-emerald-700 font-semibold text-[11px] px-2 py-0.5 rounded">
      {label}
    </span>
  );
}
