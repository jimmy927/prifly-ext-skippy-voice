# Skippy Voice

A prifly extension that reads aloud in Skippy the Magnificent's voice. The voice is skippy_zh-e15, trained on the reader's own book audio and approved by ear, and it is rendered on this machine from the private skippy-voice model. Nothing leaves the machine.

While the extension is enabled, it makes sure the voice server is listening at `127.0.0.1:8911`, starting it from `SKIPPY_HOME` if it is not, and points prifly's read-aloud at it through the platform's `setSpeechBackend` hook. Disable or unload the extension and the server it started is stopped and read-aloud goes back to the default voice. There is nothing to configure: no settings, no env var required, no restart.

## Memory

The server holds about 3 GB of RAM and 1-2 GB of VRAM for as long as the extension is enabled. It is stopped, and the memory freed, when the extension is disabled, unloaded or reloaded, or when prifly exits. A reload restarts the voice, so the first read-aloud after it takes about 40-70 s. There are no idle timers and no watcher processes.

A server that was already running on port 8911 (started by hand, say) is used but never stopped by the extension.

## Status line

While enabled, the extension's row in Settings -> Extensions shows the voice server instead of the description:

- `Skippy voice: running` — the server answered its health check.
- `Skippy voice: starting — the first read-aloud takes ~40 s` — the extension just started the server and the model is loading. It is checked once more a minute later and the line becomes `Skippy voice: running`, or `Skippy voice: failed to start — see the serve log`.
- `Skippy voice: not installed (no model under SKIPPY_HOME) — read-aloud stays default` — see below.

There is no background watcher, so the line reflects the last probe. Reloading the extension probes again and starts the server again if it died.

## SKIPPY_HOME

The private assets (model weights, voice checkpoints, training clips) stay in the training checkout and are not part of this repository. `SKIPPY_HOME` points at it and defaults to `~/src/skippy-voice.worktrees/pipeline-scaffold`. The folder must contain:

- `.venv-serve/bin/python`
- `checkpoints-zh/skippy_zh-e15.ckpt`

The server is started as `from skippy_voice.serve import run` inside `SKIPPY_HOME`. If either file is missing, the status line says "not installed", read-aloud stays on the default voice and nothing else is affected.

## Requirements

prifly at or after `e1186aca`, which adds `setSpeechBackend`. Older versions keep the default voice, because the extension only calls the hook when it exists.

## Install

In prifly, open Settings -> Extensions and install by URL:

```
https://github.com/jimmy927/prifly-ext-skippy-voice
```

## Development

`bun test` runs the tests. They use fake dependencies, so no Python runs and no server is started.

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release. Contributions need the CLA in `CLA.md`.
