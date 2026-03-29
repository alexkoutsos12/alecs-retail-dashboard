"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Sidebar from "./sidebar";
import { useEffect } from "react";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-brand-cream">
        <p className="text-brand-text/50 font-body">Loading...</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="ml-[200px] flex-1 overflow-y-auto p-6 bg-brand-cream">
        {children}
      </main>
    </div>
  );
}
