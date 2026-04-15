"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import Sidebar from "./sidebar";
import { Menu } from "lucide-react";
import { appModules } from "@/lib/modules";
import { canAccessModule, canAccessSettings } from "@/lib/permissions";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, userData, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  // Route guard — redirect users who land on a path their role doesn't
  // cover. Within a module a user either has full access (import, delete,
  // view) or no access; there's no "view-only within a module" tier.
  useEffect(() => {
    if (loading || !user || !userData || !pathname) return;

    // Home is always allowed.
    if (pathname === "/") return;

    // Settings has its own inline "Access Denied" UI, but we redirect
    // non-admins here so they don't even see the flash.
    if (pathname.startsWith("/settings")) {
      if (!canAccessSettings(userData)) router.replace("/");
      return;
    }

    // Find which module this path belongs to.
    const mod = appModules.find((m) =>
      pathname === `/${m.id}` || pathname.startsWith(`/${m.id}/`)
    );
    if (!mod) return;

    if (!canAccessModule(userData, mod.id)) {
      router.replace("/");
    }
  }, [pathname, userData, user, loading, router]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, []);

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
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 bg-brand-green flex items-center px-4 z-40 print:hidden">
        <button
          onClick={() => setMobileMenuOpen(true)}
          className="text-brand-cream p-1 -ml-1"
          aria-label="Open navigation menu"
        >
          <Menu size={22} />
        </button>
        <span className="font-heading text-brand-cream font-bold ml-3 text-base">
          Alec&apos;s Dashboard
        </span>
      </div>

      {/* Mobile backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <Sidebar
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
      />

      <main className="flex-1 overflow-y-auto bg-brand-cream md:ml-[200px] print:ml-0 print:overflow-visible">
        <div className="p-6 pt-20 md:pt-6 print:p-6 min-h-full flex flex-col">
          <div className="flex-1">{children}</div>
          <footer className="mt-12 pt-4 border-t border-brand-cream-dark font-body text-xs text-brand-text/30 text-center print:hidden">
            Alec&apos;s Shoes © 2026 · Internal Use Only
          </footer>
        </div>
      </main>
    </div>
  );
}
