# pi-notify

macOS notifications for [Pi](https://pi.dev) in [Ghostty](https://ghostty.org).

Fires when the agent finishes a turn, hits a tool error, or waits on a question. No tools, no transcript entries, no user messages — nothing is added to the model context.

Derived from [@bacnh85/pi-notify](https://github.com/bacnh85/pi-extensions/tree/main/pi-notify). Linux, Windows, Kitty, and volume control are removed.

## Load

For every session, install this repo by absolute path (a relative path would be resolved from `~/.pi/agent/`):

```bash
pi install /absolute/path/to/pi-notify
```

Restart Pi, or run `/reload`. `pi list` should show the path.

To try one invocation without installing:

```bash
pi --extension ./extensions/index.js
```

## What you hear and see

| `style` | What you see / hear |
|---------|----------------|
| `banner` (default) | OSC 777 on this process's terminal only, so Ghostty shows the current session. Notification Center is used only when this process has no terminal (or for a finished `/compact`), via `terminal-notifier` when installed so a click focuses this app. Both go away on their own. |
| `notifier` | Never uses OSC: every notice goes through `terminal-notifier` with `-activate`, so clicking a notification always brings Ghostty to the foreground. Opt in when Ghostty's own click-to-focus misbehaves (see below). |
| `alert` | A macOS alert dialog that stays until you click OK. |
| `sound` on | `afplay` of a per-event system sound: `Glass` (complete), `Basso` (error), `Ping` (question) |

In Ghostty, set `desktop-notifications = true` (the usual default) so banner-style OSC 777 reaches Notification Center. macOS chooses banner versus alert per app in System Settings, not per notice, so `alert` uses a dialog that actually stays instead of Ghostty. This path is macOS-only; other platforms do nothing.

## Clicking a notification

Ghostty's own click-to-focus (the `banner` path) has known blind spots:

- **Split panes**: in Ghostty 1.3.1, clicking a notification from a split pane opens a new window instead of focusing the originating pane ([ghostty#10444](https://github.com/ghostty-org/ghostty/issues/10444), fixed after 1.3.1). Upgrade Ghostty to ≥ 1.4.0.
- **Quick terminal**: notifications from a quick-terminal surface cannot be click-focused at all — Ghostty's surface lookup does not scan it.
- **Fullscreen Spaces**: `makeKeyAndOrderFront` does not always switch to the right fullscreen Space.

To make a click always bring Ghostty to the foreground regardless of these, install [terminal-notifier](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`) and either:

- set `"style": "notifier"` so every notice routes through it, or
- keep `"style": "banner"` — the Notification Center fallback (no terminal, `/compact`) then already uses `terminal-notifier -activate com.mitchellh.ghostty` when the binary is present, and falls back to `osascript` otherwise. Note that plain `osascript display notification` notices are attributed to Script Editor and can never activate Ghostty on click.

Without `terminal-notifier`, clicking a `banner`-style notice still focuses the originating Ghostty surface in regular windows (on Ghostty ≥ 1.4.0), because the notification is attached to the terminal surface via OSC 777.

## Configuration

Put a `notify` object in `.pi/settings.json` (trusted projects only), `$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`, or `~/.pi/agents/settings.json`. The first file that contains a `notify` object wins.

```json
{
  "notify": {
    "onComplete": true,
    "onError": true,
    "onQuestion": true,
    "sound": true,
    "sounds": {
      "complete": "Glass",
      "error": "Basso",
      "question": "Ping"
    },
    "style": "banner",
    "errorStyle": "volatile",
    "minDurationMs": 0,
    "activateBundle": "com.mitchellh.ghostty",
    "notifierPath": "/opt/homebrew/bin/terminal-notifier"
  }
}
```

`onComplete`, `onError`, `onQuestion`, and `sound` default to `true`. `style` defaults to `"banner"`. Set `"style": "alert"` when the notice should stay until you dismiss it, or `"style": "notifier"` to always route through `terminal-notifier`. `errorStyle` (default `"volatile"`) controls error notices only: `"volatile"` delivers them as the OSC 777 terminal banner, which Ghostty withdraws the moment the terminal regains focus, and drops them silently when there is no terminal — nothing lingers in Notification Center history. Set `"errorStyle": "persistent"` to restore the old behavior, where an error falls back to Notification Center (or, when there is no terminal at all, is delivered there directly). Note that the volatile banner for a failed `/compact` can be lost while Pi redraws — the same Ghostty redraw that made "Compaction complete" use Notification Center; `"persistent"` avoids that too. `minDurationMs` (default `0`) silences the completion notice for runs that finished faster than the given milliseconds — raise it (e.g. `10000`) when short replies chime too often. Omit the object to keep the defaults.

Settings are re-read at each `session_start`; run `/reload` after editing them mid-session.

`activateBundle` is the bundle id a `terminal-notifier` click activates. It defaults to Ghostty (`com.mitchellh.ghostty`), or the running terminal via `TERM_PROGRAM` (`iTerm.app`, `Apple_Terminal`, `vscode`, `kitty`, `WezTerm`, `rio`, `Alacritty`, `hyper`). `notifierPath` overrides where the `terminal-notifier` binary is looked up (Homebrew's `/opt/homebrew/bin` and `/usr/local/bin` prefixes are probed otherwise).

`sounds` picks the `afplay` file per event. Use a `/System/Library/Sounds` basename (`"Glass"` or `"Glass.aiff"`) or an absolute path. Defaults are `Glass` / `Basso` / `Ping`.

| Flag | Effect |
|------|--------|
| `--no-notify` | No notifications and no sound for that process |

| Key | Event |
|-----|--------|
| `onComplete` | `agent_settled`, after Pi has stopped continuing on its own. The title is the current session name and directory (`PoC - pi-notify`), or just the directory when the session is unnamed. A cancelled run does not send "Task complete"; neither does a run shorter than `minDurationMs`. A finished `/compact` sends "Compaction complete" through Notification Center, because Ghostty drops an OSC banner while Pi redraws the summary. Automatic compaction does not, because the turn still ends with "Task complete". |
| `onError` | First top-level `tool_result` with `isError` in the turn. Errors of nested calls (`parentToolCallId` set — codemode scripts, orchestrating tools) are skipped, because the issuing tool reports them in its own result. That turn does not also send "Task complete". A `/compact` that fails (and was not cancelled) sends "Compaction failed" — volatile by default (`errorStyle`), through Notification Center with `"errorStyle": "persistent"`. |
| `onQuestion` | `ui_prompt_start` (select, confirm, input, editor, custom). This fires for any blocking extension dialog — including confirmation prompts raised by other installed extensions mid-run — not only questions the model asks. |

## Hunting a phantom sound

Every sound traces to one of the events above: `Glass` on completion, `Basso` on a tool error, `Ping` on a question. If you hear one unexpectedly, run Pi with `PI_NOTIFY_DEBUG=1`:

```bash
PI_NOTIFY_DEBUG=1 pi
```

Each decision (fired or skipped, and why) is appended to `/tmp/pi-notify.log` (override with `PI_NOTIFY_DEBUG_LOG`). Two sound sources live outside this extension: macOS plays its own tone for a notification when System Settings → Notifications → Ghostty has "Play sound for notifications" enabled, and other extensions' dialogs trigger the `onQuestion` ping mid-run.
