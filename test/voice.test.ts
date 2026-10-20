import { afterEach, expect, test } from "bun:test";
import { activate, voiceStatusText } from "../index";
import { VoiceServer, type VoiceChild, type VoiceDeps } from "../voice";

// What a test started is stopped even when it fails midway, so no process
// hook or pending probe outlives it.
const servers: VoiceServer[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function track(deps: VoiceDeps): VoiceServer {
  const server = new VoiceServer(deps);
  servers.push(server);
  return server;
}

/** A stand-in spawn and kill: records every call, no Python runs. */
function standIn(options: { healthy?: boolean; upAfterSpawn?: boolean; installed?: boolean; exitsOnTerm?: boolean; graceMs?: number } = {}) {
  const spawned: { pid: number; exit(): void }[] = [];
  const signals: [number, string][] = [];
  const deps: VoiceDeps = {
    spawn() {
      const handlers: (() => void)[] = [];
      const child: VoiceChild & { exit(): void } = {
        pid: 1000 + spawned.length,
        once: (event, handler) => {
          if (event === "exit") handlers.push(handler);
        },
        unref: () => undefined,
        exit: () => handlers.splice(0).forEach((handler) => handler()),
      };
      spawned.push(child as { pid: number; exit(): void });
      return child;
    },
    killGroup(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGTERM" && options.exitsOnTerm !== false) spawned.find((child) => child.pid === pid)?.exit();
    },
    // True from the start, or only once something was spawned (the model finished loading).
    healthy: () => Promise.resolve(options.healthy ?? (options.upAfterSpawn === true && spawned.length > 0)),
    installed: () => options.installed ?? true,
    graceMs: options.graceMs ?? 20,
  };
  return { deps, spawned, signals };
}

/** An extension api that records what the extension tells the host. */
function recordingApi() {
  const backends: (string | null)[] = [];
  const statuses: string[] = [];
  const logs: [string, unknown][] = [];
  const api = {
    log: (event: string, fields?: unknown) => {
      logs.push([event, fields]);
    },
    setSpeechBackend: (url: string | null) => {
      backends.push(url);
    },
    status: (text: string) => {
      statuses.push(text);
    },
  };
  return { api, backends, statuses, logs };
}

/** Activates and registers the stop function for cleanup. */
async function start(api: ReturnType<typeof recordingApi>["api"], deps: VoiceDeps, probeMs?: number) {
  const stop = await activate(api, track(deps), probeMs);
  stops.push(stop);
  return stop;
}

test("activate spawns the voice exactly once and points read-aloud at it", async () => {
  const { deps, spawned } = standIn();
  const { api, backends, statuses, logs } = recordingApi();
  await start(api, deps);
  expect(spawned).toHaveLength(1);
  expect(backends).toEqual(["http://127.0.0.1:8911"]);
  expect(statuses).toEqual([voiceStatusText("started")]);
  expect(logs).toEqual([["skippy-voice", { voice: "started" }]]);
});

test("the stop function the host calls (disable, unload, reload) stops the server it started", async () => {
  const { deps, signals } = standIn();
  const stop = await start(recordingApi().api, deps);
  await stop();
  expect(signals).toEqual([[1000, "SIGTERM"]]);
});

test("the stop function resolves only once the server is down, SIGKILL included", async () => {
  const { deps, signals } = standIn({ exitsOnTerm: false, graceMs: 20 });
  const stop = await start(recordingApi().api, deps);
  let down = false;
  const stopping = stop().then(() => {
    down = true;
  });
  // Inside the grace: SIGTERM sent, the server still up, the stop still pending.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(signals).toEqual([[1000, "SIGTERM"]]);
  expect(down).toBe(false);
  await stopping;
  expect(signals).toEqual([
    [1000, "SIGTERM"],
    [1000, "SIGKILL"],
  ]);
});

test("one follow-up probe turns the status to running once the voice is up", async () => {
  const { deps } = standIn({ upAfterSpawn: true });
  const { api, statuses } = recordingApi();
  await start(api, deps, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(statuses).toEqual([voiceStatusText("started"), voiceStatusText("alive")]);
});

test("the probe reports a failed start when the voice never came up", async () => {
  const { deps } = standIn();
  const { api, statuses } = recordingApi();
  await start(api, deps, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(statuses).toEqual([voiceStatusText("started"), "Skippy voice: failed to start — see the serve log"]);
});

test("a stop before the probe fires cancels it", async () => {
  const { deps } = standIn({ upAfterSpawn: true });
  const { api, statuses } = recordingApi();
  const stop = await start(api, deps, 20);
  await stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(statuses).toEqual([voiceStatusText("started")]);
});

test("a reloaded extension's server waits for the old one's stop before spawning", async () => {
  const old = standIn({ exitsOnTerm: false, graceMs: 50 });
  const oldServer = track(old.deps);
  await oldServer.ensure();
  const stopping = oldServer.stop();
  const next = standIn();
  const nextServer = track(next.deps);
  await nextServer.ensure();
  // The new spawn came after the old server's SIGKILL, not beside it.
  expect(old.signals.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  expect(next.spawned).toHaveLength(1);
  await stopping;
});

test("a server that was already healthy and not spawned by us is never signalled", async () => {
  const { deps, spawned, signals } = standIn({ healthy: true });
  const { api, backends, statuses } = recordingApi();
  const stop = await start(api, deps);
  await stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(spawned).toHaveLength(0);
  expect(signals).toEqual([]);
  expect(backends).toEqual(["http://127.0.0.1:8911"]);
  expect(statuses).toEqual([voiceStatusText("alive")]);
});

test("SIGKILL follows when the server has not exited within the grace period", async () => {
  const { deps, signals } = standIn({ exitsOnTerm: false, graceMs: 20 });
  const server = track(deps);
  await server.ensure();
  await server.stop();
  expect(signals).toEqual([
    [1000, "SIGTERM"],
    [1000, "SIGKILL"],
  ]);
});

test("activating again after a stop starts the voice again", async () => {
  const { deps, spawned, signals } = standIn();
  const first = await start(recordingApi().api, deps);
  await first();
  await start(recordingApi().api, deps);
  expect(spawned).toHaveLength(2);
  expect(signals).toEqual([[1000, "SIGTERM"]]);
});

test("concurrent ensure calls share one launch", async () => {
  const { deps, spawned } = standIn();
  const server = track(deps);
  await Promise.all([server.ensure(), server.ensure()]);
  expect(spawned).toHaveLength(1);
  await server.stop();
});

test("voiceStatusText names each outcome", () => {
  expect(voiceStatusText("alive")).toBe("Skippy voice: running");
  expect(voiceStatusText("started")).toContain("starting");
  expect(voiceStatusText("missing-env")).toContain("not installed");
  expect(voiceStatusText("missing-env")).toContain("read-aloud stays default");
});

test("missing-env sets the backend to null and spawns nothing", async () => {
  const { deps, spawned } = standIn({ installed: false });
  const { api, backends, statuses } = recordingApi();
  const stop = await start(api, deps);
  expect(spawned).toHaveLength(0);
  expect(backends).toEqual([null]);
  expect(statuses).toEqual([voiceStatusText("missing-env")]);
  await stop();
});
