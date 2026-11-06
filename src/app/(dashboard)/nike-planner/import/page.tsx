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
import { Upload, CheckCircle, AlertCircle, Trash2, FileText } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { canDeleteReport } from "@/lib/permissions";
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
import { parseNikeStock, NikeSku } from "@/lib/parsers/parseNikeStock";

const MODULE = "nike-planner";
const DEFAULT_WINDOW = "Spring/Summer (Jan–Jun 2026)";

type ImportState = "idle" | "parsing" | "uploading" | "success" | "error";

interface ReportDoc {
  id: string;
  filename: string;
  salesWindow: string;
  totalSkus: number;
  totalOnHand: number;
  totalOnOrder: number;
  totalSold: number;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: { toDate: () => Date } | null;
  storagePath: string;
}

interface SuccessData {
  filename: string;
  salesWindow: string;
  totalSkus: number;
  totalOnHand: number;
  totalOnOrder: number;
  totalSold: number;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-sm font-body py-1 border-b border-brand-cream last:border-0">
      <span className="text-brand-text/50 w-56 shrink-0">{label}</span>
      <span className="text-brand-text">{value}</span>
    </div>
  );
}

export default function NikePlannerImportPage() {
  const { user, userData } = useAuth();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [salesWindow, setSalesWindow] = useState(DEFAULT_WINDOW);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importState, setImportState] = useState<ImportState>("idle");
  const [parseProgress, setParseProgress] = useState({ current: 0, total: 0 });
  const [successData, setSuccessData] = useState<SuccessData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const [deleteDialog, setDeleteDialog] = useState<ReportDoc | null>(null);
  const [recentImports, setRecentImports] = useState<ReportDoc[]>([]);
  const [loadingImports, setLoadingImports] = useState(true);

  const fetchRecentImports = useCallback(async () => {
    setLoadingImports(true);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", MODULE),
        orderBy("uploadedAt", "desc"),
        limit(40)
      );
      const snap = await getDocs(q);
      setRecentImports(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as ReportDoc & { kind?: string }))
          .filter((r) => (r as { kind?: string }).kind !== "on-order")
          .slice(0, 10)
      );
    } catch (err) {
      console.error("fetchRecentImports error:", err);
    } finally {
      setLoadingImports(false);
    }
  }, []);

  useEffect(() => {
    fetchRecentImports();
  }, [fetchRecentImports]);

  useEffect(() => {
    document.title = "Import · Nike Planner";
  }, []);

  const handleFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) return;
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
      const docRef = doc(collection(db, "reports"));
      const reportId = docRef.id;

      const skus: NikeSku[] = await parseNikeStock(buffer, (current, total) =>
        setParseProgress({ current, total })
      );

      if (skus.length === 0) {
        throw new Error(
          "No SKUs found. Make sure this is a RICS Stock Status CSV export (with size columns included)."
        );
      }

      setImportState("uploading");

      const totalOnHand = skus.reduce((s, k) => s + k.onHand, 0);
      const totalOnOrder = skus.reduce((s, k) => s + k.onOrder, 0);
      const totalSold = skus.reduce((s, k) => s + k.sold, 0);

      const storagePath = `reports/${reportId}/nike-stock.json`;
      const jsonBlob = new Blob([JSON.stringify(skus)], {
        type: "application/json",
      });
      await uploadBytes(storageRef(storage, storagePath), jsonBlob);

      await setDoc(docRef, {
        module: MODULE,
        kind: "stock",
        filename: selectedFile.name,
        salesWindow: salesWindow.trim() || DEFAULT_WINDOW,
        totalSkus: skus.length,
        totalOnHand,
        totalOnOrder,
        totalSold,
        uploadedBy: user.uid,
        uploadedByName: user.displayName || user.email || "Unknown",
        uploadedAt: serverTimestamp(),
        storagePath,
      });

      setSuccessData({
        filename: selectedFile.name,
        salesWindow: salesWindow.trim() || DEFAULT_WINDOW,
        totalSkus: skus.length,
        totalOnHand,
        totalOnOrder,
        totalSold,
      });
      setImportState("success");
      toast.success("Stock status imported successfully.");
      fetchRecentImports();
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
        // File may not exist in Storage
      }
      await deleteDoc(doc(db, "reports", report.id));
      setDeleteDialog(null);
      toast.success("Import deleted.");
      fetchRecentImports();
    } catch {
      toast.error("Failed to delete import.");
    }
  };

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Import — Nike Planner
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-6">
        Upload a RICS Stock Status export (.csv) for NIKE
      </p>

      {/* How to run the report */}
      <div className="bg-brand-cream/40 border border-brand-cream-dark rounded p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-brand-green shrink-0" />
          <h2 className="font-heading text-brand-green text-sm font-bold">
            How to run this report in RICS
          </h2>
        </div>
        <ol className="list-decimal pl-5 space-y-1.5 font-body text-sm text-brand-text/80">
          <li>
            Open the <strong>Stock Status</strong> report.
          </li>
          <li>
            Change the format to <strong>CSV</strong>.
          </li>
          <li>
            Under <strong>Report Criteria</strong>, select{" "}
            <strong>NIKE</strong> as the supplier, and under{" "}
            <strong>By Class</strong> select all kids shoes.
          </li>
          <li>Include or omit outlet stock — your choice.</li>
          <li>
            Under <strong>Printing Options</strong>, select{" "}
            <strong>On Hand</strong>, <strong>Costs</strong>, and{" "}
            <strong>Age</strong>.
          </li>
          <li>
            Optionally include <strong>Sell-Through</strong> data for a selected
            time frame (set the matching sales period below when you upload).
          </li>
        </ol>
      </div>

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

      {/* IDLE */}
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
              accept=".csv"
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
                Drag &amp; drop your Stock Status (.csv) here, or click to browse
              </p>
            )}
          </div>

          <label className="block mt-4">
            <span className="font-body text-xs text-brand-text/50">
              Sales period this export covers (the Sales column)
            </span>
            <input
              type="text"
              value={salesWindow}
              onChange={(e) => setSalesWindow(e.target.value)}
              className="mt-1 w-full max-w-sm border border-brand-cream-dark rounded px-2 py-1 text-sm bg-white text-brand-text focus:outline-none focus:border-brand-green"
            />
          </label>

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
            <SummaryRow label="Sales Period" value={successData.salesWindow} />
            <SummaryRow
              label="SKUs (colorways)"
              value={successData.totalSkus.toLocaleString()}
            />
            <SummaryRow
              label="Units On Hand"
              value={successData.totalOnHand.toLocaleString()}
            />
            <SummaryRow
              label="Units On Order"
              value={successData.totalOnOrder.toLocaleString()}
            />
            <SummaryRow
              label="Units Sold (period)"
              value={successData.totalSold.toLocaleString()}
            />
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <Link
              href="/nike-planner/planner"
              className="bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
            >
              Open Planner →
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

      {/* Recent imports */}
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
                  <th className="px-4 py-2 font-normal">Sales Period</th>
                  <th className="px-4 py-2 font-normal">SKUs</th>
                  <th className="px-4 py-2 font-normal">On Hand</th>
                  <th className="px-4 py-2 font-normal">Sold</th>
                  <th className="px-4 py-2 font-normal">Uploaded</th>
                  <th className="px-4 py-2 font-normal w-8"></th>
                </tr>
              </thead>
              <tbody>
                {recentImports.map((row) => {
                  const canDelete = canDeleteReport(userData, MODULE);
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-brand-cream last:border-0"
                    >
                      <td className="px-4 py-2 max-w-[180px] truncate">
                        {row.filename}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {row.salesWindow}
                      </td>
                      <td className="px-4 py-2">{row.totalSkus}</td>
                      <td className="px-4 py-2">{row.totalOnHand}</td>
                      <td className="px-4 py-2">{row.totalSold}</td>
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
