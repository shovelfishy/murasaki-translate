import { NextResponse } from "next/server";
import {
  ackCutReady,
  applyControl,
  claimRole,
  ControlAction,
  createSession,
  getSession,
  heartbeatSession,
  joinSession,
  leaveSession,
  releaseRole,
  requestCut,
  snapshotSession,
} from "@/lib/v1/store";
import { MultiSessionRole, SessionMode, SessionRole } from "@/lib/v1/types";

export const runtime = "nodejs";

type SessionAction =
  | "create"
  | "join"
  | "status"
  | "control"
  | "claim_role"
  | "heartbeat"
  | "leave"
  | "release_role"
  | "request_cut"
  | "ack_cut_ready";

interface SessionRequestBody {
  action?: SessionAction;
  requesterRole?: SessionRole;
  sessionCode?: string;
  languageA?: string;
  languageB?: string;
  sourceLang?: string;
  targetLang?: string;
  controlAction?: ControlAction;
  controlRevision?: number;
  mode?: SessionMode;
  clientId?: string;
  desiredRole?: MultiSessionRole;
  cutRevision?: number;
}

function isRole(value: unknown): value is SessionRole {
  return value === "single" || value === "listener" || value === "controller" || value === "viewer";
}

function isMultiRole(value: unknown): value is MultiSessionRole {
  return value === "listener" || value === "controller" || value === "viewer";
}

function isSessionMode(value: unknown): value is SessionMode {
  return value === "single" || value === "multi";
}

function isControlAction(value: unknown): value is ControlAction {
  return value === "start" || value === "stop" || value === "listener_started" || value === "listener_stopped";
}

function normalizeLang(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeCode(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeClientId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export async function POST(req: Request) {
  let body: SessionRequestBody;
  try {
    body = (await req.json()) as SessionRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const action = body.action;
  if (!action) {
    return NextResponse.json({ error: "Missing action." }, { status: 400 });
  }

  if (action === "create") {
    const languageA = normalizeLang(body.languageA ?? body.sourceLang, "English");
    const languageB = normalizeLang(body.languageB ?? body.targetLang, "Japanese");
    const mode = isSessionMode(body.mode) ? body.mode : "single";

    if (mode === "multi") {
      const clientId = normalizeClientId(body.clientId);
      if (!clientId) {
        return NextResponse.json({ error: "Missing clientId." }, { status: 400 });
      }

      if (!isMultiRole(body.desiredRole)) {
        return NextResponse.json({ error: "Missing or invalid desiredRole." }, { status: 400 });
      }

      const session = await createSession({
        languageA,
        languageB,
        mode,
        creatorClientId: clientId,
        creatorRole: body.desiredRole,
      });

      return NextResponse.json({
        sessionCode: session.code,
        session: snapshotSession(session, clientId),
      });
    }

    const session = await createSession({ languageA, languageB, mode: "single" });
    return NextResponse.json({
      sessionCode: session.code,
      session: snapshotSession(session),
    });
  }

  if (action === "join") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);

    const session = await joinSession(sessionCode);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    return NextResponse.json({
      sessionCode: session.code,
      session: snapshotSession(session, clientId || undefined),
    });
  }

  if (action === "status") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);

    const session = await getSession(sessionCode);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    return NextResponse.json({
      sessionCode: session.code,
      session: snapshotSession(session, clientId || undefined),
    });
  }

  if (action === "claim_role") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId." }, { status: 400 });
    }

    if (!isMultiRole(body.desiredRole)) {
      return NextResponse.json({ error: "Missing or invalid desiredRole." }, { status: 400 });
    }

    const claimed = await claimRole({
      code: sessionCode,
      clientId,
      role: body.desiredRole,
    });

    if (!claimed.ok) {
      return NextResponse.json({ error: claimed.reason }, { status: claimed.status });
    }

    return NextResponse.json({
      ok: true,
      session: snapshotSession(claimed.session, clientId),
    });
  }

  if (action === "heartbeat") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId." }, { status: 400 });
    }

    const result = await heartbeatSession({ code: sessionCode, clientId });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: result.status });
    }

    return NextResponse.json({ ok: true, session: snapshotSession(result.session, clientId) });
  }

  if (action === "leave") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId." }, { status: 400 });
    }

    const result = await leaveSession({ code: sessionCode, clientId });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: result.status });
    }

    return NextResponse.json({ ok: true, session: snapshotSession(result.session, clientId) });
  }

  if (action === "release_role") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId." }, { status: 400 });
    }

    const result = await releaseRole({ code: sessionCode, clientId });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: result.status });
    }

    return NextResponse.json({ ok: true, session: snapshotSession(result.session, clientId) });
  }

  if (action === "control") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    if (!isRole(body.requesterRole)) {
      return NextResponse.json({ error: "Missing or invalid requesterRole." }, { status: 400 });
    }

    if (!isControlAction(body.controlAction)) {
      return NextResponse.json({ error: "Missing or invalid controlAction." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);

    const applied = await applyControl({
      code: sessionCode,
      requesterRole: body.requesterRole,
      action: body.controlAction,
      clientRevision: typeof body.controlRevision === "number" ? body.controlRevision : undefined,
      clientId: clientId || undefined,
    });

    if (!applied.ok) {
      return NextResponse.json({ error: applied.reason }, { status: applied.status });
    }

    return NextResponse.json({
      ok: true,
      session: snapshotSession(applied.session, clientId || undefined),
    });
  }

  if (action === "request_cut") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId." }, { status: 400 });
    }

    const requested = await requestCut({ code: sessionCode, clientId });
    if (!requested.ok) {
      return NextResponse.json({ error: requested.reason }, { status: requested.status });
    }

    return NextResponse.json({
      ok: true,
      cutRevision: requested.cutRevision,
      session: snapshotSession(requested.session, clientId),
    });
  }

  if (action === "ack_cut_ready") {
    const sessionCode = normalizeCode(body.sessionCode);
    if (!sessionCode) {
      return NextResponse.json({ error: "Missing sessionCode." }, { status: 400 });
    }

    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId." }, { status: 400 });
    }

    if (typeof body.cutRevision !== "number") {
      return NextResponse.json({ error: "Missing cutRevision." }, { status: 400 });
    }

    const acked = await ackCutReady({
      code: sessionCode,
      clientId,
      cutRevision: body.cutRevision,
    });

    if (!acked.ok) {
      return NextResponse.json({ error: acked.reason }, { status: acked.status });
    }

    return NextResponse.json({
      ok: true,
      session: snapshotSession(acked.session, clientId),
    });
  }

  return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
}
