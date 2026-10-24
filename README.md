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
| `banner` (default) | OSC 777 on this process's terminal only, so Ghostty shows the current session. Notification Center is used only when this process has no terminal. Both go away on their own. |
| `alert` | A macOS alert dialog that stays until you click OK. |
| `sound` on | `afplay` of a per-event system sound: `Glass` (complete), `Basso` (error), `Ping` (question) |

In Ghostty, set `desktop-notifications = true` (the usual default) so banner-style OSC 777 reaches Notification Center. macOS chooses banner versus alert per app in System Settings, not per notice, so `alert` uses a dialog that actually stays instead of Ghostty. This path is macOS-only; other platforms do nothing.

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
    "style": "banner"
  }
}
```

`onComplete`, `onError`, `onQuestion`, and `sound` default to `true`. `style` defaults to `"banner"`. Set `"style": "alert"` when the notice should stay until you dismiss it. Omit the object to keep the defaults.

`sounds` picks the `afplay` file per event. Use a `/System/Library/Sounds` basename (`"Glass"` or `"Glass.aiff"`) or an absolute path. Defaults are `Glass` / `Basso` / `Ping`.

| Flag | Effect |
|------|--------|
| `--no-notify` | No notifications and no sound for that process |

| Key | Event |
|-----|--------|
| `onComplete` | `agent_settled`, after Pi has stopped continuing on its own. The title is the current session name and directory (`PoC - pi-notify`), or just the directory when the session is unnamed. A cancelled run does not send "Task complete". A finished `/compact` sends "Compaction complete" through Notification Center, because Ghostty drops an OSC banner while Pi redraws the summary. Automatic compaction does not, because the turn still ends with "Task complete". |
| `onError` | First `tool_result` with `isError` in the turn. That turn does not also send "Task complete". A `/compact` that fails (and was not cancelled) sends "Compaction failed" through Notification Center. |
| `onQuestion` | `ui_prompt_start` (select, confirm, input, editor, custom) |
