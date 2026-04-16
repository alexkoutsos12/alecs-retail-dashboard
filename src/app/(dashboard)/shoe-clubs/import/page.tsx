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
import { parseShoeClubs } from "@/lib/parsers/shoeClubsParser";

type ImportState = "idle" | "parsing" | "uploading" | "success" | "error";

interface ReportDoc {
  id: string;
  filename: string;
  importDate: string;
  totalCaptains: number;
  outstandingCount: number;
  completedCount: number;
  newClubCount: number;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: { toDate: () => Date } | null;
  storagePath: string;
}

interface SuccessData {
  filename: string;
  importDate: string;
  totalCaptains: number;
  outstandingCount: number;
  completedCount: number;
  newClubCount: number;
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

export default function ShoeClubsImportPage() {
  const { user } = useAuth();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importState, setImportState] = useState<ImportState>("idle");
  const [successData, setSuccessData] = useState<SuccessData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const [currentImport, setCurrentImport] = useState<ReportDoc | null>(null);
  const [loadingImport, setLoadingImport] = useState(true);
  const [deleteDialog, setDeleteDialog] = useState(false);

  const fetchCurrentImport = useCallback(async () => {
    setLoadingImport(true);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", "shoe-clubs"),
        orderBy("uploadedAt", "desc"),
        limit(1)
      );
      const snap = await getDocs(q);
      if (snap.docs.length > 0) {
        setCurrentImport({
          id: snap.docs[0].id,
          ...snap.docs[0].data(),
        } as ReportDoc);
      } else {
        setCurrentImport(null);
      }
    } catch (err) {
      console.error("fetchCurrentImport error:", err);
    } finally {
      setLoadingImport(false);
    }
  }, []);

  useEffect(() => {
    fetchCurrentImport();
  }, [fetchCurrentImport]);

  useEffect(() => {
    document.title = "Import · Shoe Clubs";
  }, []);

  const handleDelete = async () => {
    if (!currentImport) return;
    try {
      try {
        await deleteObject(storageRef(storage, currentImport.storagePath));
      } catch {
        // File may not exist in Storage
      }
      await deleteDoc(doc(db, "reports", currentImport.id));
      setDeleteDialog(false);
      toast.success("Import deleted.");
      fetchCurrentImport();
    } catch {
      toast.error("Failed to delete import.");
    }
  };

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

    try {
      const csvContent = await selectedFile.text();
      const docRef = doc(collection(db, "reports"));
      const reportId = docRef.id;

      const result = parseShoeClubs(csvContent);
      const { captains, importDate, counts } = result;

      if (captains.length === 0) {
        throw new Error(
          "No captains found in this file. Make sure the file is a RICS Captains List CSV export."
        );
      }

      setImportState("uploading");

      // Replace previous import if one exists
      if (currentImport) {
        try {
          await deleteObject(storageRef(storage, currentImport.storagePath));
        } catch {
          // File may not exist in Storage
        }
        await deleteDoc(doc(db, "reports", currentImport.id));
      }

      // Upload captains JSON to Firebase Storage
      const storagePath = `reports/${reportId}/shoe-clubs.json`;
      const jsonBlob = new Blob([JSON.stringify(captains)], {
        type: "application/json",
      });
      await uploadBytes(storageRef(storage, storagePath), jsonBlob);

      // Write Firestore metadata
      await setDoc(docRef, {
        module: "shoe-clubs",
        filename: selectedFile.name,
        importDate,
        uploadedAt: serverTimestamp(),
        uploadedBy: user.uid,
        uploadedByName: user.displayName || user.email || "Unknown",
        totalCaptains: counts.total,
        outstandingCount: counts.outstanding,
        completedCount: counts.completed,
        newClubCount: counts.newClub,
        storagePath,
      });

      setSuccessData({
        filename: selectedFile.name,
        importDate,
        totalCaptains: counts.total,
        outstandingCount: counts.outstanding,
        completedCount: counts.completed,
        newClubCount: counts.newClub,
      });
      setImportState("success");
      toast.success("Captains list imported successfully.");
      fetchCurrentImport();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "An unexpected error occurred."
      );
      setImportState("error");
    }
  };

  return (
    <div>
      {/* Delete confirmation dialog */}
      {deleteDialog && currentImport && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h2 className="font-heading text-brand-green text-lg font-bold mb-2">
              Delete Import
            </h2>
            <p className="font-body text-sm text-brand-text/70 mb-5">
              Delete <strong>{currentImport.filename}</strong>? This will remove
              all captain data. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteDialog(false)}
                className="px-4 py-2 rounded font-body text-sm text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 rounded font-body text-sm bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Import — Shoe Clubs
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-6">
        Upload a RICS Captains List (.csv)
      </p>

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
                Drag &amp; drop your RICS Captains List (.csv) here, or click
                to browse
              </p>
            )}
          </div>

          <div className="flex justify-end mt-4">
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
            Parsing...
          </p>
          <div className="w-full bg-brand-cream-dark rounded-full h-2 overflow-hidden">
            <div className="bg-brand-green h-2 rounded-full w-1/2 animate-pulse" />
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
              label="Import Date"
              value={formatDate(successData.importDate)}
            />
            <SummaryRow
              label="Total Captains"
              value={String(successData.totalCaptains)}
            />
            <SummaryRow
              label="Outstanding Balance"
              value={String(successData.outstandingCount)}
            />
            <SummaryRow
              label="Completed Clubs"
              value={String(successData.completedCount)}
            />
            <SummaryRow
              label="New Clubs"
              value={String(successData.newClubCount)}
            />
          </div>

          <div className="flex flex-wrap gap-3 items-center">
            <Link
              href="/shoe-clubs/club-status"
              className="bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
            >
              View Club Status →
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

      {/* Current import info */}
      <div>
        <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
          Current Import
        </h2>
        {loadingImport ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/40 font-body text-sm">Loading...</p>
          </div>
        ) : currentImport ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
            <table className="w-full text-sm font-body min-w-[640px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Filename</th>
                  <th className="px-4 py-2 font-normal">Import Date</th>
                  <th className="px-4 py-2 font-normal">Captains</th>
                  <th className="px-4 py-2 font-normal">Outstanding</th>
                  <th className="px-4 py-2 font-normal">Completed</th>
                  <th className="px-4 py-2 font-normal">New</th>
                  <th className="px-4 py-2 font-normal">Uploaded By</th>
                  <th className="px-4 py-2 font-normal">Uploaded At</th>
                  <th className="px-4 py-2 font-normal w-8"></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="px-4 py-2 max-w-[180px] truncate">
                    {currentImport.filename}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {formatDate(currentImport.importDate)}
                  </td>
                  <td className="px-4 py-2">{currentImport.totalCaptains}</td>
                  <td className="px-4 py-2">
                    {currentImport.outstandingCount}
                  </td>
                  <td className="px-4 py-2">
                    {currentImport.completedCount}
                  </td>
                  <td className="px-4 py-2">{currentImport.newClubCount}</td>
                  <td className="px-4 py-2">{currentImport.uploadedByName}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {currentImport.uploadedAt
                      ? currentImport.uploadedAt.toDate().toLocaleDateString()
                      : "\u2014"}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => setDeleteDialog(true)}
                      className="text-brand-text/30 hover:text-red-500 transition-colors"
                      title="Delete import"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/40 font-body text-sm">
              No captains list imported yet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
