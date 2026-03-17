"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    MultiSessionRole,
    SegmentResult,
    SessionRole,
    SessionSnapshot,
} from "@/lib/v1/types";
import { useThemeMode } from "../../use-theme-mode";

function pickMime() {
    const types = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
    ];
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function formatClock(ms: number) {
    return new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function durationLabel(startedAt: number, endedAt: number) {
    const total = Math.max(0, endedAt - startedAt);
    return `${(total / 1000).toFixed(1)}s`;
}

function makeClientId() {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunkSize = 0x8000;
    let binary = "";

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

async function readJson<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
}

function roleLabel(role: SessionRole | MultiSessionRole | null) {
    if (!role) {
        return "Unassigned";
    }
    return role.charAt(0).toUpperCase() + role.slice(1);
}

const NO_NEW_AUDIO_REASON = "No new audio since last cut.";

interface PendingCutDeferred {
    allowNoAudio: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
}

export default function SessionPage() {
    const { theme, toggleTheme } = useThemeMode();
    const params = useParams<{ code: string | string[] }>();
    const searchParams = useSearchParams();
    const feedRef = useRef<HTMLDivElement | null>(null);

    const requestedMode =
        searchParams.get("mode") === "multi" ? "multi" : "single";
    const requestedClientId = searchParams.get("clientId")?.trim() ?? "";

    const [session, setSession] = useState<SessionSnapshot | null>(null);
    const [segments, setSegments] = useState<SegmentResult[]>([]);
    const [status, setStatus] = useState<string>("Connecting...");
    const [error, setError] = useState<string>("");
    const [recordingLocal, setRecordingLocal] = useState<boolean>(false);
    const [cutPending, setCutPending] = useState<boolean>(false);
    const [showRolePopup, setShowRolePopup] = useState<boolean>(false);
    const [roleClaimPending, setRoleClaimPending] = useState<boolean>(false);
    const [roleClaimError, setRoleClaimError] = useState<string>("");

    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const seqRef = useRef<number>(0);
    const chunkStartRef = useRef<number>(Date.now());
    const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
    const cursorRef = useRef<number>(0);
    const cutInFlightRef = useRef<boolean>(false);
    const lastHandledCutRequestRef = useRef<number>(0);
    const pendingControllerCutRevisionRef = useRef<number | null>(null);
    const pendingCutDeferredRef = useRef<PendingCutDeferred | null>(null);

    const sessionCode = useMemo(() => {
        if (Array.isArray(params.code)) {
            return params.code[0] ?? "";
        }
        return params.code ?? "";
    }, [params.code]);

    const activeMode = session?.mode ?? requestedMode;

    const clientId = useMemo(() => {
        if (activeMode !== "multi") {
            return requestedClientId || makeClientId();
        }

        if (!sessionCode) {
            return requestedClientId || makeClientId();
        }

        const storageKey = `v1:clientId:${sessionCode}`;
        if (requestedClientId) {
            if (typeof window !== "undefined") {
                try {
                    window.localStorage.setItem(storageKey, requestedClientId);
                } catch {
                    // Ignore storage access errors and continue with in-memory value.
                }
            }
            return requestedClientId;
        }

        if (typeof window !== "undefined") {
            try {
                const storedClientId =
                    window.localStorage.getItem(storageKey)?.trim() ?? "";
                if (storedClientId) {
                    return storedClientId;
                }

                const generatedClientId = makeClientId();
                window.localStorage.setItem(storageKey, generatedClientId);
                return generatedClientId;
            } catch {
                return makeClientId();
            }
        }

        return makeClientId();
    }, [activeMode, requestedClientId, sessionCode]);

    const activeRole = useMemo<SessionRole | null>(() => {
        if (activeMode === "single") {
            return "single";
        }
        return session?.assignedRole ?? null;
    }, [activeMode, session?.assignedRole]);

    const controlsReady = session?.controlsReady ?? activeMode === "single";

    const uploadChunk = useCallback(
        async (
            blob: Blob,
            startedAt: number,
            endedAt: number,
            mimeType: string,
            seq: number,
        ) => {
            const audioBase64 = await blobToBase64(blob);
            const roleForChunk: SessionRole =
                activeMode === "multi" ? "listener" : "single";
            const response = await fetch("/api/v1/chunk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionCode,
                    role: roleForChunk,
                    clientId: activeMode === "multi" ? clientId : undefined,
                    seq,
                    mimeType,
                    audioBase64,
                    startedAt,
                    endedAt,
                }),
            });

            if (!response.ok) {
                const data = await readJson<{ error?: string }>(response);
                throw new Error(data.error || "Chunk upload failed.");
            }
        },
        [activeMode, clientId, sessionCode],
    );

    const attachRecorderHandlers = useCallback(
        (recorder: MediaRecorder, fallbackMime: string) => {
            recorder.ondataavailable = (event: BlobEvent) => {
                if (!event.data || event.data.size === 0) {
                    return;
                }

                const startedAt = chunkStartRef.current;
                const endedAt = Date.now();
                chunkStartRef.current = endedAt;
                const seq = seqRef.current;
                seqRef.current += 1;

                uploadQueueRef.current = uploadQueueRef.current
                    .then(() =>
                        uploadChunk(
                            event.data,
                            startedAt,
                            endedAt,
                            event.data.type || fallbackMime,
                            seq,
                        ),
                    )
                    .catch((err) => {
                        const message =
                            err instanceof Error
                                ? err.message
                                : "Chunk upload failed.";
                        setError(message);
                    });
            };
        },
        [uploadChunk],
    );

    const startLocalRecorderOnly = useCallback(async () => {
        if (recordingLocal) {
            return;
        }

        const stream =
            streamRef.current ??
            (await navigator.mediaDevices.getUserMedia({ audio: true }));
        streamRef.current = stream;

        const mimeType = pickMime();
        const recorder = new MediaRecorder(
            stream,
            mimeType ? { mimeType } : undefined,
        );
        attachRecorderHandlers(recorder, mimeType);

        recorderRef.current = recorder;
        chunkStartRef.current = Date.now();
        recorder.start(1000);
        setRecordingLocal(true);
    }, [attachRecorderHandlers, recordingLocal]);

    const stopLocalRecorderOnly = useCallback(() => {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.stop();
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
        }

        recorderRef.current = null;
        streamRef.current = null;
        setRecordingLocal(false);
    }, []);

    const rollRecorderBoundaryForCut = useCallback(async () => {
        const activeRecorder = recorderRef.current;
        const stream = streamRef.current;
        if (
            !activeRecorder ||
            !stream ||
            activeRecorder.state !== "recording"
        ) {
            return;
        }

        const mimeType = pickMime();

        await new Promise<void>((resolve, reject) => {
            activeRecorder.addEventListener(
                "stop",
                () => {
                    try {
                        const nextRecorder = new MediaRecorder(
                            stream,
                            mimeType ? { mimeType } : undefined,
                        );
                        attachRecorderHandlers(nextRecorder, mimeType);
                        recorderRef.current = nextRecorder;
                        chunkStartRef.current = Date.now();
                        nextRecorder.start(1000);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                },
                { once: true },
            );

            activeRecorder.stop();
        });
    }, [attachRecorderHandlers]);

    const waitForUploadQueue = useCallback(async () => {
        try {
            await uploadQueueRef.current;
        } catch {
            // Errors are already reflected in state.
        }
    }, []);

    const requestCut = useCallback(
        async (options?: {
            allowNoAudio?: boolean;
            propagateError?: boolean;
        }) => {
            const allowNoAudio = Boolean(options?.allowNoAudio);
            const propagateError = Boolean(options?.propagateError);

            const fail = (error: unknown, fallback: string) => {
                const normalized =
                    error instanceof Error ? error : new Error(fallback);
                setError(normalized.message);
                if (propagateError) {
                    throw normalized;
                }
            };

            if (cutInFlightRef.current || !activeRole) {
                return;
            }

            cutInFlightRef.current = true;
            setCutPending(true);
            setError("");
            const appendSegment = (segment?: SegmentResult) => {
                if (!segment) {
                    return;
                }
                setSegments((prev) => {
                    if (
                        prev.some(
                            (item) => item.segmentId === segment.segmentId,
                        )
                    ) {
                        return prev;
                    }
                    return [...prev, segment];
                });
            };

            const runCutApi = async (requesterRole: SessionRole) => {
                const response = await fetch("/api/v1/cut", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        sessionCode,
                        requesterRole,
                        clientId: activeMode === "multi" ? clientId : undefined,
                    }),
                });

                const data = await readJson<{
                    ok: boolean;
                    reason?: string;
                    segment?: SegmentResult;
                }>(response);
                if (!response.ok || !data.ok) {
                    throw new Error(data.reason || "Cut failed.");
                }

                appendSegment(data.segment);
                setStatus("Cut completed.");
            };

            if (activeMode === "multi" && activeRole === "controller") {
                try {
                    if (
                        pendingControllerCutRevisionRef.current ||
                        pendingCutDeferredRef.current
                    ) {
                        throw new Error("A cut is already in progress.");
                    }

                    const response = await fetch("/api/v1/session", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            action: "request_cut",
                            sessionCode,
                            clientId,
                        }),
                    });

                    const data = await readJson<{
                        ok?: boolean;
                        error?: string;
                        cutRevision?: number;
                        session?: SessionSnapshot;
                    }>(response);

                    if (!response.ok || !data.cutRevision) {
                        throw new Error(data.error || "Failed to request cut.");
                    }

                    const completion = new Promise<void>((resolve, reject) => {
                        pendingCutDeferredRef.current = {
                            allowNoAudio,
                            resolve,
                            reject,
                        };
                    });

                    if (data.session) {
                        setSession(data.session);
                    }
                    pendingControllerCutRevisionRef.current = data.cutRevision;
                    setStatus("Waiting for listener audio flush...");
                    await completion;
                } catch (err) {
                    pendingControllerCutRevisionRef.current = null;
                    pendingCutDeferredRef.current = null;
                    setCutPending(false);
                    cutInFlightRef.current = false;
                    fail(err, "Cut failed.");
                }
                return;
            }

            try {
                if (recorderRef.current?.state === "recording") {
                    await rollRecorderBoundaryForCut();
                }

                await waitForUploadQueue();
                await runCutApi(activeRole);
            } catch (err) {
                fail(err, "Cut failed.");
            } finally {
                setCutPending(false);
                cutInFlightRef.current = false;
            }
        },
        [
            activeMode,
            activeRole,
            clientId,
            rollRecorderBoundaryForCut,
            sessionCode,
            waitForUploadQueue,
        ],
    );
    const startRecordingAction = useCallback(async () => {
        if (!activeRole) {
            return;
        }

        setError("");

        try {
            if (activeRole === "single" || activeRole === "listener") {
                await startLocalRecorderOnly();
            }

            const response = await fetch("/api/v1/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "control",
                    sessionCode,
                    requesterRole: activeRole,
                    clientId: activeMode === "multi" ? clientId : undefined,
                    controlAction: "start",
                }),
            });

            if (!response.ok) {
                const data = await readJson<{ error?: string }>(response);
                throw new Error(data.error || "Failed to start recording.");
            }
        } catch (err) {
            if (activeRole === "single" || activeRole === "listener") {
                stopLocalRecorderOnly();
            }
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to start recording.",
            );
        }
    }, [
        activeMode,
        activeRole,
        clientId,
        sessionCode,
        startLocalRecorderOnly,
        stopLocalRecorderOnly,
    ]);

    const stopRecordingAction = useCallback(async () => {
        if (!activeRole) {
            return;
        }

        setError("");

        if (activeMode === "multi" && activeRole === "controller") {
            try {
                await requestCut({ allowNoAudio: true, propagateError: true });
            } catch {
                return;
            }
        }

        if (activeRole === "single" || activeRole === "listener") {
            stopLocalRecorderOnly();
        }

        const response = await fetch("/api/v1/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "control",
                sessionCode,
                requesterRole: activeRole,
                clientId: activeMode === "multi" ? clientId : undefined,
                controlAction: "stop",
            }),
        });

        if (!response.ok) {
            const data = await readJson<{ error?: string }>(response);
            setError(data.error || "Failed to stop recording.");
            return;
        }

        if (activeMode === "single") {
            await requestCut();
        }
    }, [
        activeMode,
        activeRole,
        clientId,
        requestCut,
        sessionCode,
        stopLocalRecorderOnly,
    ]);

    const claimRole = useCallback(
        async (role: MultiSessionRole) => {
            if (activeMode !== "multi") {
                return;
            }

            setRoleClaimError("");
            setRoleClaimPending(true);

            try {
                const response = await fetch("/api/v1/session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "claim_role",
                        sessionCode,
                        clientId,
                        desiredRole: role,
                    }),
                });

                const data = await readJson<{
                    session?: SessionSnapshot;
                    error?: string;
                }>(response);
                if (!response.ok || !data.session) {
                    throw new Error(data.error || "Role assignment failed.");
                }

                setSession(data.session);
                setShowRolePopup(false);
                setStatus(`Role assigned: ${roleLabel(role)}.`);
            } catch (err) {
                setRoleClaimError(
                    err instanceof Error
                        ? err.message
                        : "Role assignment failed.",
                );
                setShowRolePopup(true);
            } finally {
                setRoleClaimPending(false);
            }
        },
        [activeMode, clientId, sessionCode],
    );

    const openRolePicker = useCallback(async () => {
        if (activeMode !== "multi") {
            return;
        }

        setRoleClaimError("");
        setRoleClaimPending(true);

        try {
            const response = await fetch("/api/v1/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "release_role",
                    sessionCode,
                    clientId,
                }),
            });

            const data = await readJson<{
                session?: SessionSnapshot;
                error?: string;
            }>(response);
            if (!response.ok || !data.session) {
                throw new Error(data.error || "Failed to release role.");
            }

            setSession(data.session);
            setShowRolePopup(true);
            setStatus("Role released. Choose a new role.");
        } catch (err) {
            setRoleClaimError(
                err instanceof Error ? err.message : "Failed to release role.",
            );
            setShowRolePopup(true);
        } finally {
            setRoleClaimPending(false);
        }
    }, [activeMode, clientId, sessionCode]);

    useEffect(() => {
        if (!sessionCode) {
            return;
        }

        let cancelled = false;

        async function joinRoom() {
            try {
                const response = await fetch("/api/v1/session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "join",
                        sessionCode,
                        clientId: activeMode === "multi" ? clientId : undefined,
                    }),
                });

                const data = await readJson<{
                    session?: SessionSnapshot;
                    error?: string;
                }>(response);
                if (!response.ok || !data.session) {
                    throw new Error(data.error || "Unable to join room.");
                }

                if (!cancelled) {
                    setSession(data.session);
                    setStatus(
                        data.session.lastAction || `Room ${sessionCode} ready.`,
                    );
                    setShowRolePopup(
                        data.session.mode === "multi" &&
                            !data.session.assignedRole,
                    );
                }
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Unable to join room.",
                    );
                }
            }
        }

        joinRoom();
        return () => {
            cancelled = true;
        };
    }, [activeMode, clientId, sessionCode]);

    useEffect(() => {
        if (!sessionCode) {
            return;
        }

        const controller = new AbortController();

        async function pullFeed() {
            try {
                const url = new URL("/api/v1/feed", window.location.origin);
                url.searchParams.set("sessionCode", sessionCode);
                url.searchParams.set("cursor", String(cursorRef.current));
                if (activeMode === "multi") {
                    url.searchParams.set("clientId", clientId);
                }

                const res = await fetch(url.toString(), {
                    signal: controller.signal,
                    cache: "no-store",
                });

                if (!res.ok) {
                    return;
                }

                const data = await readJson<{
                    session: SessionSnapshot;
                    segments: SegmentResult[];
                    nextCursor: number;
                }>(res);

                setSession(data.session);
                setStatus(data.session.lastAction || "Room synced.");
                cursorRef.current = data.nextCursor;

                setShowRolePopup(
                    data.session.mode === "multi" && !data.session.assignedRole,
                );

                if (
                    data.session.mode === "multi" &&
                    data.session.assignedRole === "listener" &&
                    data.session.cutRequestRevision >
                        lastHandledCutRequestRef.current
                ) {
                    const requestedRevision = data.session.cutRequestRevision;
                    lastHandledCutRequestRef.current = requestedRevision;

                    try {
                        if (recorderRef.current?.state === "recording") {
                            await rollRecorderBoundaryForCut();
                        }
                        await waitForUploadQueue();

                        const ackResponse = await fetch("/api/v1/session", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                action: "ack_cut_ready",
                                sessionCode,
                                clientId,
                                cutRevision: requestedRevision,
                            }),
                        });
                        if (!ackResponse.ok) {
                            const ackData = await readJson<{ error?: string }>(
                                ackResponse,
                            );
                            throw new Error(
                                ackData.error ||
                                    "Failed to acknowledge cut readiness.",
                            );
                        }
                    } catch (err) {
                        lastHandledCutRequestRef.current =
                            requestedRevision - 1;
                        setError(
                            err instanceof Error
                                ? err.message
                                : "Listener cut flush failed.",
                        );
                    }
                }

                if (
                    data.session.mode === "multi" &&
                    data.session.assignedRole === "controller" &&
                    pendingControllerCutRevisionRef.current &&
                    data.session.cutReadyRevision >=
                        pendingControllerCutRevisionRef.current
                ) {
                    const readyRevision =
                        pendingControllerCutRevisionRef.current;
                    const deferred = pendingCutDeferredRef.current;
                    pendingControllerCutRevisionRef.current = null;
                    pendingCutDeferredRef.current = null;

                    try {
                        const cutResponse = await fetch("/api/v1/cut", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                sessionCode,
                                requesterRole: "controller",
                                clientId,
                            }),
                        });

                        const cutData = await readJson<{
                            ok: boolean;
                            reason?: string;
                            segment?: SegmentResult;
                        }>(cutResponse);
                        if (!cutResponse.ok || !cutData.ok) {
                            const reason = cutData.reason || "Cut failed.";
                            if (
                                deferred?.allowNoAudio &&
                                reason === NO_NEW_AUDIO_REASON
                            ) {
                                setStatus(
                                    "Recording stopped. No remaining audio to transcribe.",
                                );
                                deferred.resolve();
                                return;
                            }
                            throw new Error(reason);
                        }

                        if (cutData.segment) {
                            setSegments((prev) => {
                                if (
                                    prev.some(
                                        (item) =>
                                            item.segmentId ===
                                            cutData.segment!.segmentId,
                                    )
                                ) {
                                    return prev;
                                }
                                return [...prev, cutData.segment!];
                            });
                        }

                        setStatus(`Cut completed (rev ${readyRevision}).`);
                        deferred?.resolve();
                    } catch (err) {
                        const normalized =
                            err instanceof Error
                                ? err
                                : new Error("Cut failed.");
                        setError(normalized.message);
                        deferred?.reject(normalized);
                    } finally {
                        setCutPending(false);
                        cutInFlightRef.current = false;
                    }
                }

                if (data.segments.length > 0) {
                    setSegments((prev) => {
                        const existing = new Set(
                            prev.map((item) => item.segmentId),
                        );
                        const next = data.segments.filter(
                            (item) => !existing.has(item.segmentId),
                        );
                        if (next.length === 0) {
                            return prev;
                        }
                        return [...prev, ...next];
                    });
                }
            } catch {
                // Polling retries.
            }
        }

        pullFeed();
        const timer = window.setInterval(pullFeed, 1200);

        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, [
        activeMode,
        clientId,
        rollRecorderBoundaryForCut,
        sessionCode,
        waitForUploadQueue,
    ]);

    useEffect(() => {
        if (activeMode !== "multi" || !clientId || !activeRole) {
            return;
        }

        let cancelled = false;

        async function sendHeartbeat() {
            if (cancelled) {
                return;
            }
            await fetch("/api/v1/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "heartbeat",
                    sessionCode,
                    clientId,
                }),
            }).catch(() => {
                // No-op. Polling will reflect role loss if timeout occurs.
            });
        }

        sendHeartbeat();
        const timer = window.setInterval(sendHeartbeat, 5000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [activeMode, activeRole, clientId, sessionCode]);

    useEffect(() => {
        const feed = feedRef.current;
        if (!feed) {
            return;
        }
        feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
    }, [segments.length]);

    useEffect(() => {
        if (activeMode !== "multi") {
            return;
        }

        if (activeRole !== "listener" && recordingLocal) {
            stopLocalRecorderOnly();
            return;
        }

        if (
            activeRole === "listener" &&
            session?.recordingState === "recording" &&
            !recordingLocal
        ) {
            void startLocalRecorderOnly().catch((err) => {
                setError(
                    err instanceof Error
                        ? err.message
                        : "Microphone access failed.",
                );
            });
        }

        if (
            activeRole === "listener" &&
            session?.recordingState === "idle" &&
            recordingLocal
        ) {
            stopLocalRecorderOnly();
        }
    }, [
        activeMode,
        activeRole,
        recordingLocal,
        session?.recordingState,
        startLocalRecorderOnly,
        stopLocalRecorderOnly,
    ]);

    useEffect(() => {
        return () => {
            stopLocalRecorderOnly();
        };
    }, [stopLocalRecorderOnly]);

    const canOperate =
        activeRole === "single" ||
        activeRole === "listener" ||
        activeRole === "controller";
    const hasRecording =
        activeMode === "single"
            ? recordingLocal
            : session?.recordingState === "recording";
    const currentRoleLabel =
        activeMode === "single" ? "Single" : roleLabel(activeRole);
    const handshakeInProgress =
        activeMode === "multi" &&
        Boolean(
            session && session.cutRequestRevision > session.cutReadyRevision,
        );
    const processingInProgress = session?.processing === true;
    const roomCutting = handshakeInProgress || processingInProgress;
    const isCutting = cutPending || roomCutting;
    const canStartStop = Boolean(canOperate && controlsReady && !cutPending);
    const canCut =
        activeMode === "single"
            ? Boolean(recordingLocal && !isCutting)
            : Boolean(
                  activeRole === "controller" &&
                  controlsReady &&
                  hasRecording &&
                  !isCutting,
              );

    return (
        <main className="min-h-screen px-4 py-6 text-[var(--fg)] sm:px-8">
            <section className="mx-auto max-w-5xl rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-soft)] p-3 sm:p-4">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--accent)]">
                            Room
                        </p>
                        <h1 className="font-display text-2xl text-[var(--fg)] sm:text-3xl">
                            {sessionCode}
                        </h1>
                        <div className="mt-2 flex items-center gap-2">
                            <span className="inline-flex h-7 items-center rounded-lg border border-[var(--accent)] px-4 py-4 text-base font-semibold text-[var(--accent)]">
                                {currentRoleLabel}
                            </span>
                            {activeMode === "multi" && session && (
                                // <Button
                                //   type="button"
                                //   variant="outline"
                                //   onClick={() => {
                                //     void openRolePicker();
                                //   }}
                                //   disabled={roleClaimPending || showRolePopup}
                                //   className="h-7 rounded-lg px-2 text-xs"
                                // >
                                //   Change Role
                                // </Button>
                                <button
                                    onClick={() => {
                                        void openRolePicker();
                                    }}
                                    disabled={roleClaimPending || showRolePopup}
                                    className="px-4 py-2 rounded-full px-2 text-xs bg-black/20 hover:bg-black/30 transition"
                                >
                                    Change Role
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={toggleTheme}>
                            {theme === "light" ? "Dark" : "Light"}
                        </Button>
                        <Link
                            href="/v1"
                            className="inline-flex h-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--fg)] transition hover:border-[var(--accent)]"
                        >
                            Exit
                        </Link>
                    </div>
                </div>

                <div className="mb-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-soft)] p-3 text-sm text-[var(--muted)] flex gap-x-8 flex-wrap">
                    <div>
                        Language:{" "}
                        <span className="font-semibold text-[var(--fg)]">
                            {session?.languageA ?? "-"}
                        </span>{" "}
                        /{" "}
                        <span className="font-semibold text-[var(--fg)]">
                            {session?.languageB ?? "-"}
                        </span>
                    </div>
                    {activeMode === "multi" && (
                        <div className="inline-flex items-center gap-5">
                            <span className="inline-flex items-center gap-2">
                                Listener
                                <span
                                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                                        session?.hasListener
                                            ? "bg-emerald-500"
                                            : "bg-red-500"
                                    }`}
                                />
                            </span>
                            <span className="inline-flex items-center gap-2">
                                Controller
                                <span
                                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                                        session?.hasController
                                            ? "bg-emerald-500"
                                            : "bg-red-500"
                                    }`}
                                />
                            </span>
                            <span>Viewers: {session?.viewerCount ?? 0}</span>
                        </div>
                    )}
                </div>

                <div className="flex h-[74vh] min-h-[500px] flex-col rounded-3xl border border-[var(--border)] bg-[var(--surface-soft)]">
                    <div
                        ref={feedRef}
                        className="flex-1 overflow-y-auto p-3 sm:p-4"
                    >
                        <div className="space-y-3">
                            {segments.length === 0 ? (
                                <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)]">
                                    Waiting for transcripts. Start recording,
                                    then cut segments.
                                </div>
                            ) : (
                                [...segments]
                                    .sort((a, b) => a.segmentId - b.segmentId)
                                    .map((segment) => (
                                        <article
                                            key={segment.segmentId}
                                            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
                                        >
                                            <div className="mb-2 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                                                <span>
                                                    Segment {segment.segmentId}
                                                </span>
                                                <span>
                                                    {formatClock(
                                                        segment.startedAt,
                                                    )}{" "}
                                                    -{" "}
                                                    {formatClock(
                                                        segment.endedAt,
                                                    )}{" "}
                                                    (
                                                    {durationLabel(
                                                        segment.startedAt,
                                                        segment.endedAt,
                                                    )}
                                                    )
                                                </span>
                                            </div>

                                            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--muted)]">
                                                Source
                                            </p>
                                            <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--fg)]">
                                                {segment.sourceText ||
                                                    "(No detected speech)"}
                                            </p>

                                            <p className="mt-3 text-xs font-bold uppercase tracking-[0.12em] text-[var(--accent)]">
                                                Translation
                                            </p>
                                            <p className="mt-1 whitespace-pre-wrap text-base font-semibold text-[var(--accent)]">
                                                {segment.translatedText || "-"}
                                            </p>
                                        </article>
                                    ))
                            )}
                        </div>
                    </div>

                    <div className="border-t border-[var(--border)] bg-[var(--surface)] p-3">
                        <div className="mb-2 text-sm text-[var(--muted)]">
                            {status}
                        </div>
                        {!controlsReady && activeMode === "multi" && (
                            <div className="mb-2 text-sm font-semibold text-[var(--danger)]">
                                Controls disabled: waiting for both Listener and
                                Controller.
                            </div>
                        )}
                        {error && (
                            <div className="mb-2 text-sm font-semibold text-[var(--danger)]">
                                {error}
                            </div>
                        )}

                        <div className="grid grid-cols-3 gap-2 sm:gap-3">
                            <Button
                                onClick={startRecordingAction}
                                disabled={!canStartStop || hasRecording}
                                className="h-12 rounded-xl bg-emerald-600 text-white hover:bg-emerald-600/85"
                            >
                                {hasRecording ? "Listening..." : "Start"}
                            </Button>

                            <Button
                                onClick={() => {
                                    void requestCut();
                                }}
                                disabled={!canCut}
                                className={`h-12 rounded-xl transition ${
                                    !canCut
                                        ? "bg-zinc-500 text-zinc-900 opacity-80"
                                        : "border-amber-300 bg-amber-500 text-white hover:bg-amber-500/70"
                                }`}
                            >
                                {isCutting ? "Cutting..." : "Cut"}
                            </Button>

                            <Button
                                onClick={stopRecordingAction}
                                disabled={!canStartStop || !hasRecording}
                                variant="destructive"
                                className="h-12 rounded-xl"
                            >
                                Stop
                            </Button>
                        </div>
                    </div>
                </div>
            </section>

            {showRolePopup && activeMode === "multi" && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
                    <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--accent)]">
                            Choose Role
                        </p>
                        <p className="mt-2 text-sm text-[var(--muted)]">
                            Select one available role to join or switch roles in
                            this multi-phone room.
                        </p>
                        <div className="mt-4 grid gap-2">
                            {(session?.availableRoles ?? ["viewer"]).map(
                                (role) => (
                                    <Button
                                        key={role}
                                        onClick={() => claimRole(role)}
                                        disabled={roleClaimPending}
                                        variant="outline"
                                    >
                                        {roleLabel(role)}
                                    </Button>
                                ),
                            )}
                        </div>
                        {roleClaimError && (
                            <p className="mt-3 text-sm font-semibold text-[var(--danger)]">
                                {roleClaimError}
                            </p>
                        )}
                    </div>
                </div>
            )}
        </main>
    );
}
