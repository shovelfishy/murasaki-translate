import {
  AudioChunk,
  MultiSessionRole,
  SegmentResult,
  SessionRole,
  SessionSnapshot,
  SessionState,
} from "./types";

const SESSION_TTL_MS = 1000 * 60 * 60 * 2;
const HEARTBEAT_TIMEOUT_MS = 1000 * 15;

interface StoreShape {
  sessions: Map<string, SessionState>;
  cleanupAt: number;
}

export type ControlAction = "start" | "stop" | "listener_started" | "listener_stopped";

function getStore(): StoreShape {
  const g = globalThis as typeof globalThis & { __v1Store?: StoreShape };
  if (!g.__v1Store) {
    g.__v1Store = {
      sessions: new Map<string, SessionState>(),
      cleanupAt: 0,
    };
  }
  return g.__v1Store;
}

function makeCode(existing: Set<string>): string {
  let code = "";
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (existing.has(code));
  return code;
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

function cleanupDisconnectedClients(session: SessionState, now: number) {
  if (session.mode !== "multi") {
    return;
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
    return;
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
    return;
  }

  if (roleDropped) {
    session.lastAction = "A participant disconnected.";
  }
}

function maybeCleanupSessions() {
  const store = getStore();
  const now = Date.now();
  if (now < store.cleanupAt) {
    return;
  }

  for (const [code, session] of store.sessions.entries()) {
    cleanupDisconnectedClients(session, now);
    if (now - session.createdAt > SESSION_TTL_MS) {
      store.sessions.delete(code);
    }
  }

  store.cleanupAt = now + 1000 * 60 * 5;
}

export function createSession(params: {
  languageA: string;
  languageB: string;
  mode?: "single" | "multi";
  creatorClientId?: string;
  creatorRole?: MultiSessionRole;
}) {
  maybeCleanupSessions();
  const store = getStore();
  const code = makeCode(new Set(store.sessions.keys()));
  const now = Date.now();
  const mode = params.mode ?? "single";

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

  store.sessions.set(code, session);
  return session;
}

export function joinSession(code: string) {
  maybeCleanupSessions();
  const store = getStore();
  const session = store.sessions.get(code) ?? null;
  if (session) {
    cleanupDisconnectedClients(session, Date.now());
  }
  return session;
}

export function getSession(code: string): SessionState | null {
  maybeCleanupSessions();
  const store = getStore();
  const session = store.sessions.get(code) ?? null;
  if (session) {
    cleanupDisconnectedClients(session, Date.now());
  }
  return session;
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

export function claimRole(params: {
  code: string;
  clientId: string;
  role: MultiSessionRole;
}) {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false as const, reason: "Session not found.", status: 404 as const };
  }

  if (session.mode !== "multi") {
    return { ok: false as const, reason: "Role claim is only supported in multi mode.", status: 400 as const };
  }

  const now = Date.now();

  if (params.role === "listener" && session.listenerClientId && session.listenerClientId !== params.clientId) {
    return { ok: false as const, reason: "Listener role is already taken.", status: 409 as const };
  }

  if (params.role === "controller" && session.controllerClientId && session.controllerClientId !== params.clientId) {
    return { ok: false as const, reason: "Controller role is already taken.", status: 409 as const };
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

  session.heartbeats.set(params.clientId, now);
  session.lastAction = `${roleLabel(params.role)} joined.`;

  return { ok: true as const, session };
}

export function heartbeatSession(params: { code: string; clientId: string }) {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false as const, reason: "Session not found.", status: 404 as const };
  }

  if (session.mode !== "multi") {
    return { ok: false as const, reason: "Heartbeat is only used in multi mode.", status: 400 as const };
  }

  if (!roleForClient(session, params.clientId)) {
    return { ok: false as const, reason: "Client has no assigned role.", status: 400 as const };
  }

  session.heartbeats.set(params.clientId, Date.now());
  return { ok: true as const, session };
}

export function leaveSession(params: { code: string; clientId: string }) {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false as const, reason: "Session not found.", status: 404 as const };
  }

  if (session.mode !== "multi") {
    return { ok: false as const, reason: "Leave is only used in multi mode.", status: 400 as const };
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

  return { ok: true as const, session };
}

export function releaseRole(params: { code: string; clientId: string }) {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false as const, reason: "Session not found.", status: 404 as const };
  }

  if (session.mode !== "multi") {
    return { ok: false as const, reason: "Role release is only used in multi mode.", status: 400 as const };
  }

  const hadRole =
    session.listenerClientId === params.clientId ||
    session.controllerClientId === params.clientId ||
    session.viewerClientIds.has(params.clientId);

  if (!hadRole) {
    return { ok: false as const, reason: "Client has no assigned role.", status: 400 as const };
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

  return { ok: true as const, session };
}

export function appendChunk(params: {
  code: string;
  role: SessionRole;
  clientId?: string;
  chunk: AudioChunk;
}): { ok: true } | { ok: false; reason: string } {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false, reason: "Session not found." };
  }

  if (session.mode === "single") {
    if (params.role !== "single") {
      return { ok: false, reason: "Only single role can upload audio chunks." };
    }
  } else {
    if (params.role !== "listener") {
      return { ok: false, reason: "Only listener can upload audio chunks in multi mode." };
    }
    if (!params.clientId || session.listenerClientId !== params.clientId) {
      return { ok: false, reason: "Only the assigned listener can upload chunks." };
    }
    session.heartbeats.set(params.clientId, Date.now());
  }

  if (params.chunk.seq <= session.lastSeqReceived) {
    return { ok: true };
  }

  session.lastSeqReceived = params.chunk.seq;
  session.chunks.push(params.chunk);
  return { ok: true };
}

export function applyControl(params: {
  code: string;
  requesterRole: SessionRole;
  action: ControlAction;
  clientRevision?: number;
  clientId?: string;
}) {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false as const, reason: "Session not found.", status: 404 as const };
  }

  if (typeof params.clientRevision === "number" && params.clientRevision < session.controlRevision) {
    return { ok: false as const, reason: "Stale control command.", status: 409 as const };
  }

  if (session.mode === "single") {
    if (params.requesterRole !== "single") {
      return { ok: false as const, reason: "Only single role can control recording.", status: 403 as const };
    }
  } else {
    if (!params.clientId) {
      return { ok: false as const, reason: "Missing clientId.", status: 400 as const };
    }

    const requesterRole = roleForClient(session, params.clientId);
    if (!requesterRole || requesterRole !== params.requesterRole) {
      return { ok: false as const, reason: "Requester role is not assigned to this client.", status: 403 as const };
    }

    if (params.requesterRole !== "listener" && params.requesterRole !== "controller") {
      return { ok: false as const, reason: "Only listener/controller can control recording.", status: 403 as const };
    }

    if (!controlsReady(session)) {
      return { ok: false as const, reason: "Listener and controller are both required.", status: 409 as const };
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

  return { ok: true as const, session };
}

export function requestCut(params: { code: string; clientId: string }) {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false as const, reason: "Session not found.", status: 404 as const };
  }

  if (session.mode !== "multi") {
    return { ok: false as const, reason: "Cut request is only supported in multi mode.", status: 400 as const };
  }

  if (session.controllerClientId !== params.clientId) {
    return { ok: false as const, reason: "Only assigned controller can request cut.", status: 403 as const };
  }

  if (!controlsReady(session)) {
    return { ok: false as const, reason: "Listener and controller are both required.", status: 409 as const };
  }

//   if (session.recordingState !== "recording") {
//     return { ok: false as const, reason: "Cut is only available while recording.", status: 409 as const };
//   }

  session.heartbeats.set(params.clientId, Date.now());
  session.cutRequestRevision += 1;
  return { ok: true as const, session, cutRevision: session.cutRequestRevision };
}

export function ackCutReady(params: { code: string; clientId: string; cutRevision: number }) {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false as const, reason: "Session not found.", status: 404 as const };
  }

  if (session.mode !== "multi") {
    return { ok: false as const, reason: "Cut ack is only supported in multi mode.", status: 400 as const };
  }

  if (session.listenerClientId !== params.clientId) {
    return { ok: false as const, reason: "Only assigned listener can acknowledge cut readiness.", status: 403 as const };
  }

  if (!Number.isInteger(params.cutRevision) || params.cutRevision <= 0) {
    return { ok: false as const, reason: "Invalid cutRevision.", status: 400 as const };
  }

  session.heartbeats.set(params.clientId, Date.now());
  session.cutReadyRevision = Math.max(session.cutReadyRevision, params.cutRevision);
  return { ok: true as const, session };
}

export function beginCut(params: {
  code: string;
  requesterRole: SessionRole;
  clientId?: string;
}):
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
  | { ok: false; reason: string; status: 400 | 403 | 404 | 409 } {
  const session = getSession(params.code);
  if (!session) {
    return { ok: false, reason: "Session not found.", status: 404 };
  }

  if (session.mode === "single") {
    if (params.requesterRole !== "single") {
      return { ok: false, reason: "Only single role can trigger cut.", status: 403 };
    }
  } else {
    if (!params.clientId) {
      return { ok: false, reason: "Missing clientId.", status: 400 };
    }

    if (params.requesterRole !== "controller") {
      return { ok: false, reason: "Only controller can trigger cut in multi mode.", status: 403 };
    }

    if (session.controllerClientId !== params.clientId) {
      return { ok: false, reason: "Only assigned controller can trigger cut.", status: 403 };
    }

    if (!controlsReady(session)) {
      return { ok: false, reason: "Listener and controller are both required.", status: 409 };
    }

    if (session.recordingState !== "recording") {
      return { ok: false, reason: "Cut is only available while recording.", status: 409 };
    }

    session.heartbeats.set(params.clientId, Date.now());
  }

  if (session.processing) {
    return { ok: false, reason: "A cut is already in progress.", status: 409 };
  }

  if (session.chunks.length === 0) {
    return { ok: false, reason: "No new audio since last cut.", status: 400 };
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
    ok: true,
    segmentId,
    languageA: session.languageA,
    languageB: session.languageB,
    startedAt,
    endedAt,
    audio,
    mimeType,
    rawChunks,
  };
}

export function finishCut(params: {
  code: string;
  segment: SegmentResult;
}) {
  const session = getSession(params.code);
  if (!session) {
    return;
  }

  session.segments.push(params.segment);
  if (session.segments.length > 200) {
    session.segments = session.segments.slice(-200);
  }

  session.processing = false;
  session.lastAction = `Cut created segment ${params.segment.segmentId}.`;
}

export function failCut(code: string) {
  const session = getSession(code);
  if (!session) {
    return;
  }
  session.processing = false;
}

export function getFeed(code: string, cursor: number, clientId?: string) {
  const session = getSession(code);
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
