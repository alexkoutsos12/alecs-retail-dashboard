"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  DragEvent,
  ChangeEvent,
} from "react";
import Link from "next/link";
import { Upload, CheckCircle, AlertCircle, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { db, storage } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import toast from "react-hot-toast";
import {
  ref as storageRef,
  uploadBytes,
  deleteObject,
} from "firebase/storage";
import {
  parseSalesJournal,
  Transaction,
} from "@/lib/parsers/parseSalesJournal";

type ImportState = "idle" | "parsing" | "uploading" | "success" | "error";

interface ReportDoc {
  id: string;
  filename: string;
  dateRange: { start: string; end: string };
  totalTransactions: number;
  totalOutletItems: number;
  totalPerkItems: number;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: { toDate: () => Date } | null;
  storagePath: string;
}

interface SuccessData {
  filename: string;
  dateRange: { start: string; end: string };
  totalTransactions: number;
  totalOutletItems: number;
  totalPerkItems: number;
  uniquePerkAmounts: number[];
  breakdown: {
    regularSales: number;
    returns: number;
    specialOrders: number;
  };
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const [year, month, day] = dateStr.split("-");
  return `${month}/${day}/${year}`;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-sm font-body py-1 border-b border-brand-cream last:border-0">
      <span className="text-brand-text/50 w-56 shrink-0">{label}</span>
      <span className="text-brand-text">{value}</span>
    </div>
  );
}

export default function ImportPage() {
  const { user, userData } = useAuth();
  const isAdmin = userData?.role === "admin";

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importState, setImportState] = useState<ImportState>("idle");
  const [parseProgress, setParseProgress] = useState({ current: 0, total: 0 });
  const [successData, setSuccessData] = useState<SuccessData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const [overlapDialog, setOverlapDialog] = useState<{
    overlapping: ReportDoc[];
    dateRange: { start: string; end: string };
    onConfirm: () => void;
  } | null>(null);

  const [deleteDialog, setDeleteDialog] = useState<ReportDoc | null>(null);

  const [recentImports, setRecentImports] = useState<ReportDoc[]>([]);
  const [loadingImports, setLoadingImports] = useState(true);

  const fetchRecentImports = useCallback(async () => {
    setLoadingImports(true);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", "perk-tracker"),
        orderBy("uploadedAt", "desc"),
        limit(10)
      );
      const snap = await getDocs(q);
      setRecentImports(
        snap.docs.map((d) => ({ id: d.id, ...d.data() } as ReportDoc))
      );
    } catch {
      // Firestore may have no data yet
    } finally {
      setLoadingImports(false);
    }
  }, []);

  useEffect(() => {
    fetchRecentImports();
  }, [fetchRecentImports]);

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".xlsx")) return;
    setSelectedFile(file);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  useEffect(() => {
    document.title = "Import · Perk Tracker";
  }, []);

  const reset = () => {
    setImportState("idle");
    setSelectedFile(null);
    setSuccessData(null);
    setErrorMessage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImport = async () => {
    if (!selectedFile || !user) return;

    setImportState("parsing");
    setParseProgress({ current: 0, total: 0 });

    try {
      const buffer = await selectedFile.arrayBuffer();

      // Reserve a Firestore doc ID before parsing so transactions carry the right reportId
      const docRef = doc(collection(db, "reports"));
      const reportId = docRef.id;

      const transactions: Transaction[] = await parseSalesJournal(
        buffer,
        reportId,
        (current, total) => setParseProgress({ current, total })
      );

      if (transactions.length === 0) {
        throw new Error(
          "No transactions found in this file. Please check the file format."
        );
      }

      const dates = transactions
        .map((t) => t.date)
        .filter(Boolean)
        .sort();

      const dateRange = {
        start: dates[0] ?? "",
        end: dates[dates.length - 1] ?? "",
      };

      if (!dateRange.start || !dateRange.end) {
        throw new Error(
          "Could not determine date range. Check that the file has valid transaction dates."
        );
      }

      // Check for overlapping existing reports
      const allSnap = await getDocs(
        query(
          collection(db, "reports"),
          where("module", "==", "perk-tracker")
        )
      );

      const overlapping = allSnap.docs
        .map((d) => ({ id: d.id, ...d.data() } as ReportDoc))
        .filter(
          (r) =>
            r.dateRange?.start <= dateRange.end &&
            dateRange.start <= r.dateRange?.end
        );

      const doUpload = async () => {
        try {
          setImportState("uploading");

          // Remove overlapping reports
          for (const r of overlapping) {
            try {
              await deleteObject(storageRef(storage, r.storagePath));
            } catch {
              // File may not exist in Storage
            }
            await deleteDoc(doc(db, "reports", r.id));
          }

          // Upload transactions JSON
          const storagePath = `reports/${reportId}/transactions.json`;
          const jsonBlob = new Blob([JSON.stringify(transactions)], {
            type: "application/json",
          });
          await uploadBytes(storageRef(storage, storagePath), jsonBlob);

          // Compute summary stats
          const totalOutletItems = transactions.filter((t) => t.isOutlet).length;
          const totalPerkItems = transactions.filter(
            (t) => t.isPayablePerk
          ).length;
          const uniquePerkAmounts = [
            ...new Set(transactions.map((t) => t.perks).filter((p) => p > 0)),
          ].sort((a, b) => a - b);
          const regularSales = transactions.filter(
            (t) => t.transactionType === "Regular Sale"
          ).length;
          const returns = transactions.filter(
            (t) => t.transactionType === "Return"
          ).length;
          const specialOrders = transactions.filter(
            (t) => t.transactionType === "Special Order Pickup"
          ).length;

          // Write Firestore metadata
          await setDoc(docRef, {
            module: "perk-tracker",
            filename: selectedFile.name,
            dateRange,
            totalTransactions: transactions.length,
            totalOutletItems,
            totalPerkItems,
            uploadedBy: user.uid,
            uploadedByName:
              user.displayName || user.email || "Unknown",
            uploadedAt: serverTimestamp(),
            storagePath,
          });

          setSuccessData({
            filename: selectedFile.name,
            dateRange,
            totalTransactions: transactions.length,
            totalOutletItems,
            totalPerkItems,
            uniquePerkAmounts,
            breakdown: { regularSales, returns, specialOrders },
          });
          setImportState("success");
          toast.success("Report imported successfully.");
          fetchRecentImports();
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Upload failed. Please try again.";
          setErrorMessage(msg);
          setImportState("error");
          toast.error(msg);
        }
      };

      if (overlapping.length > 0) {
        setOverlapDialog({
          overlapping,
          dateRange,
          onConfirm: () => {
            setOverlapDialog(null);
            doUpload();
          },
        });
        setImportState("idle");
      } else {
        await doUpload();
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "An unexpected error occurred."
      );
      setImportState("error");
    }
  };

  const handleDelete = async (report: ReportDoc) => {
    try {
      try {
        await deleteObject(storageRef(storage, report.storagePath));
      } catch {
        // File may not exist
      }
      await deleteDoc(doc(db, "reports", report.id));
      setDeleteDialog(null);
      toast.success("Report deleted.");
      fetchRecentImports();
    } catch {
      toast.error("Failed to delete report.");
    }
  };

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Import — Perk Tracker
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-6">
        Upload a RICS Sales Journal (.xlsx)
      </p>

      {/* Overlap confirmation dialog */}
      {overlapDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-xl">
            <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
              Overlapping Import Detected
            </h2>
            <p className="font-body text-sm text-brand-text/70 mb-3">
              This file covers{" "}
              <strong>{formatDate(overlapDialog.dateRange.start)}</strong> to{" "}
              <strong>{formatDate(overlapDialog.dateRange.end)}</strong>. The
              following existing imports overlap this date range:
            </p>
            <ul className="mb-4 space-y-1">
              {overlapDialog.overlapping.map((r) => (
                <li
                  key={r.id}
                  className="font-body text-sm text-brand-text/80 pl-2"
                >
                  •{" "}
                  <span className="font-semibold">{r.filename}</span>{" "}
                  <span className="text-brand-text/50">
                    ({formatDate(r.dateRange.start)} –{" "}
                    {formatDate(r.dateRange.end)})
                  </span>
                </li>
              ))}
            </ul>
            <p className="font-body text-sm text-brand-text/70 mb-5">
              Importing will replace these. Continue?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setOverlapDialog(null);
                  setImportState("idle");
                }}
                className="px-4 py-2 rounded font-body text-sm text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={overlapDialog.onConfirm}
                className="px-4 py-2 rounded font-body text-sm bg-brand-green text-brand-cream hover:bg-brand-green-mid transition-colors"
              >
                Replace &amp; Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h2 className="font-heading text-brand-green text-lg font-bold mb-2">
              Delete Import
            </h2>
            <p className="font-body text-sm text-brand-text/70 mb-5">
              Delete <strong>{deleteDialog.filename}</strong>? This cannot be
              undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteDialog(null)}
                className="px-4 py-2 rounded font-body text-sm text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteDialog)}
                className="px-4 py-2 rounded font-body text-sm bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* IDLE — upload zone */}
      {importState === "idle" && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-6">
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
              isDragging
                ? "border-brand-green bg-brand-green/5"
                : "border-brand-cream-dark hover:border-brand-green/40"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={handleFileInput}
              className="hidden"
            />
            <Upload
              className={`w-8 h-8 mx-auto mb-3 ${
                isDragging ? "text-brand-green" : "text-brand-cream-dark"
              }`}
            />
            {selectedFile ? (
              <p className="font-body text-sm text-brand-text">
                <span className="font-semibold">{selectedFile.name}</span>
                <br />
                <span className="text-brand-text/40 text-xs mt-1 block">
                  Click to change file
                </span>
              </p>
            ) : (
              <p className="font-body text-sm text-brand-text/50">
                Drag &amp; drop your .xlsx file here, or click to browse
              </p>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleImport}
              disabled={!selectedFile}
              className="bg-brand-green text-brand-cream font-body text-sm px-5 py-2 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Import Report
            </button>
          </div>
        </div>
      )}

      {/* PARSING */}
      {importState === "parsing" && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-6">
          <p className="font-body text-sm text-brand-text/70 mb-3">
            Parsing... row {parseProgress.current} of {parseProgress.total}
          </p>
          <div className="w-full bg-brand-cream-dark rounded-full h-2">
            <div
              className="bg-brand-green h-2 rounded-full transition-all duration-150"
              style={{
                width:
                  parseProgress.total > 0
                    ? `${Math.min(
                        100,
                        Math.round(
                          (parseProgress.current / parseProgress.total) * 100
                        )
                      )}%`
                    : "2%",
              }}
            />
          </div>
        </div>
      )}

      {/* UPLOADING */}
      {importState === "uploading" && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-6">
          <p className="font-body text-sm text-brand-text/70 mb-3">
            Saving to cloud...
          </p>
          <div className="w-full bg-brand-cream-dark rounded-full h-2 overflow-hidden">
            <div className="bg-brand-green h-2 rounded-full w-2/3 animate-pulse" />
          </div>
        </div>
      )}

      {/* SUCCESS */}
      {importState === "success" && successData && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle className="w-5 h-5 text-brand-green shrink-0" />
            <h2 className="font-heading text-brand-green text-lg font-bold">
              Import Successful
            </h2>
          </div>
          <div className="mb-5">
            <SummaryRow label="File" value={successData.filename} />
            <SummaryRow
              label="Date Range"
              value={`${formatDate(successData.dateRange.start)} → ${formatDate(
                successData.dateRange.end
              )}`}
            />
            <SummaryRow
              label="Total Transactions"
              value={String(successData.totalTransactions)}
            />
            <SummaryRow
              label="Outlet Items Found (perks = $1)"
              value={String(successData.totalOutletItems)}
            />
            <SummaryRow
              label="Payable Perk Items Found (perks > $1)"
              value={String(successData.totalPerkItems)}
            />
            <SummaryRow
              label="Perk Amounts in This File"
              value={
                successData.uniquePerkAmounts.length > 0
                  ? successData.uniquePerkAmounts
                      .map((a) => `$${a}`)
                      .join(", ")
                  : "None"
              }
            />
            <SummaryRow
              label="Breakdown"
              value={`${successData.breakdown.regularSales} Regular Sales · ${successData.breakdown.returns} Returns · ${successData.breakdown.specialOrders} Special Orders`}
            />
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <Link
              href="/perk-tracker/outlet-sales"
              className="bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
            >
              View Outlet Sales →
            </Link>
            <Link
              href="/perk-tracker/perk-payout"
              className="bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
            >
              View Perk Payout →
            </Link>
            <button
              onClick={reset}
              className="ml-auto font-body text-sm text-brand-text/40 hover:text-brand-text/70 transition-colors"
            >
              Import Another
            </button>
          </div>
        </div>
      )}

      {/* ERROR */}
      {importState === "error" && (
        <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-6 mb-6">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            <h2 className="font-heading text-red-700 text-lg font-bold">
              Import Failed
            </h2>
          </div>
          <p className="font-body text-sm text-red-600 mb-4">{errorMessage}</p>
          <button
            onClick={reset}
            className="bg-red-600 text-white font-body text-sm px-4 py-2 rounded hover:bg-red-700 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Recent imports table */}
      <div>
        <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
          Recent Imports
        </h2>
        {loadingImports ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/40 font-body text-sm">Loading...</p>
          </div>
        ) : recentImports.length === 0 ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/40 font-body text-sm">
              No imports yet.
            </p>
          </div>
        ) : (
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
            <table className="w-full text-sm font-body min-w-[720px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Filename</th>
                  <th className="px-4 py-2 font-normal">Uploaded By</th>
                  <th className="px-4 py-2 font-normal">Date Range</th>
                  <th className="px-4 py-2 font-normal">Transactions</th>
                  <th className="px-4 py-2 font-normal">Outlet</th>
                  <th className="px-4 py-2 font-normal">Perks</th>
                  <th className="px-4 py-2 font-normal">Uploaded At</th>
                  <th className="px-4 py-2 font-normal w-8"></th>
                </tr>
              </thead>
              <tbody>
                {recentImports.map((row) => {
                  const canDelete =
                    isAdmin || row.uploadedBy === user?.uid;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-brand-cream last:border-0"
                    >
                      <td className="px-4 py-2 max-w-[180px] truncate">
                        {row.filename}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {row.uploadedByName}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {formatDate(row.dateRange?.start)} –{" "}
                        {formatDate(row.dateRange?.end)}
                      </td>
                      <td className="px-4 py-2">{row.totalTransactions}</td>
                      <td className="px-4 py-2">{row.totalOutletItems}</td>
                      <td className="px-4 py-2">{row.totalPerkItems}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {row.uploadedAt
                          ? row.uploadedAt.toDate().toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="px-4 py-2">
                        {canDelete && (
                          <button
                            onClick={() => setDeleteDialog(row)}
                            className="text-brand-text/30 hover:text-red-500 transition-colors"
                            title="Delete import"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
