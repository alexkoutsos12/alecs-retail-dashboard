"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Tag } from "lucide-react";

export default function ActiveIncentivesPage() {
  useEffect(() => {
    document.title = "Active Incentives · Perk Inventory";
  }, []);

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-6">
        Active Incentives
      </h1>
      <div className="bg-white border-l-[3px] border-brand-green rounded p-10 text-center">
        <Tag className="w-10 h-10 text-brand-cream-dark mx-auto mb-3" />
        <p className="font-body text-sm text-brand-text/50 mb-4">
          Active incentives view coming soon.
        </p>
        <Link
          href="/perk-inventory/import"
          className="inline-block bg-brand-green text-brand-cream text-sm font-body px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
        >
          Go to Import
        </Link>
      </div>
    </div>
  );
}
