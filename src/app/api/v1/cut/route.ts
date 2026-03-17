import { NextResponse } from "next/server";
import { beginCut, failCut, finishCut } from "@/lib/v1/store";
import { SessionRole } from "@/lib/v1/types";
import { transcribeAndTranslate } from "@/lib/v1/ai";

export const runtime = "nodejs";

interface CutRequestBody {
    sessionCode?: string;
    requesterRole?: SessionRole;
    clientId?: string;
}

function isRole(value: unknown): value is SessionRole {
    return value === "single" || value === "listener" || value === "controller" || value === "viewer";
}

export async function POST(req: Request) {
    let body: CutRequestBody;
    try {
        body = (await req.json()) as CutRequestBody;
    } catch {
        return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
    }

    const sessionCode = typeof body.sessionCode === "string" ? body.sessionCode.trim() : "";
    if (!sessionCode) {
        return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    if (!isRole(body.requesterRole)) {
        return NextResponse.json({ error: "Missing or invalid requesterRole." }, { status: 400 });
    }

    const cut = beginCut({
        code: sessionCode,
        requesterRole: body.requesterRole,
        clientId: typeof body.clientId === "string" ? body.clientId.trim() : undefined,
    });

    if (!cut.ok) {
        return NextResponse.json({ ok: false, reason: cut.reason }, { status: cut.status });
    }

    try {
        let aiResult: { sourceText: string; translatedText: string };

        try {
            aiResult = await transcribeAndTranslate({
                audio: cut.audio,
                mimeType: cut.mimeType,
                languageA: cut.languageA,
                languageB: cut.languageB,
                segmentId: cut.segmentId,
            });
        } catch (error) {
            //   const sourceParts: string[] = [];
            //   const translatedParts: string[] = [];
            aiResult = { sourceText: "", translatedText: "" }

            //   for (let i = 0; i < cut.rawChunks.length; i += 1) {
            //     const chunk = cut.rawChunks[i];
            //     try {
            //       const chunkResult = await transcribeAndTranslate({
            //         audio: chunk.audio,
            //         mimeType: chunk.mimeType || cut.mimeType || "audio/webm",
            //         languageA: cut.languageA,
            //         languageB: cut.languageB,
            //         segmentId: cut.segmentId * 1000 + i,
            //       });

            //       if (chunkResult.sourceText.trim()) {
            //         sourceParts.push(chunkResult.sourceText.trim());
            //       }
            //       if (chunkResult.translatedText.trim()) {
            //         translatedParts.push(chunkResult.translatedText.trim());
            //       }
            //     } catch {
            //       // Skip unreadable chunk and continue salvage.
            //     }
            //   }

            //   aiResult = {
            //     sourceText: sourceParts.join(" ").trim(),
            //     translatedText: translatedParts.join(" ").trim(),
            //   };

            //   if (!aiResult.sourceText && !aiResult.translatedText) {
            //     console.warn("[cut] merged+chunk transcription failed; returning empty segment", {
            //       sessionCode,
            //       segmentId: cut.segmentId,
            //       chunkCount: cut.rawChunks.length,
            //       mergedMimeType: cut.mimeType,
            //       mergedBytes: cut.audio.byteLength,
            //       originalError: error instanceof Error ? error.message : String(error),
            //     });
            //   }
        }

        const segment = {
            segmentId: cut.segmentId,
            sourceText: aiResult.sourceText,
            translatedText: aiResult.translatedText,
            languageA: cut.languageA,
            languageB: cut.languageB,
            startedAt: cut.startedAt,
            endedAt: cut.endedAt,
            createdAt: Date.now(),
        };

        finishCut({ code: sessionCode, segment });

        return NextResponse.json({ ok: true, segment });
    } catch (error) {
        failCut(sessionCode);
        const message = error instanceof Error ? error.message : "Cut failed.";
        return NextResponse.json({ ok: false, reason: message }, { status: 500 });
    }
}
