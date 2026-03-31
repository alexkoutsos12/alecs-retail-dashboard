// Module registry — the single source of truth for all modules.
// Adding a new module: add one entry to this array.
// The home page and sidebar update automatically.

export interface NavItem {
  label: string;
  href: string;
  icon: string; // Lucide icon name — must exist in sidebar's ICON_MAP
}

export interface AppModule {
  id: string;
  name: string;
  description: string;
  firestoreModule: string; // value stored in Firestore reports.module field
  navItems: NavItem[];
  importRoute: string;
  reportRoutes: { label: string; href: string }[];
}

export const appModules: AppModule[] = [
  {
    id: "perk-tracker",
    name: "Perk Tracker",
    description:
      "Outlet sales and employee perk payouts from the RICS Sales Journal.",
    firestoreModule: "perk-tracker",
    navItems: [
      {
        label: "Outlet Sales",
        href: "/perk-tracker/outlet-sales",
        icon: "ShoppingBag",
      },
      {
        label: "Perk Payout",
        href: "/perk-tracker/perk-payout",
        icon: "Gift",
      },
      { label: "Import", href: "/perk-tracker/import", icon: "Upload" },
    ],
    importRoute: "/perk-tracker/import",
    reportRoutes: [
      { label: "Outlet Sales →", href: "/perk-tracker/outlet-sales" },
      { label: "Perk Payout →", href: "/perk-tracker/perk-payout" },
    ],
  },
  {
    id: "team-performance",
    name: "Team Performance",
    description:
      "Salesperson and cashier performance metrics from the RICS Sales Journal.",
    firestoreModule: "team-performance",
    navItems: [
      {
        label: "Salesperson",
        href: "/team-performance/salesperson",
        icon: "Users",
      },
      {
        label: "Cashier",
        href: "/team-performance/cashier",
        icon: "BarChart3",
      },
      { label: "Import", href: "/team-performance/import", icon: "Upload" },
    ],
    importRoute: "/team-performance/import",
    reportRoutes: [
      { label: "Salesperson →", href: "/team-performance/salesperson" },
      { label: "Cashier →", href: "/team-performance/cashier" },
    ],
  },
  {
    id: "perk-inventory",
    name: "Perk Inventory",
    description:
      "Current payable perk SKUs organized by gender and category — printable staff reference.",
    firestoreModule: "perk-inventory",
    navItems: [
      {
        label: "Active Incentives",
        href: "/perk-inventory/active-incentives",
        icon: "Tag",
      },
      { label: "Import", href: "/perk-inventory/import", icon: "Upload" },
    ],
    importRoute: "/perk-inventory/import",
    reportRoutes: [
      {
        label: "Active Incentives →",
        href: "/perk-inventory/active-incentives",
      },
    ],
  },
];
