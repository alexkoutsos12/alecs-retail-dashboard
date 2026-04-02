"use client";

export interface ReportMeta {
  id: string;
  filename: string;
  dateRange: { start: string; end: string };
  totalTransactions: number;
  storagePath: string;
}

interface Props {
  reports: ReportMeta[];
  loadingReports: boolean;
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
  onLoad: () => void;
  loadingData: boolean;
  collapsed: boolean;
  onExpand: () => void;
  onCollapse?: () => void;
}

function fmtShort(d: string): string {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(day, 10)}, ${y}`;
}

export default function ImportSelector({
  reports,
  loadingReports,
  selectedIds,
  onSelectedChange,
  onLoad,
  loadingData,
  collapsed,
  onExpand,
  onCollapse,
}: Props) {
  if (collapsed) {
    const names = reports
      .filter((r) => selectedIds.includes(r.id))
      .map((r) => r.filename);
    const label =
      names.length === 0
        ? "No imports selected"
        : names.length === 1
        ? names[0]
        : `${names.length} reports`;

    return (
      <div className="flex items-center gap-2 mb-5 print:hidden">
        <span className="font-body text-sm text-brand-text/60">
          Showing:{" "}
          <span className="text-brand-text font-medium">{label}</span>
        </span>
        <button
          onClick={onExpand}
          className="font-body text-xs text-brand-green hover:underline"
        >
          [Change]
        </button>
      </div>
    );
  }

  const allIds = reports.map((r) => r.id);
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selectedIds.includes(id));

  const toggleAll = () => {
    onSelectedChange(allSelected ? [] : allIds);
  };

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectedChange(selectedIds.filter((s) => s !== id));
    } else {
      onSelectedChange([...selectedIds, id]);
    }
  };

  return (
    <div className="bg-white border-l-[3px] border-brand-green rounded p-4 mb-6 print:hidden">
      <div className="flex items-center justify-between mb-3">
        <p className="font-body text-[10px] uppercase tracking-wider text-brand-text/40">
          Data source
        </p>
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="font-body text-xs text-brand-text/40 hover:text-brand-text/60 transition-colors"
          >
            Collapse ▲
          </button>
        )}
      </div>

      {loadingReports ? (
        <div className="space-y-2 mb-4">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-8 bg-brand-cream rounded animate-pulse"
            />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <p className="font-body text-sm text-brand-text/50 mb-4">
          No imports found.
        </p>
      ) : (
        <div className="space-y-0.5 mb-4">
          {reports.map((r) => (
            <label
              key={r.id}
              className="flex items-start gap-2.5 cursor-pointer py-1.5 hover:bg-brand-cream/50 px-1 rounded"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(r.id)}
                onChange={() => toggle(r.id)}
                className="mt-0.5 accent-brand-green shrink-0"
              />
              <span className="font-body text-sm text-brand-text leading-snug">
                <span className="font-medium">{r.filename}</span>
                <span className="text-brand-text/50 ml-2 text-xs">
                  {fmtShort(r.dateRange?.start)} –{" "}
                  {fmtShort(r.dateRange?.end)}
                  {" · "}
                  {r.totalTransactions.toLocaleString()} transactions
                </span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2 border-t border-brand-cream">
        <button
          onClick={toggleAll}
          className="font-body text-xs text-brand-green hover:underline"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
        <button
          onClick={onLoad}
          disabled={selectedIds.length === 0 || loadingData}
          className="ml-auto bg-brand-green text-brand-cream font-body text-sm px-4 py-1.5 rounded hover:bg-brand-green-mid transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loadingData ? "Loading..." : "Load Report →"}
        </button>
      </div>
    </div>
  );
}
