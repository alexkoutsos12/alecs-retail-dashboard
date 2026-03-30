"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { appModules } from "@/lib/modules";
import {
  Home,
  Upload,
  ShoppingBag,
  Gift,
  Users,
  BarChart3,
  Settings,
  LogOut,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Icon map — add new icons here when adding new modules
const ICON_MAP: Record<string, LucideIcon> = {
  Upload,
  ShoppingBag,
  Gift,
  Users,
  BarChart3,
};

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const { user, userData } = useAuth();

  const handleSignOut = async () => {
    await signOut(auth);
  };

  const isActive = (href: string) => pathname === href;

  const navLinkClass = (href: string) =>
    `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-body transition-colors ${
      isActive(href)
        ? "bg-white/15 text-brand-cream"
        : "text-brand-cream/70 hover:bg-white/10 hover:text-brand-cream"
    }`;

  return (
    <aside
      className={`
        fixed left-0 top-0 h-full w-[200px] bg-brand-green flex flex-col z-50 print:hidden
        transition-transform duration-200 ease-in-out
        ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
      `}
    >
      {/* Header */}
      <div className="px-4 pt-5 pb-4 flex items-start justify-between shrink-0">
        <div>
          <h1 className="font-heading text-brand-cream text-lg font-bold leading-tight">
            Alec&apos;s Dashboard
          </h1>
          <p className="text-brand-cream/50 text-xs mt-0.5">Alec&apos;s Shoes</p>
        </div>
        {/* Close button — mobile only */}
        <button
          className="md:hidden text-brand-cream/50 hover:text-brand-cream mt-0.5 p-0.5"
          onClick={onMobileClose}
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 space-y-4 overflow-y-auto">
        {/* Home */}
        <div>
          <Link href="/" className={navLinkClass("/")} onClick={onMobileClose}>
            <Home size={18} />
            Home
          </Link>
        </div>

        {/* Module sections — driven by appModules registry */}
        {appModules.map((mod) => (
          <div key={mod.id}>
            <p className="px-2 text-[10px] uppercase tracking-wider text-brand-cream/40 font-body mb-1">
              {mod.name}
            </p>
            {mod.navItems.map((item) => {
              const Icon = ICON_MAP[item.icon];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={navLinkClass(item.href)}
                  onClick={onMobileClose}
                >
                  {Icon && <Icon size={18} />}
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}

      </nav>

      {/* Settings (admin only) */}
      {userData?.role === "admin" && (
        <div className="px-2 mb-2 shrink-0">
          <Link
            href="/settings"
            className={navLinkClass("/settings")}
            onClick={onMobileClose}
          >
            <Settings size={18} />
            Settings
          </Link>
        </div>
      )}

      {/* User area */}
      <div className="border-t border-white/10 px-3 py-3 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              className="w-7 h-7 rounded-full shrink-0"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-brand-green-mid shrink-0" />
          )}
          <span className="text-brand-cream text-xs font-body truncate">
            {user?.displayName || "User"}
          </span>
        </div>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 text-brand-cream/50 hover:text-brand-cream text-xs font-body transition-colors"
        >
          <LogOut size={14} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
