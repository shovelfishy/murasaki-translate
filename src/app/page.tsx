"use client";
import { redirect } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function Home() {
    const [bloblUrl, setBlobUrl] = useState<string>("");
    const stream = useRef<MediaStream | null>(null);
    const recorder = useRef<MediaRecorder | null>(null);
    const seg = useRef(0);

    function pickMime() {
        const types = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/ogg;codecs=opus",
            "audio/ogg",
        ];
        return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    }

    function saveBlob(blob: Blob) {
        const ext = blob.type.includes("ogg") ? "ogg" : "webm";
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = `segment_${String(seg.current++).padStart(3, "0")}.${ext}`;
        a.textContent = `Download ${a.download}`;
        a.style.display = "block";
        document.getElementById("links")!.prepend(a);
    }

    async function startRecording() {
        stream.current = await navigator.mediaDevices.getUserMedia({
            audio: true,
        });
        const mimeType = pickMime();
        recorder.current = new MediaRecorder(
            stream.current,
            mimeType ? { mimeType } : undefined,
        );

        recorder.current.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                saveBlob(e.data);
                console.log(e.data);
            }
        };

        recorder.current.start(); // no timeslice
    }

    function cutRecording() {
        if (!recorder.current) return;

        recorder.current.addEventListener("stop", () => {
            recorder.current!.start()
        }, { once: true });
        recorder.current.stop();
    }

    async function stopRecording() {
        if (!recorder.current || !stream.current) return;

        recorder.current.addEventListener(
            "stop",
            () => {
                // Often you’ll get a final dataavailable automatically on stop,
                // but calling requestData before stop can make it explicit:
                // recorder.requestData();

                stream.current!.getTracks().forEach((t) => t.stop());
                recorder.current = null;
                stream.current = null;
            },
            { once: true },
        );

        recorder.current.stop();
    }

    useEffect(() => {
        const test = async () => {
            const res = await fetch("/api/ai")
            console.log(await res.json())
        }
        test()
    }, [])

    return (
        redirect("/v1")
    );
}
