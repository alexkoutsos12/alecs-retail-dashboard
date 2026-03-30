export interface ModuleConfig {
  id: string;
  title: string;
  description: string;
  firestoreModule: string;
  buttons: { label: string; href: string }[];
  placeholder?: boolean;
}

export const modules: ModuleConfig[] = [
  {
    id: "perk-tracker",
    title: "Perk Tracker",
    description:
      "Outlet sales and employee perk payouts from the RICS Sales Journal.",
    firestoreModule: "perk-tracker",
    buttons: [
      { label: "Outlet Sales →", href: "/perk-tracker/outlet-sales" },
      { label: "Perk Payout →", href: "/perk-tracker/perk-payout" },
    ],
  },
  {
    id: "team-performance",
    title: "Team Performance",
    description:
      "Salesperson and cashier performance metrics from the RICS Sales Journal.",
    firestoreModule: "team-performance",
    buttons: [
      { label: "Salesperson →", href: "/team-performance/salesperson" },
      { label: "Cashier →", href: "/team-performance/cashier" },
    ],
  },
];
