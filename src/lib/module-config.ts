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
    id: "placeholder",
    title: "New module coming soon",
    description: "",
    firestoreModule: "",
    buttons: [],
    placeholder: true,
  },
];
