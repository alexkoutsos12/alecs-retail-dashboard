# Alec's Dashboard

Internal retail operations dashboard for Alec's Shoes. Tracks outlet sales and employee perk payouts parsed from RICS Sales Journal exports.

## What this app is and who it's for

Alec's Dashboard is a private, invite-only web app used by store managers and administrators at Alec's Shoes. It ingests RICS Sales Journal CSV exports, separates outlet transactions from employee perk purchases, and surfaces clean reports for payroll and operations.

**Roles:**
- **Admin** — full access: import files, view all reports, manage users, delete reports
- **Manager** — view and import only; no access to Settings

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Auth | Firebase Authentication (email/password) |
| Database | Cloud Firestore |
| File storage | Firebase Storage |
| Notifications | react-hot-toast |
| Icons | Lucide React |
| Hosting | Vercel |

---

## Local setup

```bash
# 1. Clone the repo
git clone <repo-url>
cd alecs-retail-dashboard

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.local.example .env.local
# Fill in your Firebase project values (see below)

# 4. Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Required environment variables (`.env.local`)

```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

All values come from your Firebase project's **Project Settings → General → Your apps → SDK setup**.

---

## How to make someone an admin

New users who sign up via `/login` are assigned the `manager` role by default. To promote them to admin:

1. Log in as an existing admin.
2. Go to **Settings** (`/settings`).
3. Find the user in the **User Management** table.
4. Change their role dropdown from `manager` to `admin`.

The change is written to Firestore immediately. The user's role updates on their next page load.

> **First-time setup:** If no admin exists yet, manually set a user's role in the Firebase Console under **Firestore → users → {uid} → role: "admin"**.

---

## How the data flow works

```
RICS Sales Journal CSV
        │
        ▼
  /perk-tracker/import
  (client-side parser)
        │
        ├── Parses each row
        ├── Flags outlet items  (dept = OUTLET or price ≤ $0.01)
        └── Flags perk items    (tender type contains "EMPLOYEE")
        │
        ▼
  Firebase Storage
  reports/{module}/{reportId}.json   ← full transaction array
        │
        ▼
  Firestore: reports/{reportId}
  {
    module, filename, dateRange,
    totalTransactions, totalOutletItems, totalPerkItems,
    uploadedBy, uploadedByName, uploadedAt,
    storagePath
  }
        │
        ├── /perk-tracker/outlet-sales   reads Storage JSON, filters outlet rows
        └── /perk-tracker/perk-payout    reads Storage JSON, filters perk rows
```

Report pages always fetch the **latest** Firestore report doc, then load its full JSON from Storage on demand.

---

## How to add a new module

1. **Register it** in `src/lib/modules.ts` — add a new entry to the `appModules` array:

```typescript
{
  id: "my-module",
  name: "My Module",
  description: "What this module tracks.",
  firestoreModule: "my-module",          // value stored in Firestore reports.module
  navItems: [
    { label: "Import",   href: "/my-module/import",  icon: "Upload"    },
    { label: "Report",   href: "/my-module/report",   icon: "BarChart2" },
  ],
  importRoute: "/my-module/import",
  reportRoutes: [
    { label: "Report →", href: "/my-module/report" },
  ],
}
```

2. **Add icon names** to the `ICON_MAP` in `src/components/sidebar.tsx` if they aren't already there.

3. **Create the pages:**
   - `src/app/(dashboard)/my-module/import/page.tsx`
   - `src/app/(dashboard)/my-module/report/page.tsx`

The sidebar, home page module cards, and Settings reports table will all pick up the new module automatically.

---

## Firebase Storage folder structure

```
reports/
└── {firestoreModule}/          e.g. "perk-tracker"
    └── {reportId}.json         full parsed transaction array
```

Each JSON file is a flat array of transaction objects. The filename matches the Firestore document ID in the `reports` collection.

Security rules restrict read/write to authenticated users only. Deletion is only possible through the admin Settings page (which calls the Firebase SDK directly with the authenticated user's token).

---

## Available scripts

```bash
npm run dev      # Start development server
npm run build    # Production build (also type-checks)
npm run start    # Serve production build locally
npm run lint     # ESLint
```
