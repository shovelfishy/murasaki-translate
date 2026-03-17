import { NextResponse } from "next/server";
import { appendChunk } from "@/lib/v1/store";
import { SessionRole } from "@/lib/v1/types";

export const runtime = "nodejs";

interface ChunkRequestBody {
  sessionCode?: string;
  role?: SessionRole;
  clientId?: string;
  seq?: number;
  mimeType?: string;
  audioBase64?: string;
  startedAt?: number;
  endedAt?: number;
}

function isRole(value: unknown): value is SessionRole {
  return value === "single" || value === "listener" || value === "controller" || value === "viewer";
}

export async function POST(req: Request) {
  let body: ChunkRequestBody;
  try {
    body = (await req.json()) as ChunkRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const sessionCode = typeof body.sessionCode === "string" ? body.sessionCode.trim() : "";
  if (!sessionCode) {
    return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
  }

  if (!isRole(body.role)) {
    return NextResponse.json({ error: "Missing or invalid role." }, { status: 400 });
  }

  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) {
    return NextResponse.json({ error: "Invalid seq." }, { status: 400 });
  }

  if (typeof body.mimeType !== "string" || !body.mimeType.trim()) {
    return NextResponse.json({ error: "Missing mimeType." }, { status: 400 });
  }

  if (typeof body.audioBase64 !== "string" || !body.audioBase64) {
    return NextResponse.json({ error: "Missing audioBase64." }, { status: 400 });
  }

  if (typeof body.startedAt !== "number" || typeof body.endedAt !== "number") {
    return NextResponse.json({ error: "Missing startedAt/endedAt." }, { status: 400 });
  }

  let audio: Buffer;
  try {
    audio = Buffer.from(body.audioBase64, "base64");
  } catch {
    return NextResponse.json({ error: "Invalid base64 audio." }, { status: 400 });
  }

  if (audio.byteLength === 0) {
    return NextResponse.json({ error: "Empty audio chunk." }, { status: 400 });
  }

  const MAX_CHUNK_BYTES = 1024 * 1024 * 3;
  if (audio.byteLength > MAX_CHUNK_BYTES) {
    return NextResponse.json({ error: "Chunk too large." }, { status: 413 });
  }

  const result = appendChunk({
    code: sessionCode,
    role: body.role,
    clientId: typeof body.clientId === "string" ? body.clientId.trim() : undefined,
    chunk: {
      seq: body.seq,
      mimeType: body.mimeType,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
      audio,
    },
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
