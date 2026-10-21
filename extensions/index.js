/**
 * pi-notify — macOS + Ghostty notifications for Pi.
 *
 * Derived from @bacnh85/pi-notify (MIT). Linux, Windows, Kitty, and volume
 * are removed. Banner: OSC 777 on this process's terminal (stdout when it is
 * a TTY, otherwise /dev/tty). Notification Center when there is no terminal,
 * and for a finished `/compact` (Ghostty drops OSC during the redraw). Alert:
 * an osascript dialog. Sound: afplay of Glass.aiff.
 *
 * Handlers only observe lifecycle events. They never call sendMessage,
 * sendUserMessage, appendEntry, or registerTool.
 * `--no-notify` disables one run. Other platforms no-op.
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { isatty } from "node:tty";
import os from "node:os";

const DEFAULTS = {
  onComplete: true,
  onError: true,
  onQuestion: true,
  sound: true,
  style: "banner",
};

const GLASS = "/System/Library/Sounds/Glass.aiff";

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

/** "alert" stays until dismissed. Anything else is a banner. */
export function normalizeStyle(value) {
  return String(value ?? "").trim().toLowerCase() === "alert" ? "alert" : "banner";
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

export function resolveConfig(user) {
  const extra = user && typeof user === "object" && !Array.isArray(user) ? user : {};
  return {
    onComplete: pickBool(extra.onComplete, DEFAULTS.onComplete),
    onError: pickBool(extra.onError, DEFAULTS.onError),
    onQuestion: pickBool(extra.onQuestion, DEFAULTS.onQuestion),
    sound: pickBool(extra.sound, DEFAULTS.sound),
    style: normalizeStyle(extra.style),
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
 * when the terminal accepted it. Alert stays up via `display alert` (no
 * process timeout). `delivery: "center"` and a failed write use Notification
 * Center.
 */
export function notify(title, body, io = {}) {
  if (process.platform !== "darwin") return;
  const run = io.run ?? defaultRun;
  const write = io.write ?? writeOsc;
  try {
    if (normalizeStyle(io.style) === "alert") {
      const script = `display alert "${appleScriptEscape(title)}" message "${appleScriptEscape(body)}"`;
      run("osascript", ["-e", script], { timeout: 0 });
      return;
    }
    if (io.delivery === "center" || !write(oscPayload(title, body))) {
      run("osascript", ["-e", notificationScript(title, body)]);
    }
  } catch {
    // best-effort
  }
}

export function playSound(io = {}) {
  if (process.platform !== "darwin") return;
  try {
    (io.run ?? defaultRun)("afplay", [GLASS]);
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

  const fire = (title, body, kind, extra) => {
    try {
      if (noNotify) return;
      if (kind === "complete" && !cfg.onComplete) return;
      if (kind === "error" && !cfg.onError) return;
      if (kind === "question" && !cfg.onQuestion) return;
      try { doNotify(title, body, { style: cfg.style, ...extra }); } catch { /* best-effort */ }
      if (cfg.sound) {
        try { doSound(); } catch { /* best-effort */ }
      }
    } catch {
      // never escape an event handler
    }
  };

  let erroredThisTurn = false;
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

  pi.on("agent_settled", (event, ctx) => {
    if (erroredThisTurn || event?.aborted) return;
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
    fire(titleForSession(), "Compaction complete", "complete", { delivery: "center" });
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (ctx) rememberSession(ctx);
    if (event?.reason !== "manual" || event?.aborted) return;
    fire(titleForSession(), "Compaction failed", "error", { delivery: "center" });
  });

  pi.on("turn_start", () => {
    erroredThisTurn = false;
  });

  pi.on("tool_result", (event, ctx) => {
    if (ctx) rememberSession(ctx);
    if (erroredThisTurn) return;
    if (!event?.isError) return;
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
