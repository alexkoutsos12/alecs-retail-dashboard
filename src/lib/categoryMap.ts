// Category mapping — single source of truth for mapping RICS class codes
// to gender and main category. Used by the parser and the UI.

interface CategoryMapping {
  gender: string;
  mainCategory: string;
}

const CLASS_MAP: Record<number, CategoryMapping> = {};

function register(
  gender: string,
  mainCategory: string,
  codes: number[]
): void {
  for (const code of codes) {
    CLASS_MAP[code] = { gender, mainCategory };
  }
}

// ── Men's ──────────────────────────────────────────
register("Men's", "Dress", [1, 2, 3, 6, 7, 8, 10, 12, 19]);
register("Men's", "Handsewns", [20, 21, 22, 25, 26, 27, 39]);
register("Men's", "Casual", [
  40, 41, 42, 43, 46, 47, 48, 51, 52, 54, 56, 58, 59, 63, 69,
]);
register("Men's", "Work", [70, 71, 72, 75, 76, 79, 80, 83, 89]);
register("Men's", "Uniform", [90, 91, 92, 94, 96, 99]);
register("Men's", "Steel Toe", [100, 102, 106, 107, 109]);
register("Men's", "Athletic", [
  110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124,
  127, 128, 129,
]);
register("Men's", "Cleated", [
  130, 131, 132, 133, 134, 135, 136, 137, 138, 139,
]);
register("Men's", "Hiking", [140, 141, 143, 144, 149]);
register("Men's", "Sandals", [150, 153, 154, 156]);
register("Men's", "Slippers", [160, 161, 164, 169]);
register("Men's", "Snow & Sport", [170, 173, 176, 179]);
register("Men's", "Rainwear", [190, 194, 196, 199, 200]);

// ── Women's ────────────────────────────────────────
// NOTE: Class 191 is intentionally Women's Rainwear even though RICS
// places it under Men's numbering.
register("Women's", "Rainwear", [191]);
register("Women's", "Dress", [
  301, 302, 303, 304, 305, 306, 307, 310, 311, 313, 314, 316, 318, 319, 320,
  321, 323, 329, 330, 331, 336, 337, 339,
]);
register("Women's", "Clogs", [340, 341, 342, 343, 344, 345, 349]);
register("Women's", "Casual", [
  350, 351, 352, 355, 357, 361, 363, 364, 369,
]);
register("Women's", "Sandals", [
  370, 371, 372, 373, 374, 375, 376, 377, 379,
]);
register("Women's", "Boots", [
  380, 381, 382, 383, 384, 385, 386, 387, 389, 390, 391, 395, 396, 399,
]);
register("Women's", "Teen Fashion", [400, 401, 402, 403, 408]);
register("Women's", "Athletics", [
  410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 425,
  427, 429,
]);
register("Women's", "Cleated", [430, 431, 432, 434, 435, 439]);
register("Women's", "Hiking", [440, 441, 443, 444, 449]);
register("Women's", "Slippers", [460, 461, 462, 463]);
register("Women's", "Uniform", [470, 471, 472, 475]);

// ── Children's ─────────────────────────────────────
register("Children's", "Shoes", [500, 503, 504, 505, 506, 507, 508, 509]);
register("Children's", "Boots", [
  510, 511, 512, 513, 514, 516, 517, 519,
]);
register("Children's", "Athletics", [
  520, 521, 522, 523, 524, 525, 526, 527, 528, 530, 531, 536, 537, 549,
]);
register("Children's", "Sandals", [
  550, 551, 552, 553, 554, 555, 556, 557, 559,
]);
register("Children's", "Slippers", [560, 561, 562, 569]);

/**
 * Look up gender and mainCategory from a RICS class string.
 * Extracts the numeric prefix before the first hyphen or space.
 */
export function classifyByCode(classValue: string): CategoryMapping {
  const match = classValue.match(/^(\d+)/);
  if (!match) return { gender: "Other", mainCategory: "Uncategorized" };
  const code = parseInt(match[1], 10);
  return CLASS_MAP[code] ?? { gender: "Other", mainCategory: "Uncategorized" };
}

export { CLASS_MAP };
