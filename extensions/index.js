/**
 * pi-notify — macOS + Ghostty notifications for Pi.
 *
 * Derived from @bacnh85/pi-notify (MIT). Linux, Windows, Kitty, and volume
 * are removed. Banner: OSC 777 on this process's terminal (stdout when it is
 * a TTY, otherwise /dev/tty). Notification Center when there is no terminal,
 * and for a finished `/compact` (Ghostty drops OSC during the redraw) — via
 * terminal-notifier with `-activate` when installed, so a click focuses the
 * terminal, else osascript. Style "notifier" always routes through
 * terminal-notifier for click-to-foreground. Error notices are volatile by
 * default (`errorStyle`): an OSC 777 banner that Ghostty withdraws on focus,
 * never a persistent Notification Center notice. Alert: an osascript dialog.
 * Sound: afplay of a per-event macOS system sound (Glass / Basso / Ping /
 * Sosumi).
 * `minDurationMs` keeps short runs silent; PI_NOTIFY_DEBUG=1 logs every decision
 * to /tmp/pi-notify.log.
 *
 * Handlers only observe lifecycle events. They never call sendMessage,
 * sendUserMessage, appendEntry, or registerTool.
 * `--no-notify` disables one run. Other platforms no-op.
 */

import { execFile } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants, openSync, readFileSync, writeSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { isatty } from "node:tty";
import os from "node:os";

const DEFAULTS = {
  onComplete: true,
  onError: true,
  onQuestion: true,
  onCompact: true,
  sound: true,
  style: "banner",
  errorStyle: "volatile",
  minDurationMs: 0,
};
/** PI_NOTIFY_DEBUG=1 appends one line per decision to this file. */
function debugLog(line) {
  if (!/^(1|true)$/i.test(process.env.PI_NOTIFY_DEBUG ?? "")) return;
  try {
    const path = process.env.PI_NOTIFY_DEBUG_LOG || "/tmp/pi-notify.log";
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // diagnostics must never break a handler
  }
}

const SOUNDS_DIR = "/System/Library/Sounds";

/** Clicking a Notification Center notice activates this app by default. */
export const DEFAULT_ACTIVATE_BUNDLE = "com.mitchellh.ghostty";

/** TERM_PROGRAM → bundle id, so `-activate` targets the running terminal. */
export const TERMINAL_BUNDLES = {
  ghostty: "com.mitchellh.ghostty",
  "iterm.app": "com.googlecode.iterm2",
  apple_terminal: "com.apple.Terminal",
  vscode: "com.microsoft.VSCode",
  kitty: "net.kovidgoyal.kitty",
  wezterm: "com.github.wez.wezterm",
  rio: "com.raphaelamorim.rio",
  alacritty: "org.alacritty",
  hyper: "co.zeit.Hyper",
};

/** terminal-notifier ships in Homebrew's two prefixes. */
const DEFAULT_NOTIFIER_PATHS = [
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
];

/** Default afplay targets per event kind. */
export const DEFAULT_SOUNDS = {
  complete: join(SOUNDS_DIR, "Glass.aiff"),
  error: join(SOUNDS_DIR, "Basso.aiff"),
  question: join(SOUNDS_DIR, "Ping.aiff"),
  compact: join(SOUNDS_DIR, "Sosumi.aiff"),
};

/**
 * Read a settings object. Project scope is skipped unless `trusted` is true,
 * so an untrusted checkout cannot toggle notifications. A missing file, or a
 * non-object value, is skipped; the next location is tried.
 */
export function readSettingsKey(cwd, key, trusted = false) {
  const home = os.homedir();
  const dirs = [
    ...(trusted ? [join(cwd || process.cwd(), ".pi")] : []),
    process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"),
    join(home, ".pi", "agents"),
  ];
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      const value = parsed?.[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // missing or unreadable — try the next location
    }
  }
  return undefined;
}

/** "alert" stays until dismissed, "notifier" uses terminal-notifier. Anything else is a banner. */
export function normalizeStyle(value) {
  const style = String(value ?? "").trim().toLowerCase();
  if (style === "alert") return "alert";
  if (style === "notifier") return "notifier";
  return "banner";
}

/**
 * Error delivery. "persistent" keeps the Notification Center fallback for
 * error notices (the old behavior); anything else is "volatile": the OSC 777
 * banner only, which Ghostty withdraws when the terminal regains focus, so
 * errors never sit in Notification Center history.
 */
export function normalizeErrorStyle(value) {
  return String(value ?? "").trim().toLowerCase() === "persistent" ? "persistent" : "volatile";
}

/**
 * Title for the current session. Matches the Ghostty window suffix
 * `session - directory` so a completion notice names this session only.
 */
export function sessionTitle(name, cwd) {
  const session = typeof name === "string" ? name.trim() : "";
  const dir = typeof cwd === "string" && cwd ? basename(cwd) : "";
  if (session && dir) return `${session} - ${dir}`;
  return session || dir || "Pi";
}

function pickBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Resolve a sound setting to an absolute path. Accepts an absolute path, a
 * system sound basename (`"Basso"` / `"Basso.aiff"`), or falls back.
 */
export function resolveSound(value, fallback) {
  const fallbackPath = typeof fallback === "string" && fallback ? fallback : DEFAULT_SOUNDS.complete;
  if (typeof value !== "string") return fallbackPath;
  const trimmed = value.trim();
  if (!trimmed) return fallbackPath;
  if (isAbsolute(trimmed)) return trimmed;
  const name = trimmed.toLowerCase().endsWith(".aiff") ? trimmed : `${trimmed}.aiff`;
  return join(SOUNDS_DIR, name);
}

/** Resolve the bundle id `-activate` should target on click. */
export function resolveActivateBundle(configured, termProgram) {
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const key = String(termProgram ?? process.env.TERM_PROGRAM ?? "").trim().toLowerCase();
  return TERMINAL_BUNDLES[key] ?? DEFAULT_ACTIVATE_BUNDLE;
}

function defaultNotifierLookup(path) {
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return false;
  }
}

/**
 * Find an executable terminal-notifier. `notifierPath` config wins; otherwise
 * Homebrew's prefixes are probed. Returns false when there is no binary.
 */
export function resolveNotifierPath(configured, lookup = defaultNotifierLookup) {
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  for (const path of trimmed ? [trimmed] : DEFAULT_NOTIFIER_PATHS) {
    const found = lookup(path);
    if (found) return found;
  }
  return false;
}

function resolveSounds(userSounds) {
  const extra = userSounds && typeof userSounds === "object" && !Array.isArray(userSounds)
    ? userSounds
    : {};
  return {
    complete: resolveSound(extra.complete, DEFAULT_SOUNDS.complete),
    error: resolveSound(extra.error, DEFAULT_SOUNDS.error),
    question: resolveSound(extra.question, DEFAULT_SOUNDS.question),
    compact: resolveSound(extra.compact, DEFAULT_SOUNDS.compact),
  };
}

export function resolveConfig(user) {
  const extra = user && typeof user === "object" && !Array.isArray(user) ? user : {};
  const minDurationMs = typeof extra.minDurationMs === "number"
    && Number.isFinite(extra.minDurationMs) && extra.minDurationMs >= 0
    ? extra.minDurationMs
    : DEFAULTS.minDurationMs;
  return {
    onComplete: pickBool(extra.onComplete, DEFAULTS.onComplete),
    onError: pickBool(extra.onError, DEFAULTS.onError),
    onQuestion: pickBool(extra.onQuestion, DEFAULTS.onQuestion),
    onCompact: pickBool(extra.onCompact, DEFAULTS.onCompact),
    sound: pickBool(extra.sound, DEFAULTS.sound),
    sounds: resolveSounds(extra.sounds),
    style: normalizeStyle(extra.style),
    errorStyle: normalizeErrorStyle(extra.errorStyle),
    minDurationMs,
    activateBundle: typeof extra.activateBundle === "string" && extra.activateBundle.trim()
      ? extra.activateBundle.trim()
      : undefined,
    notifierPath: typeof extra.notifierPath === "string" && extra.notifierPath.trim()
      ? extra.notifierPath.trim()
      : undefined,
  };
}

function defaultRun(cmd, args, opts = {}) {
  try {
    const timeout = opts.timeout === undefined ? 5000 : opts.timeout;
    const execOpts = {};
    if (timeout > 0) execOpts.timeout = timeout;
    execFile(cmd, args, execOpts, () => {});
  } catch {
    // best-effort
  }
}

/** Strip C0/DEL and `;` so a model-controlled title cannot forge OSC fields. */
export function sanitizeOsc(str) {
  return String(str).replace(/[\x00-\x1f\x7f]/g, "").replace(/;/g, ",");
}

/** Escape `"` and `\` inside an AppleScript double-quoted string. */
export function appleScriptEscape(str) {
  return String(str).replace(/[\x00-\x1f\x7f]/g, " ").replace(/["\\]/g, "\\$&");
}

function oscPayload(title, body) {
  return `\x1b]777;notify;${sanitizeOsc(title)};${sanitizeOsc(body)}\x07`;
}

function notificationScript(title, body) {
  return `display notification "${appleScriptEscape(body)}" with title "${appleScriptEscape(title)}"`;
}

/**
 * terminal-notifier argv. `-activate` makes a click bring the terminal app to
 * the foreground, which Ghostty's own click-to-focus cannot always do.
 */
export function terminalNotifierArgs(title, body, io = {}) {
  const args = ["-title", String(title), "-message", String(body)];
  const bundle = resolveActivateBundle(io.activateBundle, io.termProgram);
  if (bundle) args.push("-activate", bundle);
  return args;
}

/** This process's terminal only. False when there isn't one. */
function writeOsc(payload) {
  if (process.stdout?.isTTY) {
    process.stdout.write(payload);
    return true;
  }
  let fd;
  try {
    fd = openSync("/dev/tty", "w");
    if (!isatty(fd)) return false;
    writeSync(fd, payload);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed or never opened */ }
    }
  }
}

/**
 * Notify on macOS. `io.write(payload)` delivers a banner and returns true
 * when the terminal accepted it. `io.volatile` restricts the notice to that
 * banner: no alert dialog, no terminal-notifier, no Notification Center — a
 * failed write is dropped instead of falling back. Alert stays up via
 * `display alert` (no process timeout). `delivery: "center"` and a failed
 * write otherwise use Notification Center, preferring terminal-notifier with `-activate` so a click focuses
 * the terminal; osascript notifications are attributed to Script Editor and
 * never activate the terminal on click.
 */
export function notify(title, body, io = {}) {
  if (process.platform !== "darwin") return;
  const run = io.run ?? defaultRun;
  const write = io.write ?? writeOsc;
  try {
    // Volatile: the terminal banner only. Ghostty withdraws it on focus, so
    // nothing lingers in Notification Center history. Overrides every other
    // style — "alert" and "notifier" are persistent by definition.
    if (io.volatile) {
      write(oscPayload(title, body));
      return;
    }
    if (normalizeStyle(io.style) === "alert") {
      const script = `display alert "${appleScriptEscape(title)}" message "${appleScriptEscape(body)}"`;
      run("osascript", ["-e", script], { timeout: 0 });
      return;
    }
    const notifierPath = resolveNotifierPath(io.notifierPath, io.notifierLookup);
    const viaNotifier = (style) => {
      if (!notifierPath) return false;
      run(notifierPath, terminalNotifierArgs(title, body, io), { timeout: 10000 });
      return true;
    };
    if (normalizeStyle(io.style) === "notifier" && viaNotifier()) return;
    if (io.delivery === "center" || !write(oscPayload(title, body))) {
      if (viaNotifier()) return;
      run("osascript", ["-e", notificationScript(title, body)]);
    }
  } catch {
    // best-effort
  }
}

/**
 * Play a notification sound on macOS. `io.sound` is an absolute path; when
 * omitted, Glass (complete) is used.
 */
export function playSound(io = {}) {
  if (process.platform !== "darwin") return;
  const file = typeof io.sound === "string" && io.sound ? io.sound : DEFAULT_SOUNDS.complete;
  try {
    // 30s: a custom sound longer than the old 5s default was cut off mid-play.
    (io.run ?? defaultRun)("afplay", [file], { timeout: 30000 });
  } catch {
    // best-effort
  }
}

export default function notifyExtension(pi, opts = {}) {
  const doNotify = opts.notify || notify;
  const doSound = opts.playSound || playSound;

  pi.registerFlag("no-notify", {
    description: "Disable pi-notify desktop notifications and sounds",
    type: "boolean",
  });

  // Capture once. Event handlers run after reload on a stale runner, and
  // getFlag throws "extension ctx is stale" there.
  let noNotify = false;
  try {
    noNotify = Boolean(pi.getFlag("no-notify"));
  } catch {
    noNotify = false;
  }

  let cfg = resolveConfig(undefined);
  const refreshConfig = (cwd, trusted) => {
    try {
      cfg = resolveConfig(readSettingsKey(cwd, "notify", trusted));
    } catch {
      cfg = resolveConfig(undefined);
    }
  };

  const fire = (title, body, kind, extra = {}) => {
    try {
      const skip = (why) => debugLog(`skip kind=${kind} why=${why} body="${body}"`);
      if (noNotify) return skip("--no-notify");
      if (kind === "complete" && !cfg.onComplete) return skip("onComplete=false");
      if (kind === "error" && !cfg.onError) return skip("onError=false");
      if (kind === "question" && !cfg.onQuestion) return skip("onQuestion=false");
      if (kind === "compact" && !cfg.onCompact) return skip("onCompact=false");
      if (kind === "complete" && cfg.minDurationMs > 0) {
        const elapsed = runStartedAt === undefined
          ? Number.POSITIVE_INFINITY
          : Date.now() - runStartedAt;
        if (elapsed < cfg.minDurationMs) return skip(`minDurationMs elapsed=${elapsed}`);
      }
      const volatileError = kind === "error" && cfg.errorStyle === "volatile";
      debugLog(
        `fire kind=${kind} style=${cfg.style} errorStyle=${cfg.errorStyle}`
        + ` delivery=${volatileError ? "volatile" : extra.delivery ?? "auto"} body="${body}"`,
      );
      try {
        doNotify(title, body, {
          style: cfg.style,
          activateBundle: cfg.activateBundle,
          notifierPath: cfg.notifierPath,
          ...extra,
          ...(volatileError ? { volatile: true } : {}),
        });
      } catch { /* best-effort */ }
      if (cfg.sound) {
        const sound = cfg.sounds?.[kind] ?? DEFAULT_SOUNDS[kind] ?? DEFAULT_SOUNDS.complete;
        try { doSound({ sound }); } catch { /* best-effort */ }
      }
    } catch {
      // never escape an event handler
    }
  };

  let erroredThisTurn = false;
  let runStartedAt;
  let sessionName;
  let sessionCwd;

  const titleForSession = () => sessionTitle(sessionName, sessionCwd);

  const rememberSession = (ctx) => {
    if (typeof ctx?.cwd === "string" && ctx.cwd) sessionCwd = ctx.cwd;
    try {
      if (typeof pi.getSessionName !== "function") return;
      const name = pi.getSessionName();
      if (typeof name === "string" || name == null) sessionName = name ?? undefined;
    } catch {
      // stale runner — keep the last name we saw
    }
  };

  pi.on("agent_start", () => {
    runStartedAt = Date.now();
  });
  pi.on("agent_settled", (event, ctx) => {
    if (erroredThisTurn || event?.aborted) {
      debugLog(`skip kind=complete why=${event?.aborted ? "aborted" : "erroredThisTurn"}`);
      return;
    }
    if (ctx) rememberSession(ctx);
    fire(titleForSession(), "Task complete", "complete");
  });

  pi.on("session_start", (_event, ctx) => {
    erroredThisTurn = false;
    rememberSession(ctx);
    refreshConfig(ctx?.cwd || process.cwd(), ctx?.isProjectTrusted?.() === true);
  });

  pi.on("session_info_changed", (event, ctx) => {
    if (event && "name" in event) sessionName = typeof event.name === "string" ? event.name : undefined;
    if (typeof ctx?.cwd === "string" && ctx.cwd) sessionCwd = ctx.cwd;
  });

  // `/compact` does not settle an agent run, so agent_settled never fires.
  // Threshold and overflow compaction continue the run; those stay quiet.
  pi.on("session_compact", (event, ctx) => {
    if (ctx) rememberSession(ctx);
    if (event?.reason !== "manual" || event?.willRetry) return;
    fire(titleForSession(), "Compaction complete", "compact", { delivery: "center" });
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (ctx) rememberSession(ctx);
    if (event?.reason !== "manual" || event?.aborted) return;
    // `delivery: "center"` is what volatile errors (the default) override;
    // `errorStyle: "persistent"` keeps the old Notification Center notice.
    fire(titleForSession(), "Compaction failed", "error", { delivery: "center" });
  });

  pi.on("turn_start", () => {
    erroredThisTurn = false;
  });

  pi.on("tool_result", (event, ctx) => {
    if (ctx) rememberSession(ctx);
    if (erroredThisTurn) return;
    if (!event?.isError) return;
    // Nested calls (codemode scripts, orchestrators) report through the
    // issuing tool's own result; the inner failure alone is not user-facing.
    if (event.parentToolCallId) {
      debugLog(`skip kind=error why=nested toolCallId=${event.toolCallId}`);
      return;
    }
    if (!noNotify && cfg.onError) erroredThisTurn = true;
    fire(titleForSession(), "An error occurred", "error");
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    if (ctx) rememberSession(ctx);
    const title = typeof event?.title === "string" && event.title
      ? event.title
      : "waiting for your input";
    fire(titleForSession(), `Question: ${title}`, "question");
  });
}
