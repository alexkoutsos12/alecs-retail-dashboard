import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy for Firebase Storage downloads.
 *
 * The .firebasestorage.app bucket returns 503 when the browser fetches
 * the download URL directly.  By proxying through this API route the
 * request is made server-to-server (no CORS, no browser restrictions)
 * and the JSON is forwarded to the client.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  // Only allow proxying Firebase Storage URLs
  if (!url.startsWith("https://firebasestorage.googleapis.com/")) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 403 });
  }

  try {
    const res = await fetch(url);

    if (!res.ok) {
      return NextResponse.json(
        { error: `Storage returned ${res.status}` },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
