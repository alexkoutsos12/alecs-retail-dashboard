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
import { parseNikeOnOrder, OnOrderSku } from "@/lib/parsers/parseNikeOnOrder";

const MODULE = "nike-planner";
const KIND = "on-order";

type ImportState = "idle" | "parsing" | "success" | "error";

interface ReportDoc {
  id: string;
  filename: string;
  totalSkus: number;
  totalOnOrder: number;
  poCount: number;
  uploadedByName: string;
  uploadedAt: { toDate: () => Date } | null;
  storagePath: string;
}

export default function OnOrderImportPage() {
  const { user, userData } = useAuth();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importState, setImportState] = useState<ImportState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [success, setSuccess] = useState<{
    totalSkus: number;
    totalOnOrder: number;
    poCount: number;
  } | null>(null);

  const [deleteDialog, setDeleteDialog] = useState<ReportDoc | null>(null);
  const [recent, setRecent] = useState<ReportDoc[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(true);

  const fetchRecent = useCallback(async () => {
    setLoadingRecent(true);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", MODULE),
        orderBy("uploadedAt", "desc"),
        limit(40)
      );
      const snap = await getDocs(q);
      setRecent(
        snap.docs
          .map((d) => ({ id: d.id, kind: d.data().kind, ...d.data() } as ReportDoc & { kind?: string }))
          .filter((r) => (r as { kind?: string }).kind === KIND)
          .slice(0, 10)
      );
    } catch (err) {
      console.error("fetchRecent error:", err);
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent]);
  useEffect(() => {
    document.title = "Import On-Order · Nike Planner";
  }, []);

  const handleFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) return;
    setSelectedFile(file);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };
  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };
  const reset = () => {
    setImportState("idle");
    setSelectedFile(null);
    setSuccess(null);
    setErrorMessage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImport = async () => {
    if (!selectedFile || !user) return;
    setImportState("parsing");
    try {
      const buffer = await selectedFile.arrayBuffer();
      const docRef = doc(collection(db, "reports"));
      const skus: OnOrderSku[] = await parseNikeOnOrder(buffer);
      if (skus.length === 0)
        throw new Error(
          "No on-order rows found. Make sure this is a RICS Purchase Order / on-order CSV export."
        );
      const totalOnOrder = skus.reduce((s, k) => s + k.onOrder, 0);
      const poSet = new Set<string>();
      for (const k of skus) for (const p of k.pos) poSet.add(p.poNumber);

      const storagePath = `reports/${docRef.id}/nike-on-order.json`;
      await uploadBytes(
        storageRef(storage, storagePath),
        new Blob([JSON.stringify(skus)], { type: "application/json" })
      );
      await setDoc(docRef, {
        module: MODULE,
        kind: KIND,
        filename: selectedFile.name,
        totalSkus: skus.length,
        totalOnOrder,
        poCount: poSet.size,
        uploadedBy: user.uid,
        uploadedByName: user.displayName || user.email || "Unknown",
        uploadedAt: serverTimestamp(),
        storagePath,
      });
      setSuccess({ totalSkus: skus.length, totalOnOrder, poCount: poSet.size });
      setImportState("success");
      toast.success("On-order report imported.");
      fetchRecent();
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
        // may not exist
      }
      await deleteDoc(doc(db, "reports", report.id));
      setDeleteDialog(null);
      toast.success("Import deleted.");
      fetchRecent();
    } catch {
      toast.error("Failed to delete import.");
    }
  };

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Import — On-Order
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-6">
        Upload a RICS Purchase Order / on-order export (.csv). It merges into the
        Planner by SKU.
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
            Open the <strong>Purchase Orders</strong> report.
          </li>
          <li>
            Change the format to <strong>CSV</strong>.
          </li>
          <li>
            Choose <strong>On Order at Once</strong> and{" "}
            <strong>On Order Future</strong>.
          </li>
          <li>
            Select <strong>NIKE</strong> as the supplier.
          </li>
          <li>
            Under <strong>By Class</strong>, select all kids shoes.
          </li>
          <li>
            Select <strong>Open POs only</strong>.
          </li>
        </ol>
      </div>

      {deleteDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h2 className="font-heading text-brand-green text-lg font-bold mb-2">
              Delete Import
            </h2>
            <p className="font-body text-sm text-brand-text/70 mb-5">
              Delete <strong>{deleteDialog.filename}</strong>?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteDialog(null)}
                className="px-4 py-2 rounded font-body text-sm text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteDialog)}
                className="px-4 py-2 rounded font-body text-sm bg-red-600 text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {importState === "idle" && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-6">
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={onDrop}
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
              onChange={onInput}
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
                <span className="text-brand-text/40 text-xs mt-1 block">
                  Click to change file
                </span>
              </p>
            ) : (
              <p className="font-body text-sm text-brand-text/50">
                Drag &amp; drop the on-order (.csv) here, or click to browse
              </p>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleImport}
              disabled={!selectedFile}
              className="bg-brand-green text-brand-cream font-body text-sm px-5 py-2 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40"
            >
              Import
            </button>
          </div>
        </div>
      )}

      {importState === "parsing" && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-6">
          <p className="font-body text-sm text-brand-text/70">Parsing &amp; saving…</p>
        </div>
      )}

      {importState === "success" && success && (
        <div className="bg-white border-l-[3px] border-brand-green rounded p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle className="w-5 h-5 text-brand-green shrink-0" />
            <h2 className="font-heading text-brand-green text-lg font-bold">
              Import Successful
            </h2>
          </div>
          <p className="font-body text-sm text-brand-text/70 mb-4">
            {success.totalSkus} SKUs · {success.totalOnOrder.toLocaleString()}{" "}
            pairs on order · {success.poCount} purchase orders.
          </p>
          <div className="flex gap-3 items-center">
            <Link
              href="/nike-planner/planner"
              className="bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid"
            >
              Open Planner →
            </Link>
            <button
              onClick={reset}
              className="ml-auto font-body text-sm text-brand-text/40 hover:text-brand-text/70"
            >
              Import Another
            </button>
          </div>
        </div>
      )}

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
            className="bg-red-600 text-white font-body text-sm px-4 py-2 rounded hover:bg-red-700"
          >
            Try Again
          </button>
        </div>
      )}

      <div>
        <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
          Recent On-Order Imports
        </h2>
        {loadingRecent ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center text-brand-text/40 font-body text-sm">
            Loading...
          </div>
        ) : recent.length === 0 ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center text-brand-text/40 font-body text-sm">
            No on-order imports yet.
          </div>
        ) : (
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
            <table className="w-full text-sm font-body min-w-[640px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Filename</th>
                  <th className="px-4 py-2 font-normal">SKUs</th>
                  <th className="px-4 py-2 font-normal">Pairs</th>
                  <th className="px-4 py-2 font-normal">POs</th>
                  <th className="px-4 py-2 font-normal">Uploaded</th>
                  <th className="px-4 py-2 font-normal w-8"></th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-brand-cream last:border-0"
                  >
                    <td className="px-4 py-2 max-w-[180px] truncate">
                      {row.filename}
                    </td>
                    <td className="px-4 py-2">{row.totalSkus}</td>
                    <td className="px-4 py-2">{row.totalOnOrder}</td>
                    <td className="px-4 py-2">{row.poCount}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {row.uploadedAt
                        ? row.uploadedAt.toDate().toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-2">
                      {canDeleteReport(userData, MODULE) && (
                        <button
                          onClick={() => setDeleteDialog(row)}
                          className="text-brand-text/30 hover:text-red-500"
                          title="Delete import"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
