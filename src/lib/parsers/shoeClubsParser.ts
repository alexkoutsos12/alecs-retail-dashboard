// Parser for the RICS "Captains List" CSV export used by the Shoe Clubs
// module.
//
// Each row is a captain running a weekly shoe club. The RICS export crams
// club metadata into the address/city fields of the customer record:
//
//   AddressLine: "NEW CLUB 2/19/26\nCLUB TOTAL $3850"
//   City:        "WEEKLY AMOUNT DUE $385"
//
// The city field has two known RICS typos in circulation: "AMOUT" for
// "AMOUNT" and "DIE" for "DUE". The regex accepts both.

export type ShoeClubCategory = "outstanding" | "completed" | "new-club";

export interface ShoeClubCaptain {
  accountNumber: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  /** ISO YYYY-MM-DD — start date from "NEW CLUB M/D/YY". */
  clubStartDate: string;
  clubTotal: number;
  weeklyAmount: number;
  currentBalance: number;
  amountPaid: number; // clubTotal - currentBalance
  weeksElapsed: number; // whole weeks since startDate (clamped >= 0)
  /** Positive = ahead, negative = behind, 0 = on pace. Truncated toward 0. */
  weeksBehind: number;
  /** True when the 10-week cycle has ended but the captain still owes money. */
  isOverdue: boolean;
  category: ShoeClubCategory;
}

export interface ShoeClubsResult {
  captains: ShoeClubCaptain[];
  importDate: string; // ISO YYYY-MM-DD (today, at parse time)
  counts: {
    total: number;
    outstanding: number;
    completed: number;
    newClub: number;
  };
}

// ─── CSV tokenizer ──────────────────────────────────────────────────────
//
// The RICS export embeds newlines inside quoted AddressLine fields, so
// we can't just split on \n. This is a minimal CSV reader that handles
// quoted fields + embedded newlines + escaped quotes ("").

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // strip
      } else {
        field += c;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ─── Field helpers ──────────────────────────────────────────────────────

function parseNewClubDate(addressLine: string): string {
  // First line: "NEW CLUB M/D/YY" (possibly with extra spaces)
  const m = addressLine.match(/NEW\s+CLUB\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (!m) return "";
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  let yy = parseInt(m[3], 10);
  if (m[3].length === 2) yy = 2000 + yy; // RICS writes 2-digit years
  const mmS = String(mm).padStart(2, "0");
  const ddS = String(dd).padStart(2, "0");
  return `${yy}-${mmS}-${ddS}`;
}

function parseClubTotal(addressLine: string): number {
  // Second line: "CLUB TOTAL $3850"
  const m = addressLine.match(/CLUB\s+TOTAL\s+\$?([\d.,]+)/i);
  if (!m) return 0;
  return parseFloat(m[1].replace(/,/g, "")) || 0;
}

function parseWeeklyAmount(city: string): number {
  // "WEEKLY AMOUNT DUE $385"
  //  — allow typos "AMOUT" for "AMOUNT" and "DIE" for "DUE"
  //  — allow any whitespace between tokens
  const m = city.match(
    /WEEKLY\s+AMOU?N?T\s+D[UI]E\s+\$?([\d.,]+)/i
  );
  if (!m) return 0;
  return parseFloat(m[1].replace(/,/g, "")) || 0;
}

/**
 * Normalize phone to a consistent "XXX-XXX-XXXX" string. Strips the
 * leading "CELL" tag used by RICS and any trailing annotations like
 * " work". 7-digit local numbers get a 603 area code prepended.
 * Returns "" for empty/unparseable input.
 */
function normalizePhone(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";
  // Strip "CELL" prefix (case-insensitive, with or without trailing space).
  s = s.replace(/^CELL\s*/i, "");
  // Extract digits only; anything else (annotations like "work", stray
  // letters, punctuation) is discarded.
  const digits = s.replace(/\D/g, "");
  if (digits.length === 0) return "";
  let ten = digits;
  if (digits.length === 7) ten = "603" + digits;
  if (ten.length !== 10) return ""; // junk — don't guess
  return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// ─── Status math ────────────────────────────────────────────────────────

/** Whole weeks between two ISO dates (a before b). Negative if b < a. */
function weeksBetween(startIso: string, endIso: string): number {
  if (!startIso || !endIso) return 0;
  const start = new Date(`${startIso}T00:00:00`);
  const end = new Date(`${endIso}T00:00:00`);
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000));
}

function isoToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Main parser ────────────────────────────────────────────────────────

export function parseShoeClubs(csvContent: string): ShoeClubsResult {
  const rows = parseCsv(csvContent);
  if (rows.length === 0) {
    return {
      captains: [],
      importDate: isoToday(),
      counts: { total: 0, outstanding: 0, completed: 0, newClub: 0 },
    };
  }
  const headers = rows[0].map((h) => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const ACCT = col("AccountNumber");
  const FIRST = col("FirstName");
  const LAST = col("LastName");
  const PHONE = col("PhoneNumber");
  const ADDR = col("AddressLine");
  const CITY = col("City");
  const BAL = col("CurrentBalance");

  const today = isoToday();

  const captains: ShoeClubCaptain[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[ACCT] || r[ACCT].trim() === "") continue; // skip blank rows

    const addressLine = r[ADDR] ?? "";
    const cityField = r[CITY] ?? "";
    const clubStartDate = parseNewClubDate(addressLine);
    const clubTotal = parseClubTotal(addressLine);
    const weeklyAmount = parseWeeklyAmount(cityField);
    const currentBalance = parseFloat(r[BAL] || "0") || 0;
    const amountPaid = clubTotal - currentBalance;

    // Weeks elapsed since club started. Clamp at 0 so future-dated clubs
    // don't produce negative expected payments.
    const weeksElapsedRaw = weeksBetween(clubStartDate, today);
    const weeksElapsed = Math.max(0, weeksElapsedRaw);

    // How much the captain *should* have paid by now, capped at the
    // full club total (you can't owe past 100%).
    const expectedPaid = Math.min(
      weeksElapsed * weeklyAmount,
      clubTotal
    );

    // Weeks ahead/behind. Truncate toward zero so -0.3 is "on pace" and
    // -1.5 is 1 week behind (not 2). The report page softens the
    // arithmetic visually by showing the Wk / 10 column as a decimal.
    let weeksBehind = 0;
    if (weeklyAmount > 0) {
      weeksBehind = Math.trunc((amountPaid - expectedPaid) / weeklyAmount);
    }

    // The club cycle is a rolling ~10 weeks. Past that, a positive balance
    // means the captain didn't finish paying within the cycle.
    const isOverdue = weeksElapsed > 10 && currentBalance > 0;

    let category: ShoeClubCategory;
    if (currentBalance > 0) category = "outstanding";
    else if (currentBalance < 0) category = "new-club";
    else category = "completed";

    captains.push({
      accountNumber: String(r[ACCT]).trim(),
      firstName: String(r[FIRST] ?? "").trim(),
      lastName: String(r[LAST] ?? "").trim(),
      phoneNumber: normalizePhone(r[PHONE] ?? ""),
      clubStartDate,
      clubTotal,
      weeklyAmount,
      currentBalance,
      amountPaid,
      weeksElapsed,
      weeksBehind,
      isOverdue,
      category,
    });
  }

  // Sort inside each category per spec:
  //   outstanding: most-delinquent first (most-negative weeksBehind), then
  //                alphabetical by last name as tiebreaker.
  //   completed + new-club: alphabetical by last name.
  const byLastName = (a: ShoeClubCaptain, b: ShoeClubCaptain) =>
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName);

  const outstanding = captains
    .filter((c) => c.category === "outstanding")
    .sort((a, b) => a.weeksBehind - b.weeksBehind || byLastName(a, b));
  const completed = captains
    .filter((c) => c.category === "completed")
    .sort(byLastName);
  const newClub = captains
    .filter((c) => c.category === "new-club")
    .sort(byLastName);

  const ordered = [...outstanding, ...completed, ...newClub];

  return {
    captains: ordered,
    importDate: today,
    counts: {
      total: ordered.length,
      outstanding: outstanding.length,
      completed: completed.length,
      newClub: newClub.length,
    },
  };
}
