import { unzipSync, strFromU8 } from "fflate";

/**
 * Extract images embedded in an .xlsx, keyed by the 0-based worksheet row they
 * are anchored to. Used to surface the Nike.net product thumbnails (one per
 * style-color, anchored in column B) for the Order Builder review.
 *
 * SheetJS reads the cell data but not the drawing/media, so we unzip the file
 * and walk the drawing anchors ourselves.
 */
export function extractRowImages(buffer: ArrayBuffer): Map<number, string> {
  const map = new Map<number, string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return map;
  }

  const drawingPath = Object.keys(files).find((p) =>
    /^xl\/drawings\/drawing\d+\.xml$/.test(p)
  );
  if (!drawingPath || !files[drawingPath]) return map;
  const relsPath = drawingPath.replace(/\/([^/]+)$/, "/_rels/$1.rels");

  const drawingXml = strFromU8(files[drawingPath]);
  const relsXml = files[relsPath] ? strFromU8(files[relsPath]) : "";

  // rId -> media filename
  const ridToFile = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/\bId="([^"]+)"/);
    const target = tag.match(/\bTarget="([^"]+)"/);
    if (id && target) ridToFile.set(id[1], target[1].replace(/^.*\//, ""));
  }

  for (const a of drawingXml.matchAll(
    /<xdr:(oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/xdr:\1>/g
  )) {
    const block = a[0];
    const rowM = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
    const embM = block.match(/r:embed="([^"]+)"/);
    if (!rowM || !embM) continue;
    const file = ridToFile.get(embM[1]);
    if (!file) continue;
    const bytes = files[`xl/media/${file}`];
    if (!bytes) continue;
    map.set(parseInt(rowM[1], 10), toDataUrl(bytes, file));
  }
  return map;
}

function toDataUrl(bytes: Uint8Array, file: string): string {
  const ext = (file.split(".").pop() || "jpeg").toLowerCase();
  const mime =
    ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(bin)}`;
}
