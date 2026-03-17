export type SessionMode = "single" | "multi";

export type SessionRole = "single" | "listener" | "controller" | "viewer";

export type MultiSessionRole = Exclude<SessionRole, "single">;

export type RecordingState = "idle" | "recording";

export interface AudioChunk {
  seq: number;
  mimeType: string;
  startedAt: number;
  endedAt: number;
  audio: Buffer;
}

export interface SegmentResult {
  segmentId: number;
  sourceText: string;
  translatedText: string;
  languageA: string;
  languageB: string;
  startedAt: number;
  endedAt: number;
  createdAt: number;
}

export interface SessionState {
  code: string;
  mode: SessionMode;
  languageA: string;
  languageB: string;
  createdAt: number;
  processing: boolean;
  chunks: AudioChunk[];
  lastSeqReceived: number;
  nextSegmentId: number;
  segments: SegmentResult[];
  recordingState: RecordingState;
  lastAction: string;
  controlRevision: number;
  cutRequestRevision: number;
  cutReadyRevision: number;
  listenerClientId: string | null;
  controllerClientId: string | null;
  viewerClientIds: Set<string>;
  heartbeats: Map<string, number>;
}

export interface SessionSnapshot {
  code: string;
  mode: SessionMode;
  languageA: string;
  languageB: string;
  processing: boolean;
  segmentsCount: number;
  assignedRole: SessionRole | null;
  recordingState: RecordingState;
  lastAction: string;
  controlRevision: number;
  cutRequestRevision: number;
  cutReadyRevision: number;
  hasListener: boolean;
  hasController: boolean;
  viewerCount: number;
  availableRoles: MultiSessionRole[];
  controlsReady: boolean;
}
