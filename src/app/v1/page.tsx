"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiSessionRole, SessionMode } from "@/lib/v1/types";
import { useThemeMode } from "./use-theme-mode";

const LANGUAGES = [
  "English",
  "Japanese",
  "Spanish",
  "French",
  "German",
  "Korean",
  "Mandarin Chinese",
  "Hindi",
] as const;

function makeClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export default function V1Page() {
  const router = useRouter();
  const { theme, toggleTheme } = useThemeMode();

  const [languageA, setLanguageA] = useState<string>("English");
  const [languageB, setLanguageB] = useState<string>("Japanese");
  const [joinCode, setJoinCode] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [mode, setMode] = useState<SessionMode>("single");
  const [multiRole, setMultiRole] = useState<MultiSessionRole>("listener");

  async function createSession() {
    setPending(true);
    setError("");

    try {
      const clientId = mode === "multi" ? makeClientId() : undefined;
      const response = await fetch("/api/v1/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          languageA,
          languageB,
          mode,
          clientId,
          desiredRole: mode === "multi" ? multiRole : undefined,
        }),
      });

      const data = await readJson<{ sessionCode?: string; error?: string }>(response);
      if (!response.ok || !data.sessionCode) {
        throw new Error(data.error || "Failed to create session.");
      }

      if (mode === "multi" && clientId) {
        router.push(
          `/v1/session/${encodeURIComponent(data.sessionCode)}?mode=multi&clientId=${encodeURIComponent(clientId)}&creator=1`,
        );
        return;
      }

      router.push(`/v1/session/${encodeURIComponent(data.sessionCode)}?mode=single&role=single`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create session.");
    } finally {
      setPending(false);
    }
  }

  function joinSession() {
    const normalized = joinCode.replace(/\D+/g, "").slice(0, 6);
    if (!normalized) {
      setError("Enter a 6-digit room code.");
      return;
    }

    setError("");

    if (mode === "multi") {
      const clientId = makeClientId();
      router.push(`/v1/session/${encodeURIComponent(normalized)}?mode=multi&clientId=${encodeURIComponent(clientId)}`);
      return;
    }

    router.push(`/v1/session/${encodeURIComponent(normalized)}?mode=single&role=single`);
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-8 text-[var(--fg)] sm:px-8">
      <section className="w-full max-w-4xl rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)] sm:p-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-5xl leading-tight text-[var(--accent)] sm:text-6xl">Murasaki Translate</h1>
            <p className="mt-2 text-xs font-bold uppercase tracking-[0.25em] text-[var(--fg)]">Session Setup</p>
            <p className="mt-2 max-w-2xl text-base text-[var(--muted)]">Create or join a single-device or multi-phone room.</p>
          </div>

          <Button variant="ghost" onClick={toggleTheme}>
            {theme === "light" ? "Dark" : "Light"}
          </Button>
        </div>

        <div className="mb-5 rounded-3xl border border-[var(--border)] bg-[var(--surface-soft)] p-5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--accent)]">Mode</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMode("single")}
              className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
                mode === "single"
                  ? "border-[var(--accent)] bg-[var(--surface)] text-[var(--fg)]"
                  : "border-[var(--border)] bg-[var(--surface-soft)] text-[var(--muted)]"
              }`}
            >
              Single Device
            </button>
            <button
              type="button"
              onClick={() => setMode("multi")}
              className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
                mode === "multi"
                  ? "border-[var(--accent)] bg-[var(--surface)] text-[var(--fg)]"
                  : "border-[var(--border)] bg-[var(--surface-soft)] text-[var(--muted)]"
              }`}
            >
              Multi Phone
            </button>
          </div>

          {mode === "multi" && (
            <div className="mt-4">
              <p className="text-sm font-semibold text-[var(--fg)]">Your role when creating</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {(["listener", "controller", "viewer"] as MultiSessionRole[]).map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setMultiRole(role)}
                    className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                      multiRole === role
                        ? "border-emerald-700 bg-emerald-600 text-white"
                        : "border-[var(--border)] bg-[var(--surface-soft)] text-[var(--muted)]"
                    }`}
                  >
                    {role.charAt(0).toUpperCase() + role.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface-soft)] p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--accent)]">Language Pair</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold text-[var(--fg)]">
                Language 1
                <Select value={languageA} onValueChange={setLanguageA}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((lang) => (
                      <SelectItem key={lang} value={lang}>
                        {lang}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="text-sm font-semibold text-[var(--fg)]">
                Language 2
                <Select value={languageB} onValueChange={setLanguageB}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((lang) => (
                      <SelectItem key={lang} value={lang}>
                        {lang}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
          </div>

          <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface-soft)] p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--accent)]">Launch</p>

            <Button onClick={createSession} disabled={pending} className="mt-3 w-full">
              {pending ? "Working..." : "Create Session"}
            </Button>

            <div className="my-5 h-px bg-[var(--border)]" />

            <label className="text-sm font-semibold text-[var(--fg)]">Join existing room</label>
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
              placeholder="123456"
              className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base tracking-[0.2em] outline-none ring-[var(--accent)] focus:ring sm:text-sm"
            />
            <Button variant="outline" onClick={joinSession} disabled={pending} className="mt-3 w-full">
              Join with Code
            </Button>

            {error && <p className="mt-4 text-sm font-semibold text-[var(--danger)]">{error}</p>}
          </div>
        </div>
      </section>
    </main>
  );
}
