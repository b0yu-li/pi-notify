import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import notifyExtension, {
  appleScriptEscape,
  DEFAULT_ACTIVATE_BUNDLE,
  DEFAULT_SOUNDS,
  notify,
  playSound,
  readSettingsKey,
  resolveActivateBundle,
  resolveConfig,
  resolveNotifierPath,
  resolveSound,
  sanitizeOsc,
  sessionTitle,
  terminalNotifierArgs,
} from "../index.js";

test("resolveConfig merges user config over defaults", () => {
  const cfg = resolveConfig({ sound: false, onError: false });
  assert.equal(cfg.onComplete, true);
  assert.equal(cfg.onQuestion, true);
  assert.equal(cfg.onError, false);
  assert.equal(cfg.sound, false);
  assert.equal(cfg.style, "banner");
  assert.deepEqual(cfg.sounds, DEFAULT_SOUNDS);
});

test("resolveSound accepts basename, .aiff name, and absolute path", () => {
  assert.equal(resolveSound("Basso"), "/System/Library/Sounds/Basso.aiff");
  assert.equal(resolveSound("Ping.aiff"), "/System/Library/Sounds/Ping.aiff");
  assert.equal(resolveSound("/tmp/custom.aiff"), "/tmp/custom.aiff");
  assert.equal(resolveSound("  ", DEFAULT_SOUNDS.error), DEFAULT_SOUNDS.error);
  assert.equal(resolveSound(null, DEFAULT_SOUNDS.question), DEFAULT_SOUNDS.question);
});

test("resolveConfig applies per-event sound overrides", () => {
  const cfg = resolveConfig({
    sounds: { complete: "Hero", error: "/tmp/fail.aiff", question: "Tink.aiff" },
  });
  assert.equal(cfg.sounds.complete, "/System/Library/Sounds/Hero.aiff");
  assert.equal(cfg.sounds.error, "/tmp/fail.aiff");
  assert.equal(cfg.sounds.question, "/System/Library/Sounds/Tink.aiff");
});

test("resolveConfig defaults errorStyle to volatile and accepts persistent", () => {
  assert.equal(resolveConfig({}).errorStyle, "volatile");
  assert.equal(resolveConfig({ errorStyle: "volatile" }).errorStyle, "volatile");
  assert.equal(resolveConfig({ errorStyle: "PERSISTENT" }).errorStyle, "persistent");
  assert.equal(resolveConfig({ errorStyle: "sticky" }).errorStyle, "volatile");
  assert.equal(resolveConfig({ errorStyle: null }).errorStyle, "volatile");
});

test("volatile notice writes the OSC banner and never falls back", () => {
  const chunks = [];
  const runs = [];
  notify("PoC - pi-notify", "An error occurred", {
    volatile: true,
    style: "alert",
    delivery: "center",
    notifierLookup: () => true,
    write: (s) => { chunks.push(s); return true; },
    run: (...args) => runs.push(args),
  });
  assert.equal(runs.length, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "\x1b]777;notify;PoC - pi-notify;An error occurred\x07");
});

test("volatile notice with no terminal is dropped instead of using Notification Center", () => {
  const runs = [];
  notify("PoC - pi-notify", "An error occurred", {
    volatile: true,
    delivery: "center",
    notifierLookup: () => true,
    write() { return false; },
    run: (...args) => runs.push(args),
  });
  assert.equal(runs.length, 0);
});

test("resolveConfig accepts alert and rejects other style values", () => {
  assert.equal(resolveConfig({ style: "alert" }).style, "alert");
  assert.equal(resolveConfig({ style: "ALERT" }).style, "alert");
  assert.equal(resolveConfig({ style: "notifier" }).style, "notifier");
  assert.equal(resolveConfig({ style: "NOTIFIER" }).style, "notifier");
  assert.equal(resolveConfig({ style: "sticky" }).style, "banner");
});

test("resolveConfig keeps activateBundle and notifierPath when set", () => {
  const cfg = resolveConfig({ activateBundle: "com.example.term", notifierPath: "/usr/local/bin/tn" });
  assert.equal(cfg.activateBundle, "com.example.term");
  assert.equal(cfg.notifierPath, "/usr/local/bin/tn");
  assert.equal(resolveConfig({}).activateBundle, undefined);
  assert.equal(resolveConfig({ activateBundle: "  " }).activateBundle, undefined);
  assert.equal(resolveConfig({ notifierPath: 42 }).notifierPath, undefined);
});

test("resolveActivateBundle prefers config, then TERM_PROGRAM, then Ghostty", () => {
  assert.equal(resolveActivateBundle("com.custom.term", "ghostty"), "com.custom.term");
  assert.equal(resolveActivateBundle(undefined, "iTerm.app"), "com.googlecode.iterm2");
  assert.equal(resolveActivateBundle(undefined, "Apple_Terminal"), "com.apple.Terminal");
  assert.equal(resolveActivateBundle(undefined, "WezTerm"), "com.github.wez.wezterm");
  assert.equal(resolveActivateBundle(undefined, "ghostty"), "com.mitchellh.ghostty");
  assert.equal(resolveActivateBundle(undefined, "unknown-term"), DEFAULT_ACTIVATE_BUNDLE);
  assert.equal(resolveActivateBundle(undefined, undefined), DEFAULT_ACTIVATE_BUNDLE);
  assert.equal(resolveActivateBundle(undefined, "vscode"), "com.microsoft.VSCode");
});

test("resolveNotifierPath probes configured then Homebrew prefixes", () => {
  const lookup = (p) => (p === "/opt/homebrew/bin/terminal-notifier" ? p : false);
  assert.equal(resolveNotifierPath(undefined, lookup), "/opt/homebrew/bin/terminal-notifier");
  assert.equal(resolveNotifierPath("/x/tn", lookup), false);
  assert.equal(resolveNotifierPath("/x/tn", (p) => (p === "/x/tn" ? p : false)), "/x/tn");
  assert.equal(resolveNotifierPath(undefined, () => false), false);
  assert.equal(resolveNotifierPath("  ", lookup), "/opt/homebrew/bin/terminal-notifier");
});

test("terminalNotifierArgs builds a click-to-activate argv", () => {
  assert.deepEqual(terminalNotifierArgs("PoC - pi-notify", "Task complete", {
    termProgram: "ghostty",
  }), ["-title", "PoC - pi-notify", "-message", "Task complete", "-activate", "com.mitchellh.ghostty"]);
  assert.deepEqual(terminalNotifierArgs("t", "b", { activateBundle: "com.custom" }), [
    "-title", "t", "-message", "b", "-activate", "com.custom",
  ]);
  const io = { activateBundle: "" };
  delete io.activateBundle;
  assert.ok(terminalNotifierArgs("t", "b", io).includes("-activate"));
});

test("resolveConfig keeps boolean defaults when a flag is not a boolean", () => {
  const cfg = resolveConfig({ onComplete: "false", onError: null, sound: 0, onQuestion: true });
  assert.equal(cfg.onComplete, true);
  assert.equal(cfg.onError, true);
  assert.equal(cfg.sound, true);
  assert.equal(cfg.onQuestion, true);
});

test("resolveConfig tolerates non-object input", () => {
  assert.deepEqual(resolveConfig(null), resolveConfig(undefined));
  assert.deepEqual(resolveConfig("nope"), resolveConfig(undefined));
  assert.deepEqual(resolveConfig(["onComplete"]), resolveConfig(undefined));
});

test("sessionTitle names the current session and directory", () => {
  assert.equal(sessionTitle("PoC", "/Users/boyu/projects/pi-notify"), "PoC - pi-notify");
  assert.equal(sessionTitle("  PoC  ", "/Users/boyu/projects/pi-notify"), "PoC - pi-notify");
  assert.equal(sessionTitle("", "/Users/boyu/projects/pi-notify"), "pi-notify");
  assert.equal(sessionTitle(undefined, ""), "Pi");
});

test("banner writes OSC 777 through the terminal writer", () => {
  const chunks = [];
  const runs = [];
  notify("Hi;there", "line\n1", {
    write: (s) => { chunks.push(s); return true; },
    run: (...args) => runs.push(args),
  });
  assert.equal(runs.length, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "\x1b]777;notify;Hi,there;line1\x07");
  const payload = chunks[0].slice(chunks[0].indexOf("notify;") + "notify;".length, -1);
  assert.ok(!/[\x00-\x1f\x7f]/.test(payload));
});

test("alert style stays up via display alert and skips Ghostty OSC", () => {
  if (process.platform !== "darwin") return;
  const chunks = [];
  const runs = [];
  notify('Stay "here"', "a\\b", {
    style: "alert",
    write: (s) => { chunks.push(s); return true; },
    run: (cmd, args, opts) => runs.push([cmd, args, opts]),
  });
  assert.equal(chunks.length, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "osascript");
  assert.equal(runs[0][2].timeout, 0);
  const script = runs[0][1][1];
  assert.match(script, /display alert "Stay \\"here\\"/);
  assert.match(script, /message "a\\\\b"/);
});

test("configured alert style is passed through to the notifier", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (...args) => calls.push(args) });
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { style: "alert", sound: false } }));
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.agent_settled();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].style, "alert");
});

test("compaction delivery uses Notification Center and skips Ghostty OSC", () => {
  const runs = [];
  notify("PoC - pi-notify", "Compaction complete", {
    style: "banner",
    delivery: "center",
    notifierLookup: () => false,
    write() { throw new Error("osc"); },
    run: (cmd, args) => runs.push([cmd, args]),
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "osascript");
  assert.match(runs[0][1][1], /display notification "Compaction complete"/);
});

test("center delivery prefers terminal-notifier so a click activates the terminal", () => {
  const runs = [];
  notify("PoC - pi-notify", "Compaction complete", {
    style: "banner",
    delivery: "center",
    termProgram: "ghostty",
    notifierLookup: (p) => p,
    write() { throw new Error("osc"); },
    run: (cmd, args) => runs.push([cmd, args]),
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "/opt/homebrew/bin/terminal-notifier");
  assert.deepEqual(runs[0][1], [
    "-title", "PoC - pi-notify", "-message", "Compaction complete",
    "-activate", "com.mitchellh.ghostty",
  ]);
});

test("notifier style always routes through terminal-notifier", () => {
  const runs = [];
  let written = 0;
  notify("PoC - pi-notify", "Task complete", {
    style: "notifier",
    termProgram: "ghostty",
    notifierLookup: (p) => p,
    write: () => { written += 1; return true; },
    run: (cmd, args) => runs.push([cmd, args]),
  });
  assert.equal(written, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "/opt/homebrew/bin/terminal-notifier");
  assert.deepEqual(runs[0][1], [
    "-title", "PoC - pi-notify", "-message", "Task complete",
    "-activate", "com.mitchellh.ghostty",
  ]);
});

test("notifier style falls back to the OSC banner without terminal-notifier", () => {
  const chunks = [];
  const runs = [];
  notify("Hi", "done", {
    style: "notifier",
    notifierLookup: () => false,
    write: (s) => { chunks.push(s); return true; },
    run: (cmd, args) => runs.push([cmd, args]),
  });
  assert.equal(chunks.length, 1);
  assert.equal(runs.length, 0);
});

test("banner with no terminal prefers terminal-notifier and activates the terminal on click", () => {
  if (process.platform !== "darwin") return;
  const runs = [];
  notify('Say "hi"', "a\\b", {
    write: () => false,
    notifierLookup: (p) => p,
    run: (cmd, args) => runs.push([cmd, args]),
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "/opt/homebrew/bin/terminal-notifier");
  assert.ok(runs[0][1].includes("-activate"));
  assert.ok(!runs[0][1].includes("-e"));
});

test("banner with no terminal falls back to osascript and escapes quotes", () => {
  if (process.platform !== "darwin") return;
  const runs = [];
  notify('Say "hi"', "a\\b", {
    write: () => false,
    notifierLookup: () => false,
    run: (cmd, args) => runs.push([cmd, args]),
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "osascript");
  const script = runs[0][1][1];
  assert.match(script, /display notification/);
  assert.match(script, /Say \\"hi\\"/);
  assert.match(script, /a\\\\b/);
});

test("notify and playSound no-op off darwin", () => {
  if (process.platform === "darwin") return;
  const runs = [];
  const io = { write() { throw new Error("no write"); }, run: (...a) => runs.push(a) };
  notify("t", "b", io);
  playSound(io);
  assert.equal(runs.length, 0);
});

test("playSound asks afplay for the requested sound on darwin", () => {
  if (process.platform !== "darwin") return;
  const runs = [];
  playSound({ run: (cmd, args) => runs.push([cmd, args]) });
  playSound({ sound: DEFAULT_SOUNDS.error, run: (cmd, args) => runs.push([cmd, args]) });
  assert.deepEqual(runs, [
    ["afplay", [DEFAULT_SOUNDS.complete]],
    ["afplay", [DEFAULT_SOUNDS.error]],
  ]);
});

test("sanitizeOsc and appleScriptEscape keep payloads inside their grammars", () => {
  assert.equal(sanitizeOsc("a;b\x1b\x07"), "a,b");
  assert.equal(appleScriptEscape('a"b\\c'), 'a\\"b\\\\c');
});

function harness({ flagValue = false, getFlagThrows = false, sessionName, notifySpy = () => {}, soundSpy = () => {} } = {}) {
  const handlers = {};
  const pi = {
    registerFlag() {},
    getFlag() {
      if (getFlagThrows) throw new Error("stale");
      return flagValue;
    },
    getSessionName() {
      return typeof sessionName === "function" ? sessionName() : sessionName;
    },
    on(name, fn) {
      handlers[name] = fn;
    },
  };
  notifyExtension(pi, { notify: notifySpy, playSound: soundSpy });
  return handlers;
}

test("extension registers handlers without throwing", () => {
  const handlers = harness();
  for (const name of ["agent_settled", "session_start", "session_info_changed", "session_compact", "session_compact_failed", "turn_start", "tool_result", "ui_prompt_start"]) {
    assert.equal(typeof handlers[name], "function");
  }
});

test("--no-notify disables firing", () => {
  let n = 0;
  const handlers = harness({ flagValue: true, notifySpy: () => { n += 1; } });
  handlers.agent_settled();
  handlers.tool_result({ isError: true });
  handlers.ui_prompt_start({ title: "Pick one" });
  assert.equal(n, 0);
});

test("stale getFlag never crashes handlers", () => {
  const handlers = harness({ getFlagThrows: true });
  assert.doesNotThrow(() => handlers.agent_settled());
});

test("onComplete titles the current session and follows a rename", () => {
  const calls = [];
  let name = "PoC";
  const handlers = harness({
    sessionName: () => name,
    notifySpy: (title, body) => calls.push([title, body]),
  });
  const ctx = { cwd: "/Users/boyu/projects/pi-notify", isProjectTrusted: () => false };
  handlers.session_start({}, ctx);
  handlers.agent_settled({ aborted: false }, ctx);
  assert.deepEqual(calls, [["PoC - pi-notify", "Task complete"]]);
  name = "renamed";
  handlers.session_info_changed({ name }, ctx);
  handlers.turn_start();
  handlers.agent_settled({ aborted: false }, ctx);
  assert.deepEqual(calls[1], ["renamed - pi-notify", "Task complete"]);
});

test("a stale session name keeps the last rename, and a cancelled run stays quiet", () => {
  const calls = [];
  let failName = false;
  const handlers = harness({
    sessionName: () => {
      if (failName) throw new Error("stale");
      return "PoC";
    },
    notifySpy: (title, body) => calls.push([title, body]),
  });
  const ctx = { cwd: "/Users/boyu/projects/pi-notify", isProjectTrusted: () => false };
  handlers.session_start({}, ctx);
  failName = true;
  handlers.session_info_changed({ name: "renamed" }, ctx);
  handlers.agent_settled({ aborted: false }, ctx);
  handlers.agent_settled({ aborted: true }, ctx);
  assert.deepEqual(calls, [["renamed - pi-notify", "Task complete"]]);
});

test("errors fire volatile by default and persistently with errorStyle persistent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { sound: false } }));
  const calls = [];
  let handlers = harness({ notifySpy: (_t, _b, io) => calls.push(io) });
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.tool_result({ isError: true });
  assert.equal(calls[0].volatile, true);

  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { sound: false, errorStyle: "persistent" } }));
  calls.length = 0;
  handlers = harness({ notifySpy: (_t, _b, io) => calls.push(io) });
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.tool_result({ isError: true });
  assert.equal(calls[0].volatile, undefined);
});

test("a failed compaction is volatile by default and forced-center when persistent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { sound: false } }));
  const calls = [];
  let handlers = harness({ notifySpy: (_t, _b, io) => calls.push(io) });
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.session_compact_failed({ reason: "manual", aborted: false });
  assert.equal(calls[0].volatile, true);

  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { sound: false, errorStyle: "persistent" } }));
  calls.length = 0;
  handlers = harness({ notifySpy: (_t, _b, io) => calls.push(io) });
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.session_compact_failed({ reason: "manual", aborted: false });
  assert.equal(calls[0].volatile, undefined);
  assert.equal(calls[0].delivery, "center");
});

test("manual /compact notifies when it finishes and stays quiet otherwise", () => {
  const calls = [];
  const sounds = [];
  const handlers = harness({
    sessionName: "PoC",
    notifySpy: (title, body, io) => calls.push([title, body, io?.delivery]),
    soundSpy: (io) => sounds.push(io?.sound),
  });
  const ctx = { cwd: "/Users/boyu/projects/pi-notify", isProjectTrusted: () => false };
  handlers.session_start({}, ctx);
  handlers.session_compact({ reason: "threshold", willRetry: false }, ctx);
  handlers.session_compact({ reason: "overflow", willRetry: true }, ctx);
  handlers.session_compact_failed({ reason: "manual", aborted: true }, ctx);
  handlers.session_compact({ reason: "manual", willRetry: false }, ctx);
  handlers.session_compact_failed({ reason: "manual", aborted: false }, ctx);
  assert.deepEqual(calls, [
    ["PoC - pi-notify", "Compaction complete", "center"],
    ["PoC - pi-notify", "Compaction failed", "center"],
  ]);
  assert.deepEqual(sounds, [DEFAULT_SOUNDS.compact, DEFAULT_SOUNDS.error]);
});

test("tool_result error fires once per turn and suppresses Task complete", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (title, body) => calls.push([title, body]) });
  handlers.tool_result({ isError: true });
  handlers.tool_result({ isError: true });
  handlers.agent_settled();
  assert.deepEqual(calls, [["Pi", "An error occurred"]]);
  handlers.turn_start();
  handlers.agent_settled();
  assert.deepEqual(calls[1], ["Pi", "Task complete"]);
});

test("onError false still allows Task complete", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body) });
  handlers.session_start({}, { cwd: "/nowhere", isProjectTrusted: () => false });
  // no settings → defaults. Override by a second session with a temp project.
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { onError: false } }));
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.tool_result({ isError: true });
  handlers.agent_settled();
  assert.deepEqual(calls, ["Task complete"]);
});

test("onComplete false suppresses completion; error and question still fire", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body) });
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { onComplete: false, sound: false } }));
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.agent_settled();
  handlers.session_compact({ reason: "manual", willRetry: false });
  handlers.tool_result({ isError: true });
  handlers.session_compact_failed({ reason: "manual", aborted: false });
  handlers.ui_prompt_start({ title: "Choose" });
  assert.deepEqual(calls, ["Compaction complete", "An error occurred", "Compaction failed", "Question: Choose"]);
});

test("onCompact false suppresses the compaction-complete notice; failure and completion still fire", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body) });
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { onCompact: false, sound: false } }));
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.session_compact({ reason: "manual", willRetry: false });
  handlers.session_compact_failed({ reason: "manual", aborted: false });
  handlers.agent_settled();
  assert.deepEqual(calls, ["Compaction failed", "Task complete"]);
});

test("ui_prompt_start uses a fallback title", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body) });
  handlers.ui_prompt_start({});
  assert.deepEqual(calls, ["Question: waiting for your input"]);
});

test("sound follows config and is skipped when notifications are suppressed", () => {
  const sounds = [];
  const handlers = harness({ soundSpy: (io) => { sounds.push(io?.sound); } });
  handlers.agent_settled();
  assert.deepEqual(sounds, [DEFAULT_SOUNDS.complete]);

  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { sound: false } }));
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.turn_start();
  handlers.agent_settled();
  assert.equal(sounds.length, 1);
});

test("each event kind plays its own default sound", () => {
  const sounds = [];
  const handlers = harness({ soundSpy: (io) => { sounds.push(io?.sound); } });
  handlers.agent_settled();
  handlers.tool_result({ isError: true });
  handlers.ui_prompt_start({ title: "Pick" });
  handlers.session_compact({ reason: "manual", willRetry: false });
  assert.deepEqual(sounds, [
    DEFAULT_SOUNDS.complete,
    DEFAULT_SOUNDS.error,
    DEFAULT_SOUNDS.question,
    DEFAULT_SOUNDS.compact,
  ]);
  assert.notEqual(DEFAULT_SOUNDS.compact, DEFAULT_SOUNDS.complete);
});

test("automatic compaction (threshold/overflow) stays quiet", () => {
  const calls = [];
  const sounds = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body), soundSpy: (io) => sounds.push(io?.sound) });
  handlers.session_compact({ reason: "threshold", willRetry: false });
  handlers.session_compact({ reason: "overflow", willRetry: true });
  handlers.session_compact_failed({ reason: "threshold", willRetry: false });
  handlers.session_compact_failed({ reason: "overflow", willRetry: true });
  handlers.session_compact_failed({ reason: "manual", aborted: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(sounds, []);
});

test("compaction sounds bypass minDurationMs", () => {
  const sounds = [];
  const handlers = harness({ soundSpy: (io) => sounds.push(io?.sound) });
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { minDurationMs: 600000 } }));
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  handlers.agent_start();
  handlers.agent_settled();
  handlers.session_compact({ reason: "manual", willRetry: false });
  assert.deepEqual(sounds, [DEFAULT_SOUNDS.compact]);
});

test("aborted runs and errored turns do not send Task complete", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body) });
  handlers.agent_settled({ aborted: true });
  handlers.turn_start();
  handlers.tool_result({ isError: true });
  handlers.agent_settled({ aborted: false });
  assert.deepEqual(calls, ["An error occurred"]);
});

test("nested tool errors (parentToolCallId) do not fire the error sound", () => {
  const calls = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body) });
  handlers.tool_result({ isError: true, toolCallId: "t1/1", parentToolCallId: "t1" });
  handlers.agent_settled({ aborted: false });
  assert.deepEqual(calls, ["Task complete"]);
});

test("minDurationMs suppresses Task complete for short runs only", async () => {
  const calls = [];
  const handlers = harness({ notifySpy: (_t, body) => calls.push(body) });
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { minDurationMs: 60000 } }));
  handlers.session_start({}, { cwd: dir, isProjectTrusted: () => true });
  // A short run: agent_start then settle well under the threshold.
  handlers.agent_start();
  handlers.agent_settled({ aborted: false });
  assert.deepEqual(calls, []);
  // Errors and questions ignore the threshold.
  handlers.tool_result({ isError: true });
  handlers.ui_prompt_start({ title: "Pick" });
  assert.deepEqual(calls, ["An error occurred", "Question: Pick"]);
  // A fresh run is still inside the threshold, so it stays quiet too.
  handlers.agent_start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  handlers.agent_settled({ aborted: false });
  assert.deepEqual(calls, ["An error occurred", "Question: Pick"]);
});

test("resolveConfig accepts minDurationMs and rejects junk", () => {
  assert.equal(resolveConfig({ minDurationMs: 10000 }).minDurationMs, 10000);
  assert.equal(resolveConfig({ minDurationMs: -5 }).minDurationMs, 0);
  assert.equal(resolveConfig({ minDurationMs: "soon" }).minDurationMs, 0);
  assert.equal(resolveConfig({}).minDurationMs, 0);
});

test("PI_NOTIFY_DEBUG=1 logs every fire and skip decision", () => {
  const log = mkdtempSync(join(tmpdir(), "pi-notify-log-")) + "/debug.log";
  const prevDebug = process.env.PI_NOTIFY_DEBUG;
  const prevPath = process.env.PI_NOTIFY_DEBUG_LOG;
  process.env.PI_NOTIFY_DEBUG = "1";
  process.env.PI_NOTIFY_DEBUG_LOG = log;
  try {
    const handlers = harness({});
    handlers.agent_settled({ aborted: true });
    handlers.agent_settled({ aborted: false });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /skip kind=complete why=aborted/);
    assert.match(lines[1], /fire kind=complete style=banner .*body="Task complete"/);
  } finally {
    if (prevDebug === undefined) delete process.env.PI_NOTIFY_DEBUG;
    else process.env.PI_NOTIFY_DEBUG = prevDebug;
    if (prevPath === undefined) delete process.env.PI_NOTIFY_DEBUG_LOG;
    else process.env.PI_NOTIFY_DEBUG_LOG = prevPath;
  }
});

test("readSettingsKey ignores untrusted project settings and reads global", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-notify-settings-"));
  const project = join(root, "proj");
  const global = join(root, "global");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(global, { recursive: true });
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ notify: { sound: false } }));
  writeFileSync(join(global, "settings.json"), JSON.stringify({ notify: { onQuestion: false } }));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = global;
  try {
    assert.equal(readSettingsKey(project, "notify", false).onQuestion, false);
    assert.equal(readSettingsKey(project, "notify", true).sound, false);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});
