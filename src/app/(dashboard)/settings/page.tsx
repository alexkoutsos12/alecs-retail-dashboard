"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { useAuth } from "@/lib/auth-context";
import { db, storage } from "@/lib/firebase";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
} from "firebase/firestore";
import { ref as storageRef, deleteObject } from "firebase/storage";
import { appModules } from "@/lib/modules";

interface UserDoc {
  uid: string;
  name: string;
  email: string;
  role: "admin" | "manager";
  createdAt: { toDate: () => Date } | null;
}

interface ReportDoc {
  id: string;
  module: string;
  filename: string;
  dateRange: { start: string; end: string };
  totalTransactions: number;
  totalOutletItems: number;
  totalPerkItems: number;
  uploadedByName: string;
  uploadedAt: { toDate: () => Date } | null;
  storagePath: string;
}

function fmt(d: string) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

function getModuleName(firestoreModule: string): string {
  return (
    appModules.find((m) => m.firestoreModule === firestoreModule)?.name ??
    firestoreModule
  );
}

function SkeletonTable({ rows }: { rows: number }) {
  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 flex items-center gap-4 px-4 border-b border-brand-cream last:border-0"
        >
          <div className="h-3 w-32 bg-brand-cream-dark rounded animate-pulse" />
          <div className="h-3 w-48 bg-brand-cream-dark rounded animate-pulse" />
          <div className="h-3 w-16 bg-brand-cream-dark rounded animate-pulse ml-auto" />
        </div>
      ))}
    </div>
  );
}

function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="bg-red-50 border-l-[3px] border-red-500 rounded p-5">
      <p className="font-body text-sm text-red-600 mb-3">{message}</p>
      <button
        onClick={onRetry}
        className="bg-red-600 text-white font-body text-sm px-4 py-1.5 rounded hover:bg-red-700 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { user, userData, loading: authLoading } = useAuth();

  const [users, setUsers] = useState<UserDoc[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [reports, setReports] = useState<ReportDoc[]>([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [reportsError, setReportsError] = useState<string | null>(null);

  const [allowedEmails, setAllowedEmails] = useState<string[]>([]);
  const [loadingEmails, setLoadingEmails] = useState(true);
  const [emailsError, setEmailsError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [removeEmailDialog, setRemoveEmailDialog] = useState<string | null>(
    null
  );

  const [deleteDialog, setDeleteDialog] = useState<ReportDoc | null>(null);

  useEffect(() => {
    document.title = "Settings · Alec's Dashboard";
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    setUsersError(null);
    try {
      const snap = await getDocs(collection(db, "users"));
      setUsers(
        snap.docs.map((d) => ({ uid: d.id, ...d.data() } as UserDoc))
      );
    } catch {
      setUsersError("Failed to load users.");
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const fetchReports = useCallback(async () => {
    setLoadingReports(true);
    setReportsError(null);
    try {
      const snap = await getDocs(
        query(collection(db, "reports"), orderBy("uploadedAt", "desc"))
      );
      setReports(
        snap.docs.map((d) => ({ id: d.id, ...d.data() } as ReportDoc))
      );
    } catch {
      setReportsError("Failed to load reports.");
    } finally {
      setLoadingReports(false);
    }
  }, []);

  const fetchAllowedEmails = useCallback(async () => {
    setLoadingEmails(true);
    setEmailsError(null);
    try {
      const snap = await getDocs(collection(db, "allowedEmails"));
      setAllowedEmails(snap.docs.map((d) => d.id).sort());
    } catch {
      setEmailsError("Failed to load allowed emails.");
    } finally {
      setLoadingEmails(false);
    }
  }, []);

  const handleAddEmail = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      toast.error("Please enter a valid email address.");
      return;
    }
    if (allowedEmails.includes(email)) {
      toast.error("Email already in the list.");
      return;
    }
    try {
      await setDoc(doc(db, "allowedEmails", email), {
        addedBy: user?.email || "",
        addedAt: new Date().toISOString(),
      });
      setAllowedEmails((prev) => [...prev, email].sort());
      setNewEmail("");
      toast.success("Email added.");
    } catch {
      toast.error("Failed to add email.");
    }
  };

  const handleRemoveEmail = async (email: string) => {
    try {
      await deleteDoc(doc(db, "allowedEmails", email));
      setAllowedEmails((prev) => prev.filter((e) => e !== email));
      setRemoveEmailDialog(null);
      toast.success("Email removed.");
    } catch {
      toast.error("Failed to remove email.");
    }
  };

  useEffect(() => {
    if (userData?.role === "admin") {
      fetchUsers();
      fetchReports();
      fetchAllowedEmails();
    }
  }, [userData?.role, fetchUsers, fetchReports, fetchAllowedEmails]);

  const handleRoleChange = async (
    uid: string,
    newRole: "admin" | "manager"
  ) => {
    try {
      await updateDoc(doc(db, "users", uid), { role: newRole });
      setUsers((prev) =>
        prev.map((u) => (u.uid === uid ? { ...u, role: newRole } : u))
      );
      toast.success("Role updated.");
    } catch {
      toast.error("Failed to update role.");
    }
  };

  const handleDeleteReport = async (report: ReportDoc) => {
    try {
      try {
        await deleteObject(storageRef(storage, report.storagePath));
      } catch {
        // file may not exist in Storage
      }
      await deleteDoc(doc(db, "reports", report.id));
      setReports((prev) => prev.filter((r) => r.id !== report.id));
      toast.success("Report deleted.");
      setDeleteDialog(null);
    } catch {
      toast.error("Failed to delete report.");
    }
  };

  // Auth loading
  if (authLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-40 bg-brand-cream-dark rounded animate-pulse" />
        <div className="h-48 bg-brand-cream-dark rounded animate-pulse" />
      </div>
    );
  }

  // Access denied
  if (userData?.role !== "admin") {
    return (
      <div>
        <h1 className="font-heading text-brand-green text-2xl font-bold mb-4">
          Access Denied
        </h1>
        <div className="bg-white border-l-[3px] border-brand-green rounded p-8 text-center">
          <p className="font-body text-brand-text/60 text-sm mb-4">
            This page is for administrators only.
          </p>
          <Link
            href="/"
            className="font-body text-sm text-brand-green hover:underline"
          >
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Remove email confirmation dialog */}
      {removeEmailDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h2 className="font-heading text-brand-green text-lg font-bold mb-2">
              Remove Email
            </h2>
            <p className="font-body text-sm text-brand-text/70 mb-5">
              Remove <strong>{removeEmailDialog}</strong> from the allowed list?
              They won&apos;t be able to log in unless re-added.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setRemoveEmailDialog(null)}
                className="px-4 py-2 rounded font-body text-sm text-brand-text/70 border border-brand-cream-dark hover:bg-brand-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemoveEmail(removeEmailDialog)}
                className="px-4 py-2 rounded font-body text-sm bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Remove
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
              Delete Report
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
                onClick={() => handleDeleteReport(deleteDialog)}
                className="px-4 py-2 rounded font-body text-sm bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
        Settings
      </h1>

      {/* Section 1 — User Management */}
      <section className="mb-10">
        <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
          User Management
        </h2>
        {loadingUsers ? (
          <SkeletonTable rows={3} />
        ) : usersError ? (
          <ErrorCard message={usersError} onRetry={fetchUsers} />
        ) : (
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
            <table className="w-full text-sm font-body min-w-[480px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Name</th>
                  <th className="px-4 py-2 font-normal">Email</th>
                  <th className="px-4 py-2 font-normal">Role</th>
                  <th className="px-4 py-2 font-normal">Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-6 text-center text-brand-text/40 text-sm"
                    >
                      No users found.
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr
                      key={u.uid}
                      className="border-b border-brand-cream last:border-0"
                    >
                      <td className="px-4 py-2">{u.name || "—"}</td>
                      <td className="px-4 py-2 text-brand-text/70">
                        {u.email}
                      </td>
                      <td className="px-4 py-2">
                        {u.uid === user?.uid ? (
                          <span className="font-body text-sm">
                            {u.role}
                            <span className="text-brand-text/40 ml-1.5 text-xs">
                              (you)
                            </span>
                          </span>
                        ) : (
                          <select
                            value={u.role}
                            onChange={(e) =>
                              handleRoleChange(
                                u.uid,
                                e.target.value as "admin" | "manager"
                              )
                            }
                            className="font-body text-sm border border-brand-cream-dark rounded px-2 py-0.5 bg-white focus:outline-none focus:border-brand-green"
                          >
                            <option value="admin">admin</option>
                            <option value="manager">manager</option>
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-2 text-brand-text/60">
                        {u.createdAt
                          ? u.createdAt.toDate().toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 2 — Allowed Emails */}
      <section className="mb-10">
        <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
          Allowed Emails
        </h2>
        <p className="font-body text-sm text-brand-text/50 mb-3">
          Only Google accounts matching these emails can log in. Existing users
          are always allowed regardless of this list.
        </p>

        {/* Add email input */}
        <div className="flex gap-2 mb-4">
          <input
            type="email"
            placeholder="new-user@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddEmail()}
            className="flex-1 font-body text-sm border border-brand-cream-dark rounded px-3 py-2 bg-white focus:outline-none focus:border-brand-green"
          />
          <button
            onClick={handleAddEmail}
            className="bg-brand-green text-brand-cream font-body text-sm px-4 py-2 rounded hover:bg-brand-green-mid transition-colors whitespace-nowrap"
          >
            Add Email
          </button>
        </div>

        {loadingEmails ? (
          <SkeletonTable rows={3} />
        ) : emailsError ? (
          <ErrorCard message={emailsError} onRetry={fetchAllowedEmails} />
        ) : allowedEmails.length === 0 ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/40 font-body text-sm">
              No allowed emails yet. Add one above to let new users log in.
            </p>
          </div>
        ) : (
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden">
            {allowedEmails.map((email) => (
              <div
                key={email}
                className="flex items-center justify-between px-4 py-2.5 border-b border-brand-cream last:border-0"
              >
                <span className="font-body text-sm text-brand-text/70">
                  {email}
                </span>
                <button
                  onClick={() => setRemoveEmailDialog(email)}
                  className="text-brand-text/30 hover:text-red-500 transition-colors"
                  title="Remove email"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 3 — Reports Management */}
      <section>
        <h2 className="font-heading text-brand-green text-lg font-bold mb-3">
          Reports Management
        </h2>
        {loadingReports ? (
          <SkeletonTable rows={5} />
        ) : reportsError ? (
          <ErrorCard message={reportsError} onRetry={fetchReports} />
        ) : reports.length === 0 ? (
          <div className="bg-white border-l-[3px] border-brand-green rounded p-6 text-center">
            <p className="text-brand-text/40 font-body text-sm">
              No reports yet.
            </p>
          </div>
        ) : (
          <div className="bg-white border-l-[3px] border-brand-green rounded overflow-hidden overflow-x-auto">
            <table className="w-full text-sm font-body min-w-[860px]">
              <thead>
                <tr className="border-b border-brand-cream-dark text-left text-brand-text/50">
                  <th className="px-4 py-2 font-normal">Module</th>
                  <th className="px-4 py-2 font-normal">Filename</th>
                  <th className="px-4 py-2 font-normal">Date Range</th>
                  <th className="px-4 py-2 font-normal">Transactions</th>
                  <th className="px-4 py-2 font-normal">Outlet</th>
                  <th className="px-4 py-2 font-normal">Perks</th>
                  <th className="px-4 py-2 font-normal">Uploaded By</th>
                  <th className="px-4 py-2 font-normal">Uploaded At</th>
                  <th className="px-4 py-2 font-normal w-8" />
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-brand-cream last:border-0"
                  >
                    <td className="px-4 py-2">
                      {getModuleName(r.module)}
                    </td>
                    <td className="px-4 py-2 max-w-[160px] truncate">
                      {r.filename}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {fmt(r.dateRange?.start)} – {fmt(r.dateRange?.end)}
                    </td>
                    <td className="px-4 py-2">{r.totalTransactions}</td>
                    <td className="px-4 py-2">{r.totalOutletItems}</td>
                    <td className="px-4 py-2">{r.totalPerkItems}</td>
                    <td className="px-4 py-2">{r.uploadedByName}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.uploadedAt
                        ? r.uploadedAt.toDate().toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => setDeleteDialog(r)}
                        className="text-brand-text/30 hover:text-red-500 transition-colors"
                        title="Delete report"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
