"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function CashierPage() {
  useEffect(() => {
    document.title = "Cashier · Team Performance";
  }, []);

  return (
    <div>
      <h1 className="font-heading text-brand-green text-2xl font-bold mb-1">
        Cashier Report
      </h1>
      <p className="text-brand-text/50 font-body text-sm mb-6">
        Individual cashier performance metrics.
      </p>
      <div className="bg-white border-l-[3px] border-brand-green rounded p-8 text-center">
        <p className="text-brand-text/40 font-body text-sm mb-4">
          This report is coming soon. Import your Sales Journal data first.
        </p>
        <Link
          href="/team-performance/import"
          className="inline-block bg-brand-green text-brand-cream text-sm font-body px-4 py-2 rounded hover:bg-brand-green-mid transition-colors"
        >
          Go to Import →
        </Link>
      </div>
    </div>
  );
}
