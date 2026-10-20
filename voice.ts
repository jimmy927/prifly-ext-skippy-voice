/**
 * The Skippy voice server: while the extension is enabled, the trained voice
 * listens on 127.0.0.1:8911 — started from SKIPPY_HOME if not already up, and
 * stopped again when the extension is disabled, unloaded or reloaded, or the
 * host exits. The server holds ~3 GB RAM and 1-2 GB GPU, so it must never
 * outlive the extension that wanted it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HEALTH_URL = "http://127.0.0.1:8911/health";

/** How long a SIGTERM'd server gets to free its GPU memory before SIGKILL. */
const GRACE_MS = 5_000;

/**
 * The stop in flight, kept on globalThis: the host reloads an extension by
 * importing it afresh and does not wait for the old stop function, so the new
 * module's server finds the old one's shutdown here and waits for it.
 */
const STOPPING = Symbol.for("prifly-ext-skippy-voice.voice-stopping");
const shared = globalThis as { [STOPPING]?: Promise<void> };

/** Config the voice reads as well; the single point of truth for where the private assets live. */
export function skippyHome(): string {
  return process.env.SKIPPY_HOME ?? join(process.env.HOME ?? "/home/jimmy", "src/skippy-voice.worktrees/pipeline-scaffold");
}

/** One probe of the voice server, for the status line as much as for ensure. */
export async function voiceHealthy(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export type VoiceOutcome = "alive" | "started" | "missing-env";

/** The part of a `ChildProcess` the server uses. */
export type VoiceChild = {
  pid?: number;
  once(event: "exit" | "error", handler: () => void): unknown;
  unref(): void;
};

/** Everything that touches the machine, so a test swaps in stand-ins and no Python runs. */
export type VoiceDeps = {
  spawn(command: string, args: string[], cwd: string): VoiceChild;
  /** Signals the whole process group of `pid`; a group that is already gone is fine. */
  killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  healthy(): Promise<boolean>;
  /** Whether the venv and checkpoint under SKIPPY_HOME exist. */
  installed(): boolean;
  graceMs: number;
};

export const realDeps: VoiceDeps = {
  spawn: (command, args, cwd) =>
    spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONPATH: "src" },
      // Its own process group, so one signal reaches Python and anything it forks.
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    }),
  killGroup: (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ESRCH") throw caught;
    }
  },
  healthy: voiceHealthy,
  installed: () =>
    existsSync(join(skippyHome(), ".venv-serve", "bin", "python")) &&
    existsSync(join(skippyHome(), "checkpoints-zh", "skippy_zh-e15.ckpt")),
  graceMs: GRACE_MS,
};

/**
 * The voice server as this extension owns it. Only a server it spawned itself
 * is ever signalled: one that was already healthy on 8911 (started by hand or
 * by someone else) is used but left alone, stop or not.
 */
export class VoiceServer {
  private child: VoiceChild | null = null;
  private pending: Promise<VoiceOutcome> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly hooks: [NodeJS.Signals | "exit", () => void][] = [];

  constructor(private readonly deps: VoiceDeps = realDeps) {}

  /** Make sure a voice is listening. Concurrent calls share one launch. */
  ensure(): Promise<VoiceOutcome> {
    this.pending ??= this.launch().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async launch(): Promise<VoiceOutcome> {
    await this.stopping;
    await shared[STOPPING];
    if (this.child !== null) return (await this.deps.healthy()) ? "alive" : "started";
    if (await this.deps.healthy()) return "alive";
    if (!this.deps.installed()) return "missing-env";
    const child = this.deps.spawn(
      join(skippyHome(), ".venv-serve/bin/python"),
      ["-c", "from skippy_voice.serve import run; run()"],
      skippyHome(),
    );
    // Not holding the host's event loop open; the handle is kept to stop it.
    child.unref();
    this.child = child;
    const gone = () => {
      if (this.child === child) this.release();
    };
    child.once("exit", gone);
    child.once("error", gone);
    this.hookHostExit(child);
    return "started";
  }

  /** Stop the server this extension started, if any: SIGTERM, then SIGKILL after the grace. */
  stop(): Promise<void> {
    this.stopping ??= this.halt().finally(() => {
      this.stopping = null;
      if (shared[STOPPING] === done) delete shared[STOPPING];
    });
    const done = this.stopping;
    shared[STOPPING] = done;
    return done;
  }

  private async halt(): Promise<void> {
    // A launch in flight spawns first; stop what it makes.
    await this.pending?.catch(() => undefined);
    const child = this.child;
    if (child === null || child.pid === undefined) return this.release();
    const pid = child.pid;
    const exited = new Promise<"exited">((resolve) => {
      child.once("exit", () => resolve("exited"));
    });
    this.deps.killGroup(pid, "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.deps.graceMs);
    });
    const outcome = await Promise.race([exited, late]);
    clearTimeout(timer);
    // Still up after the grace: SIGKILL, so the CUDA memory is freed.
    if (outcome === "late") this.deps.killGroup(pid, "SIGKILL");
    this.release();
  }

  private release(): void {
    this.child = null;
    for (const [event, handler] of this.hooks.splice(0)) process.off(event, handler);
  }

  /**
   * The host does not call an extension's stop function when it exits (only on
   * disable, unload and reload), so a host exit would orphan the server.
   * "exit" allows only synchronous work: SIGTERM to the group, no grace. The
   * signal hooks do the same, then hand the signal back to its default action
   * when no other listener (the host's own) is left to handle it.
   */
  private hookHostExit(child: VoiceChild): void {
    const onExit = () => {
      if (this.child === child && child.pid !== undefined) this.deps.killGroup(child.pid, "SIGTERM");
    };
    this.hooks.push(["exit", onExit]);
    process.on("exit", onExit);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const onSignal = () => {
        onExit();
        process.off(signal, onSignal);
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      };
      this.hooks.push([signal, onSignal]);
      process.on(signal, onSignal);
    }
  }
}
