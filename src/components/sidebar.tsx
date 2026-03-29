"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import {
  Home,
  Upload,
  ShoppingBag,
  Gift,
  Settings,
  LogOut,
} from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const sections: NavSection[] = [
  {
    label: "",
    items: [{ label: "Home", href: "/", icon: <Home size={18} /> }],
  },
  {
    label: "PERK TRACKER",
    items: [
      { label: "Import", href: "/perk-tracker/import", icon: <Upload size={18} /> },
      { label: "Outlet Sales", href: "/perk-tracker/outlet-sales", icon: <ShoppingBag size={18} /> },
      { label: "Perk Payout", href: "/perk-tracker/perk-payout", icon: <Gift size={18} /> },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, userData } = useAuth();

  const handleSignOut = async () => {
    await signOut(auth);
  };

  return (
    <aside className="fixed left-0 top-0 h-full w-[200px] bg-brand-green flex flex-col z-50 print:hidden">
      <div className="px-4 pt-5 pb-4">
        <h1 className="font-heading text-brand-cream text-lg font-bold leading-tight">
          Alec&apos;s Dashboard
        </h1>
        <p className="text-brand-cream/50 text-xs mt-0.5">Alec&apos;s Shoes</p>
      </div>

      <nav className="flex-1 px-2 space-y-4 overflow-y-auto">
        {sections.map((section) => (
          <div key={section.label || "home"}>
            {section.label && (
              <p className="px-2 text-[10px] uppercase tracking-wider text-brand-cream/40 font-body mb-1">
                {section.label}
              </p>
            )}
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-body transition-colors ${
                    active
                      ? "bg-white/15 text-brand-cream"
                      : "text-brand-cream/70 hover:bg-white/10 hover:text-brand-cream"
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}

        <div>
          <p className="px-2 text-[10px] uppercase tracking-wider text-brand-cream/20 font-body mb-1">
            More modules
          </p>
          <p className="px-3 py-1.5 text-xs text-brand-cream/20 italic">
            Coming soon
          </p>
        </div>
      </nav>

      {userData?.role === "admin" && (
        <div className="px-2 mb-2">
          <Link
            href="/settings"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-body transition-colors ${
              pathname === "/settings"
                ? "bg-white/15 text-brand-cream"
                : "text-brand-cream/70 hover:bg-white/10 hover:text-brand-cream"
            }`}
          >
            <Settings size={18} />
            Settings
          </Link>
        </div>
      )}

      <div className="border-t border-white/10 px-3 py-3">
        <div className="flex items-center gap-2 mb-2">
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              className="w-7 h-7 rounded-full"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-brand-green-mid" />
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
