import {
  AudioChunk,
  MultiSessionRole,
  SegmentResult,
  SessionRole,
  SessionSnapshot,
  SessionState,
} from "./types";
import { redis } from "./redis";

const SESSION_TTL_MS = 1000 * 60 * 60 * 2;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const HEARTBEAT_TIMEOUT_MS = 1000 * 15;
const MUTATION_RETRY_LIMIT = 6;

export type ControlAction = "start" | "stop" | "listener_started" | "listener_stopped";

interface RedisAudioChunk {
  seq: number;
  mimeType: string;
  startedAt: number;
  endedAt: number;
  audioBase64: string;
}

interface RedisSessionState {
  version: number;
  code: string;
  mode: SessionState["mode"];
  languageA: string;
  languageB: string;
  createdAt: number;
  processing: boolean;
  chunks: RedisAudioChunk[];
  lastSeqReceived: number;
  nextSegmentId: number;
  segments: SegmentResult[];
  recordingState: SessionState["recordingState"];
  lastAction: string;
  controlRevision: number;
  cutRequestRevision: number;
  cutReadyRevision: number;
  listenerClientId: string | null;
  controllerClientId: string | null;
  viewerClientIds: string[];
  heartbeats: Record<string, number>;
}

interface SessionRecord {
  version: number;
  session: SessionState;
}

interface MutationDecision {
  write: boolean;
  result: any;
}

interface MutationSuccess {
  ok: true;
  session: SessionState;
  result: any;
}

interface MutationFailure {
  ok: false;
  missing?: true;
  conflict?: true;
}

const CAS_SET_SCRIPT = `
local key = KEYS[1]
local expected = tonumber(ARGV[1])
local payload = ARGV[2]
local ttl = tonumber(ARGV[3])

local current = redis.call("GET", key)
if not current then
  return -1
end

local decoded = cjson.decode(current)
if tonumber(decoded.version) ~= expected then
  return 0
end

redis.call("SET", key, payload, "EX", ttl)
return 1
`;

function sessionKey(code: string): string {
  return `v1:session:${code}`;
}

function inflateSession(payload: RedisSessionState): SessionState {
  return {
    code: payload.code,
    mode: payload.mode,
    languageA: payload.languageA,
    languageB: payload.languageB,
    createdAt: payload.createdAt,
    processing: payload.processing,
    chunks: payload.chunks.map((chunk) => ({
      seq: chunk.seq,
      mimeType: chunk.mimeType,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      audio: Buffer.from(chunk.audioBase64, "base64"),
    })),
    lastSeqReceived: payload.lastSeqReceived,
    nextSegmentId: payload.nextSegmentId,
    segments: payload.segments,
    recordingState: payload.recordingState,
    lastAction: payload.lastAction,
    controlRevision: payload.controlRevision,
    cutRequestRevision: payload.cutRequestRevision,
    cutReadyRevision: payload.cutReadyRevision,
    listenerClientId: payload.listenerClientId,
    controllerClientId: payload.controllerClientId,
    viewerClientIds: new Set(payload.viewerClientIds),
    heartbeats: new Map(Object.entries(payload.heartbeats)),
  };
}

function deflateSession(session: SessionState, version: number): RedisSessionState {
  return {
    version,
    code: session.code,
    mode: session.mode,
    languageA: session.languageA,
    languageB: session.languageB,
    createdAt: session.createdAt,
    processing: session.processing,
    chunks: session.chunks.map((chunk) => ({
      seq: chunk.seq,
      mimeType: chunk.mimeType,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      audioBase64: chunk.audio.toString("base64"),
    })),
    lastSeqReceived: session.lastSeqReceived,
    nextSegmentId: session.nextSegmentId,
    segments: session.segments,
    recordingState: session.recordingState,
    lastAction: session.lastAction,
    controlRevision: session.controlRevision,
    cutRequestRevision: session.cutRequestRevision,
    cutReadyRevision: session.cutReadyRevision,
    listenerClientId: session.listenerClientId,
    controllerClientId: session.controllerClientId,
    viewerClientIds: Array.from(session.viewerClientIds),
    heartbeats: Object.fromEntries(session.heartbeats),
  };
}

function parseRedisSession(raw: unknown): RedisSessionState | null {
  if (!raw) {
    return null;
  }

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as RedisSessionState;
    } catch {
      return null;
    }
  }

  if (typeof raw === "object") {
    return raw as RedisSessionState;
  }

  return null;
}

async function readSessionRecord(code: string): Promise<SessionRecord | null> {
  const raw = await redis.get(sessionKey(code));
  const parsed = parseRedisSession(raw);
  if (!parsed) {
    return null;
  }

  return {
    version: parsed.version,
    session: inflateSession(parsed),
  };
}

async function casSetSession(code: string, expectedVersion: number, session: SessionState): Promise<"ok" | "mismatch" | "missing"> {
  const payload = JSON.stringify(deflateSession(session, expectedVersion + 1));
  const result = Number(await redis.eval(CAS_SET_SCRIPT, [sessionKey(code)], [
    String(expectedVersion),
    payload,
    String(SESSION_TTL_SECONDS),
  ]));

  if (result === 1) {
    return "ok";
  }
  if (result === -1) {
    return "missing";
  }
  return "mismatch";
}

function makeCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function roleForClient(session: SessionState, clientId?: string): SessionRole | null {
  if (session.mode === "single") {
    return "single";
  }
  if (!clientId) {
    return null;
  }
  if (session.listenerClientId === clientId) {
    return "listener";
  }
  if (session.controllerClientId === clientId) {
    return "controller";
  }
  if (session.viewerClientIds.has(clientId)) {
    return "viewer";
  }
  return null;
}

function removeClientFromRoles(session: SessionState, clientId: string) {
  if (session.listenerClientId === clientId) {
    session.listenerClientId = null;
  }
  if (session.controllerClientId === clientId) {
    session.controllerClientId = null;
  }
  session.viewerClientIds.delete(clientId);
}

function getAvailableRoles(session: SessionState): MultiSessionRole[] {
  if (session.mode !== "multi") {
    return [];
  }

  const roles: MultiSessionRole[] = [];
  if (!session.listenerClientId) {
    roles.push("listener");
  }
  if (!session.controllerClientId) {
    roles.push("controller");
  }
  roles.push("viewer");
  return roles;
}

function controlsReady(session: SessionState) {
  if (session.mode === "single") {
    return true;
  }
  return Boolean(session.listenerClientId && session.controllerClientId);
}

function roleLabel(role: MultiSessionRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function cleanupDisconnectedClients(session: SessionState, now: number): boolean {
  if (session.mode !== "multi") {
    return false;
  }

  let disconnectedCriticalRole = false;
  let roleDropped = false;

  const staleClients = new Set<string>();
  for (const [clientId, lastSeen] of session.heartbeats.entries()) {
    if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
      staleClients.add(clientId);
    }
  }

  if (staleClients.size === 0) {
    return false;
  }

  for (const clientId of staleClients) {
    session.heartbeats.delete(clientId);

    if (session.listenerClientId === clientId) {
      session.listenerClientId = null;
      disconnectedCriticalRole = true;
      roleDropped = true;
    }

    if (session.controllerClientId === clientId) {
      session.controllerClientId = null;
      disconnectedCriticalRole = true;
      roleDropped = true;
    }

    if (session.viewerClientIds.delete(clientId)) {
      roleDropped = true;
    }
  }

  if (disconnectedCriticalRole && session.recordingState === "recording") {
    session.recordingState = "idle";
    session.lastAction = "Listener/controller disconnected. Recording stopped.";
    session.controlRevision += 1;
    return true;
  }

  if (roleDropped) {
    session.lastAction = "A participant disconnected.";
    return true;
  }

  return false;
}

async function readSessionWithCleanup(code: string): Promise<SessionState | null> {
  for (let i = 0; i < MUTATION_RETRY_LIMIT; i += 1) {
    const record = await readSessionRecord(code);
    if (!record) {
      return null;
    }

    const session = record.session;
    const changed = cleanupDisconnectedClients(session, Date.now());
    if (!changed) {
      return session;
    }

    const writeStatus = await casSetSession(code, record.version, session);
    if (writeStatus === "ok") {
      return session;
    }
    if (writeStatus === "missing") {
      return null;
    }
  }

  const fallback = await readSessionRecord(code);
  return fallback ? fallback.session : null;
}

async function mutateSession(
  code: string,
  mutator: (session: SessionState) => MutationDecision,
): Promise<MutationSuccess | MutationFailure> {
  for (let i = 0; i < MUTATION_RETRY_LIMIT; i += 1) {
    const record = await readSessionRecord(code);
    if (!record) {
      return { ok: false, missing: true };
    }

    const session = record.session;
    cleanupDisconnectedClients(session, Date.now());
    const decision = mutator(session);

    if (!decision.write) {
      return { ok: true, session, result: decision.result };
    }

    const writeStatus = await casSetSession(code, record.version, session);
    if (writeStatus === "ok") {
      return { ok: true, session, result: decision.result };
    }

    if (writeStatus === "missing") {
      return { ok: false, missing: true };
    }
  }

  return { ok: false, conflict: true };
}

export async function createSession(params: {
  languageA: string;
  languageB: string;
  mode?: "single" | "multi";
  creatorClientId?: string;
  creatorRole?: MultiSessionRole;
}) {
  const now = Date.now();
  const mode = params.mode ?? "single";

  for (let i = 0; i < 100; i += 1) {
    const code = makeCode();
    const session: SessionState = {
      code,
      mode,
      languageA: params.languageA,
      languageB: params.languageB,
      createdAt: now,
      processing: false,
      chunks: [],
      lastSeqReceived: -1,
      nextSegmentId: 1,
      segments: [],
      recordingState: "idle",
      lastAction: "Room created.",
      controlRevision: 0,
      cutRequestRevision: 0,
      cutReadyRevision: 0,
      listenerClientId: null,
      controllerClientId: null,
      viewerClientIds: new Set<string>(),
      heartbeats: new Map<string, number>(),
    };

    if (mode === "multi" && params.creatorClientId && params.creatorRole) {
      if (params.creatorRole === "listener") {
        session.listenerClientId = params.creatorClientId;
      }
      if (params.creatorRole === "controller") {
        session.controllerClientId = params.creatorClientId;
      }
      if (params.creatorRole === "viewer") {
        session.viewerClientIds.add(params.creatorClientId);
      }
      session.heartbeats.set(params.creatorClientId, now);
      session.lastAction = `Room created. ${roleLabel(params.creatorRole)} joined.`;
    }

    const created = await redis.set(sessionKey(code), JSON.stringify(deflateSession(session, 1)), {
      nx: true,
      ex: SESSION_TTL_SECONDS,
    });

    if (created) {
      return session;
    }
  }

  throw new Error("Failed to allocate unique session code.");
}

export async function joinSession(code: string) {
  return readSessionWithCleanup(code);
}

export async function getSession(code: string): Promise<SessionState | null> {
  return readSessionWithCleanup(code);
}

export function snapshotSession(session: SessionState, clientId?: string): SessionSnapshot {
  return {
    code: session.code,
    mode: session.mode,
    languageA: session.languageA,
    languageB: session.languageB,
    processing: session.processing,
    segmentsCount: session.segments.length,
    assignedRole: roleForClient(session, clientId),
    recordingState: session.recordingState,
    lastAction: session.lastAction,
    controlRevision: session.controlRevision,
    cutRequestRevision: session.cutRequestRevision,
    cutReadyRevision: session.cutReadyRevision,
    hasListener: Boolean(session.listenerClientId),
    hasController: Boolean(session.controllerClientId),
    viewerCount: session.viewerClientIds.size,
    availableRoles: getAvailableRoles(session),
    controlsReady: controlsReady(session),
  };
}

export async function claimRole(params: {
  code: string;
  clientId: string;
  role: MultiSessionRole;
}) {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode !== "multi") {
      return {
        write: false,
        result: { ok: false as const, reason: "Role claim is only supported in multi mode.", status: 400 as const },
      };
    }

    if (params.role === "listener" && session.listenerClientId && session.listenerClientId !== params.clientId) {
      return {
        write: false,
        result: { ok: false as const, reason: "Listener role is already taken.", status: 409 as const },
      };
    }

    if (params.role === "controller" && session.controllerClientId && session.controllerClientId !== params.clientId) {
      return {
        write: false,
        result: { ok: false as const, reason: "Controller role is already taken.", status: 409 as const },
      };
    }

    removeClientFromRoles(session, params.clientId);

    if (params.role === "listener") {
      session.listenerClientId = params.clientId;
    }
    if (params.role === "controller") {
      session.controllerClientId = params.clientId;
    }
    if (params.role === "viewer") {
      session.viewerClientIds.add(params.clientId);
    }

    session.heartbeats.set(params.clientId, Date.now());
    session.lastAction = `${roleLabel(params.role)} joined.`;

    return { write: true, result: { ok: true as const } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false as const, reason: "Session not found.", status: 404 as const };
    }
    return { ok: false as const, reason: "Concurrent update conflict.", status: 409 as const };
  }

  if (!outcome.result.ok) {
    return outcome.result;
  }

  return { ok: true as const, session: outcome.session };
}

export async function heartbeatSession(params: { code: string; clientId: string }) {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode !== "multi") {
      return {
        write: false,
        result: { ok: false as const, reason: "Heartbeat is only used in multi mode.", status: 400 as const },
      };
    }

    if (!roleForClient(session, params.clientId)) {
      return { write: false, result: { ok: false as const, reason: "Client has no assigned role.", status: 400 as const } };
    }

    session.heartbeats.set(params.clientId, Date.now());
    return { write: true, result: { ok: true as const } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false as const, reason: "Session not found.", status: 404 as const };
    }
    return { ok: false as const, reason: "Concurrent update conflict.", status: 409 as const };
  }

  if (!outcome.result.ok) {
    return outcome.result;
  }

  return { ok: true as const, session: outcome.session };
}

export async function leaveSession(params: { code: string; clientId: string }) {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode !== "multi") {
      return {
        write: false,
        result: { ok: false as const, reason: "Leave is only used in multi mode.", status: 400 as const },
      };
    }

    const wasListener = session.listenerClientId === params.clientId;
    const wasController = session.controllerClientId === params.clientId;
    const hadViewer = session.viewerClientIds.has(params.clientId);

    removeClientFromRoles(session, params.clientId);
    session.heartbeats.delete(params.clientId);

    if ((wasListener || wasController) && session.recordingState === "recording") {
      session.recordingState = "idle";
      session.lastAction = "Listener/controller disconnected. Recording stopped.";
      session.controlRevision += 1;
    } else if (wasListener || wasController || hadViewer) {
      session.lastAction = "A participant left the room.";
    }

    return { write: true, result: { ok: true as const } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false as const, reason: "Session not found.", status: 404 as const };
    }
    return { ok: false as const, reason: "Concurrent update conflict.", status: 409 as const };
  }

  if (!outcome.result.ok) {
    return outcome.result;
  }

  return { ok: true as const, session: outcome.session };
}

export async function releaseRole(params: { code: string; clientId: string }) {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode !== "multi") {
      return {
        write: false,
        result: { ok: false as const, reason: "Role release is only used in multi mode.", status: 400 as const },
      };
    }

    const hadRole =
      session.listenerClientId === params.clientId ||
      session.controllerClientId === params.clientId ||
      session.viewerClientIds.has(params.clientId);

    if (!hadRole) {
      return { write: false, result: { ok: false as const, reason: "Client has no assigned role.", status: 400 as const } };
    }

    const wasCriticalRole = session.listenerClientId === params.clientId || session.controllerClientId === params.clientId;

    removeClientFromRoles(session, params.clientId);
    session.heartbeats.delete(params.clientId);

    if (wasCriticalRole && session.recordingState === "recording") {
      session.recordingState = "idle";
      session.lastAction = "Listener/controller disconnected. Recording stopped.";
      session.controlRevision += 1;
    } else {
      session.lastAction = "Role released.";
    }

    return { write: true, result: { ok: true as const } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false as const, reason: "Session not found.", status: 404 as const };
    }
    return { ok: false as const, reason: "Concurrent update conflict.", status: 409 as const };
  }

  if (!outcome.result.ok) {
    return outcome.result;
  }

  return { ok: true as const, session: outcome.session };
}

export async function appendChunk(params: {
  code: string;
  role: SessionRole;
  clientId?: string;
  chunk: AudioChunk;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode === "single") {
      if (params.role !== "single") {
        return { write: false, result: { ok: false as const, reason: "Only single role can upload audio chunks." } };
      }
    } else {
      if (params.role !== "listener") {
        return { write: false, result: { ok: false as const, reason: "Only listener can upload audio chunks in multi mode." } };
      }
      if (!params.clientId || session.listenerClientId !== params.clientId) {
        return { write: false, result: { ok: false as const, reason: "Only the assigned listener can upload chunks." } };
      }
      session.heartbeats.set(params.clientId, Date.now());
    }

    if (params.chunk.seq <= session.lastSeqReceived) {
      return { write: false, result: { ok: true as const } };
    }

    session.lastSeqReceived = params.chunk.seq;
    session.chunks.push(params.chunk);
    return { write: true, result: { ok: true as const } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false, reason: "Session not found." };
    }
    return { ok: false, reason: "Concurrent update conflict." };
  }

  return outcome.result;
}

export async function applyControl(params: {
  code: string;
  requesterRole: SessionRole;
  action: ControlAction;
  clientRevision?: number;
  clientId?: string;
}) {
  const outcome = await mutateSession(params.code, (session) => {
    if (typeof params.clientRevision === "number" && params.clientRevision < session.controlRevision) {
      return { write: false, result: { ok: false as const, reason: "Stale control command.", status: 409 as const } };
    }

    if (session.mode === "single") {
      if (params.requesterRole !== "single") {
        return { write: false, result: { ok: false as const, reason: "Only single role can control recording.", status: 403 as const } };
      }
    } else {
      if (!params.clientId) {
        return { write: false, result: { ok: false as const, reason: "Missing clientId.", status: 400 as const } };
      }

      const requesterRole = roleForClient(session, params.clientId);
      if (!requesterRole || requesterRole !== params.requesterRole) {
        return {
          write: false,
          result: { ok: false as const, reason: "Requester role is not assigned to this client.", status: 403 as const },
        };
      }

      if (params.requesterRole !== "listener" && params.requesterRole !== "controller") {
        return {
          write: false,
          result: { ok: false as const, reason: "Only listener/controller can control recording.", status: 403 as const },
        };
      }

      if (!controlsReady(session)) {
        return {
          write: false,
          result: { ok: false as const, reason: "Listener and controller are both required.", status: 409 as const },
        };
      }

      session.heartbeats.set(params.clientId, Date.now());
    }

    let changed = false;
    if (params.action === "start" || params.action === "listener_started") {
      if (session.recordingState !== "recording") {
        session.recordingState = "recording";
        session.lastAction = "Recording started.";
        changed = true;
      }
    }

    if (params.action === "stop" || params.action === "listener_stopped") {
      if (session.recordingState !== "idle") {
        session.recordingState = "idle";
        session.lastAction = "Recording stopped.";
        changed = true;
      }
    }

    if (changed) {
      session.controlRevision += 1;
    }

    return { write: true, result: { ok: true as const } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false as const, reason: "Session not found.", status: 404 as const };
    }
    return { ok: false as const, reason: "Concurrent update conflict.", status: 409 as const };
  }

  if (!outcome.result.ok) {
    return outcome.result;
  }

  return { ok: true as const, session: outcome.session };
}

export async function requestCut(params: { code: string; clientId: string }) {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode !== "multi") {
      return {
        write: false,
        result: { ok: false as const, reason: "Cut request is only supported in multi mode.", status: 400 as const },
      };
    }

    if (session.controllerClientId !== params.clientId) {
      return { write: false, result: { ok: false as const, reason: "Only assigned controller can request cut.", status: 403 as const } };
    }

    if (!controlsReady(session)) {
      return {
        write: false,
        result: { ok: false as const, reason: "Listener and controller are both required.", status: 409 as const },
      };
    }

    session.heartbeats.set(params.clientId, Date.now());
    session.cutRequestRevision += 1;
    return { write: true, result: { ok: true as const, cutRevision: session.cutRequestRevision } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false as const, reason: "Session not found.", status: 404 as const };
    }
    return { ok: false as const, reason: "Concurrent update conflict.", status: 409 as const };
  }

  if (!outcome.result.ok) {
    return outcome.result;
  }

  return { ok: true as const, session: outcome.session, cutRevision: outcome.result.cutRevision };
}

export async function ackCutReady(params: { code: string; clientId: string; cutRevision: number }) {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode !== "multi") {
      return { write: false, result: { ok: false as const, reason: "Cut ack is only supported in multi mode.", status: 400 as const } };
    }

    if (session.listenerClientId !== params.clientId) {
      return {
        write: false,
        result: { ok: false as const, reason: "Only assigned listener can acknowledge cut readiness.", status: 403 as const },
      };
    }

    if (!Number.isInteger(params.cutRevision) || params.cutRevision <= 0) {
      return { write: false, result: { ok: false as const, reason: "Invalid cutRevision.", status: 400 as const } };
    }

    session.heartbeats.set(params.clientId, Date.now());
    session.cutReadyRevision = Math.max(session.cutReadyRevision, params.cutRevision);
    return { write: true, result: { ok: true as const } };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false as const, reason: "Session not found.", status: 404 as const };
    }
    return { ok: false as const, reason: "Concurrent update conflict.", status: 409 as const };
  }

  if (!outcome.result.ok) {
    return outcome.result;
  }

  return { ok: true as const, session: outcome.session };
}

export async function beginCut(params: {
  code: string;
  requesterRole: SessionRole;
  clientId?: string;
}): Promise<
  | {
      ok: true;
      segmentId: number;
      languageA: string;
      languageB: string;
      startedAt: number;
      endedAt: number;
      audio: Buffer;
      mimeType: string;
      rawChunks: Array<{
        audio: Buffer;
        mimeType: string;
        startedAt: number;
        endedAt: number;
      }>;
    }
  | { ok: false; reason: string; status: 400 | 403 | 404 | 409 }
> {
  const outcome = await mutateSession(params.code, (session) => {
    if (session.mode === "single") {
      if (params.requesterRole !== "single") {
        return { write: false, result: { ok: false as const, reason: "Only single role can trigger cut.", status: 403 as const } };
      }
    } else {
      if (!params.clientId) {
        return { write: false, result: { ok: false as const, reason: "Missing clientId.", status: 400 as const } };
      }

      if (params.requesterRole !== "controller") {
        return {
          write: false,
          result: { ok: false as const, reason: "Only controller can trigger cut in multi mode.", status: 403 as const },
        };
      }

      if (session.controllerClientId !== params.clientId) {
        return { write: false, result: { ok: false as const, reason: "Only assigned controller can trigger cut.", status: 403 as const } };
      }

      if (!controlsReady(session)) {
        return {
          write: false,
          result: { ok: false as const, reason: "Listener and controller are both required.", status: 409 as const },
        };
      }

      if (session.recordingState !== "recording") {
        return { write: false, result: { ok: false as const, reason: "Cut is only available while recording.", status: 409 as const } };
      }

      session.heartbeats.set(params.clientId, Date.now());
    }

    if (session.processing) {
      return { write: false, result: { ok: false as const, reason: "A cut is already in progress.", status: 409 as const } };
    }

    if (session.chunks.length === 0) {
      return { write: false, result: { ok: false as const, reason: "No new audio since last cut.", status: 400 as const } };
    }

    session.processing = true;

    const selected = session.chunks;
    session.chunks = [];

    const segmentId = session.nextSegmentId;
    session.nextSegmentId += 1;

    const startedAt = selected[0].startedAt;
    const endedAt = selected[selected.length - 1].endedAt;
    const mimeType = selected[selected.length - 1].mimeType;
    const audio = Buffer.concat(selected.map((item) => item.audio));
    const rawChunks = selected.map((item) => ({
      audio: item.audio,
      mimeType: item.mimeType,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
    }));

    return {
      write: true,
      result: {
        ok: true as const,
        segmentId,
        languageA: session.languageA,
        languageB: session.languageB,
        startedAt,
        endedAt,
        audio,
        mimeType,
        rawChunks,
      },
    };
  });

  if (!outcome.ok) {
    if (outcome.missing) {
      return { ok: false, reason: "Session not found.", status: 404 };
    }
    return { ok: false, reason: "Concurrent update conflict.", status: 409 };
  }

  return outcome.result;
}

export async function finishCut(params: { code: string; segment: SegmentResult }) {
  await mutateSession(params.code, (session) => {
    session.segments.push(params.segment);
    if (session.segments.length > 200) {
      session.segments = session.segments.slice(-200);
    }

    session.processing = false;
    session.lastAction = `Cut created segment ${params.segment.segmentId}.`;

    return { write: true, result: true };
  });
}

export async function failCut(code: string) {
  await mutateSession(code, (session) => {
    session.processing = false;
    return { write: true, result: true };
  });
}

export async function getFeed(code: string, cursor: number, clientId?: string) {
  const session = await getSession(code);
  if (!session) {
    return null;
  }

  const safeCursor = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;
  const next = session.segments.slice(safeCursor);

  return {
    session: snapshotSession(session, clientId),
    segments: next,
    nextCursor: safeCursor + next.length,
  };
}
