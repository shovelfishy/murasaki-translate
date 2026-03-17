import { NextResponse } from "next/server";
import { getFeed } from "@/lib/v1/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionCode = searchParams.get("sessionCode")?.trim();
  const cursorRaw = searchParams.get("cursor") ?? "0";
  const cursor = Number.parseInt(cursorRaw, 10);
  const clientId = searchParams.get("clientId")?.trim() || undefined;

  if (!sessionCode) {
    return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
  }

  const feed = await getFeed(sessionCode, Number.isNaN(cursor) ? 0 : cursor, clientId);
  if (!feed) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return NextResponse.json(feed);
}
