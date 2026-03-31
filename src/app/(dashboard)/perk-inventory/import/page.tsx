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
import { Upload, CheckCircle, AlertCircle, AlertTriangle } from "lucide-react";
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
import { parseStockStatus, SkuItem } from "@/lib/parsers/parseStockStatus";

type ImportState = "idle" | "parsing" | "uploading" | "success" | "error";

interface ReportDoc {
  id: string;
  filename: string;
  importDate: string;
  totalSkus: number;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: { toDate: () => Date } | null;
  storagePath: string;
}

interface SuccessData {
  filename: string;
  importDate: string;
  totalSkus: number;
  perkBreakdown: string;
  genderBreakdown: string;
  excludedDollarOneSkus: string[];
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

export default function PerkInventoryImportPage() {
  const { user } = useAuth();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importState, setImportState] = useState<ImportState>("idle");
  const [parseProgress, setParseProgress] = useState({ current: 0, total: 0 });
  const [successData, setSuccessData] = useState<SuccessData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const [currentImport, setCurrentImport] = useState<ReportDoc | null>(null);
  const [loadingImport, setLoadingImport] = useState(true);

  const fetchCurrentImport = useCallback(async () => {
    setLoadingImport(true);
    try {
      const q = query(
        collection(db, "reports"),
        where("module", "==", "perk-inventory"),
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
    document.title = "Import · Perk Inventory";
  }, []);

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

      const result = parseStockStatus(buffer, reportId, (current, total) =>
        setParseProgress({ current, total })
      );

      const { skus, importDate, excludedDollarOneSkus } = result;

      if (skus.length === 0) {
        throw new Error(
          "No perk SKUs found in this file. Make sure the file is a RICS Stock Status report with perk values."
        );
      }

      setImportState("uploading");

      // Delete previous import if one exists
      if (currentImport) {
        try {
          await deleteObject(
            storageRef(storage, currentImport.storagePath)
          );
        } catch {
          // File may not exist in Storage
        }
        await deleteDoc(doc(db, "reports", currentImport.id));
      }

      // Upload SKUs JSON to Firebase Storage
      const storagePath = `reports/${reportId}/skus.json`;
      const jsonBlob = new Blob([JSON.stringify(skus)], {
        type: "application/json",
      });
      await uploadBytes(storageRef(storage, storagePath), jsonBlob);

      // Compute summary stats
      const perkCounts: Record<number, number> = {};
      const genderCounts = { mens: 0, womens: 0, childrens: 0 };
      const uniquePerkAmounts: number[] = [];

      for (const sku of skus) {
        perkCounts[sku.perk] = (perkCounts[sku.perk] || 0) + 1;
        if (sku.gender === "Men's") genderCounts.mens++;
        else if (sku.gender === "Women's") genderCounts.womens++;
        else if (sku.gender === "Children's") genderCounts.childrens++;
      }

      const perkBreakdown = Object.entries(perkCounts)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([amt, count]) => `${count}\u00D7 $${amt}`)
        .join(", ");

      const genderParts: string[] = [];
      if (genderCounts.mens > 0) genderParts.push(`${genderCounts.mens} Men's`);
      if (genderCounts.womens > 0)
        genderParts.push(`${genderCounts.womens} Women's`);
      if (genderCounts.childrens > 0)
        genderParts.push(`${genderCounts.childrens} Children's`);
      const genderBreakdown = genderParts.join(" \u00B7 ");

      for (const amt of Object.keys(perkCounts)) {
        uniquePerkAmounts.push(Number(amt));
      }
      uniquePerkAmounts.sort((a, b) => a - b);

      // Write Firestore metadata
      await setDoc(docRef, {
        module: "perk-inventory",
        filename: selectedFile.name,
        importDate,
        uploadedAt: serverTimestamp(),
        uploadedBy: user.uid,
        uploadedByName: user.displayName || user.email || "Unknown",
        totalSkus: skus.length,
        storagePath,
        genderBreakdown: genderCounts,
        uniquePerkAmounts,
      });

      setSuccessData({
        filename: selectedFile.name,
        importDate,
        totalSkus: skus.length,
        perkBreakdown,
        genderBreakdown,
        excludedDollarOneSkus,
      });
      setImportState("success");
      toast.success("Perk inventory imported successfully.");
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
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Import — Perk Inventory
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-6">
        Upload a RICS Stock Status report (.xlsx)
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
                Drag &amp; drop your RICS Stock Status (.xlsx) here, or click to
                browse
              </p>
            )}
          </div>

          {/* RICS setup instructions */}
          <div className="mt-4 mb-4 bg-brand-cream/60 rounded p-4">
            <p className="font-body text-xs font-semibold text-brand-text/60 mb-2">
              RICS Report Setup
            </p>
            <p className="font-body text-xs text-brand-text/50 mb-1">
              Run a <strong>Stock Status</strong> report with these options:
            </p>
            <ul className="font-body text-xs text-brand-text/50 list-disc pl-5 space-y-0.5">
              <li>
                <strong>Pricing:</strong> Include Only SKUs With Perks (as of
                today)
              </li>
              <li>
                <strong>Custom Entries:</strong> Exclude keyword{" "}
                <span className="font-mono bg-white/60 px-1 rounded">
                  OUTLET
                </span>
              </li>
              <li>
                <strong>Also Print:</strong> Perks
              </li>
            </ul>
          </div>

          <div className="flex justify-end">
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
            Parsing... SKU {parseProgress.current} of {parseProgress.total}
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
              label="Import Date"
              value={formatDate(successData.importDate)}
            />
            <SummaryRow
              label="Total Active Perk SKUs"
              value={String(successData.totalSkus)}
            />
            <SummaryRow label="Perk Amounts" value={successData.perkBreakdown} />
            <SummaryRow
              label="Gender Breakdown"
              value={successData.genderBreakdown}
            />
          </div>

          {/* $1 perk warning */}
          {successData.excludedDollarOneSkus.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-5">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <p className="font-body text-sm text-amber-700 font-medium">
                  Warning: {successData.excludedDollarOneSkus.length} SKU(s)
                  excluded — $1 outlet perk
                </p>
              </div>
              <p className="font-body text-xs text-amber-600">
                This may indicate a RICS data entry error:{" "}
                {successData.excludedDollarOneSkus.join(", ")}
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-3 items-center">
            <Link
              href="/perk-inventory/active-incentives"
              className="bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
            >
              View Active Incentives →
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
            <table className="w-full text-sm font-body min-w-[480px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Filename</th>
                  <th className="px-4 py-2 font-normal">Import Date</th>
                  <th className="px-4 py-2 font-normal">SKUs</th>
                  <th className="px-4 py-2 font-normal">Uploaded By</th>
                  <th className="px-4 py-2 font-normal">Uploaded At</th>
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
                  <td className="px-4 py-2">{currentImport.totalSkus}</td>
                  <td className="px-4 py-2">{currentImport.uploadedByName}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {currentImport.uploadedAt
                      ? currentImport.uploadedAt.toDate().toLocaleDateString()
                      : "\u2014"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/40 font-body text-sm">
              No perk inventory imported yet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
