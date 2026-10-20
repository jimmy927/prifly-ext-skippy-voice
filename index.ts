/**
 * Skippy Voice: while enabled, the Skippy voice server runs on 127.0.0.1:8911
 * and prifly's read-aloud uses it. Disabling (or unloading) the extension stops
 * the server and read-aloud goes back to the default voice.
 */

import { VoiceServer, voiceHealthy } from "./voice";

/** The part of prifly's `ExtensionApi` this uses (`@prifly/extension-api`). */
type Api = {
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  /** prifly master after extension-speech-hook (e1186aca): feature "speech-backend". */
  setSpeechBackend?(url: string | null): void;
  /** One line in Settings → Extensions in place of the description: feature "status". */
  status?(text: string): void;
};

/** What the Extensions dialog says about the voice once `server.ensure()` answered. */
export function voiceStatusText(voice: "alive" | "started" | "missing-env"): string {
  switch (voice) {
    case "alive":
      return "Skippy voice: running";
    case "started":
      return "Skippy voice: starting — the first read-aloud takes ~40 s";
    case "missing-env":
      return "Skippy voice: not installed (no model under SKIPPY_HOME) — read-aloud stays default";
  }
}

export async function activate(api: Api, server: VoiceServer = new VoiceServer()): Promise<() => Promise<void>> {
  let probe: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const voice = await server.ensure();
  // Stopped while the server was being probed: leave the default voice alone.
  if (!stopped) {
    // Owner-slot by the platform hook: this extension's deactivate releases it.
    api.setSpeechBackend?.(voice === "missing-env" ? null : "http://127.0.0.1:8911");
    api.log("skippy-voice", { voice });
    api.status?.(voiceStatusText(voice));
    if (voice === "started") {
      // One follow-up probe once the model has had its ~40 s to load, so the
      // status line lands on running/failed — no recurring watcher.
      probe = setTimeout(() => {
        void voiceHealthy().then((up) => {
          api.status?.(up ? voiceStatusText("alive") : "Skippy voice: failed to start — see the serve log");
        });
      }, 60_000);
    }
  }
  // Disable, unload and reload: the host calls this. It does not await the
  // result (`runStop`), so the next activation waits for the stop itself
  // (`voice.ts`); callers that do await get the finished stop.
  return () => {
    stopped = true;
    clearTimeout(probe);
    return server.stop();
  };
}
