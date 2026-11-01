// `nous backfill` (GET-1085): read your history on your own Claude or ChatGPT plan. Our server runs
// the production read and hands this loop one model call at a time; each is answered by the claude
// or codex CLI you are already signed in to.
//
// EMAIL TEXT IS UNTRUSTED. A call's prompt holds other people's words, so the model answering it
// gets no tools at all: an email must not be able to read your disk. For Codex the read-only
// sandbox is not enough (it can still read files), so its shell tool is turned off.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const POLL_MS = 2000;
export const WORKERS = 3;
export const LIMIT_WAIT_MS = 30 * 60_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const RETRIES = 2;
const PROGRESS_MS = 30_000;

/** The command for one call. Pure. Model and effort come from the server. */
export function commandFor(agent, { model, effort }, { system, messages }) {
  const user = messages.map((m) => (m.role === "assistant" ? `ASSISTANT: ${m.content}` : m.content)).join("\n\n");
  if (agent === "claude") {
    return {
      cmd: "claude",
      args: ["-p", "--model", model, "--effort", effort, "--output-format", "json", "--tools", "",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
        "--disable-slash-commands", "--no-session-persistence",
        "--system-prompt", system || "Follow the instructions in the user message exactly."],
      input: user,
    };
  }
  return {
    cmd: "codex",
    args: ["exec", "--json", "-m", model, "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
      "--ignore-user-config", "-c", "mcp_servers={}", "-c", "features.shell_tool=false",
      "-c", `model_reasoning_effort="${effort}"`],
    input: `${system ? `<instructions>\n${system}\n</instructions>\n\n` : ""}${user}\n\nReply only with the answer.`,
  };
}

/** The answer and token use from a CLI's output. Pure. Throws when there is no answer. */
export function parseAnswer(agent, out) {
  if (agent === "claude") {
    const j = JSON.parse(out);
    if (j.is_error) throw new Error(String(j.result));
    return { text: j.result, usage: { input_tokens: j.usage?.input_tokens ?? 0, output_tokens: j.usage?.output_tokens ?? 0 } };
  }
  let text = "", usage = null;
  for (const line of out.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.item?.type === "agent_message") text = e.item.text;
    if (e.usage) usage = e.usage;
  }
  if (!text) throw new Error("codex gave no answer");
  return { text, usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 } };
}

/** Whether an error means the plan's limit, which passes with time, rather than a bad call. Pure. */
export function isPlanLimit(message) {
  return /usage limit|rate.?limit|hit your .*limit|limit reached|too many requests|\b429\b|quota/i.test(String(message));
}

export function detectAgents(run = spawnSync) {
  const found = [];
  if (run("claude", ["auth", "status"], { encoding: "utf8" }).status === 0) found.push("claude");
  if (run("codex", ["login", "status"], { encoding: "utf8" }).status === 0) found.push("codex");
  return found;
}

/** Without the API key variables, so the call runs on the plan, not a key billed by the token. */
function planEnv(env = process.env) {
  const clean = { ...env, DISABLE_AUTOUPDATER: "1" };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete clean[k];
  return clean;
}

function runCommand({ cmd, args, input }, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: planEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { p.kill(); reject(new Error("timed out")); }, CALL_TIMEOUT_MS);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out); else reject(new Error((err || out).slice(-400) || `exit ${code}`));
    });
    p.stdin.end(input);
  });
}

/** One line on how far the job is, or null when there is nothing to say yet. Pure. */
export function progressLine(reading, answered) {
  if (reading?.finished) return "Wrapping up: last summaries for your accounts.";
  if (reading?.total) return `Read ${reading.done} of ${reading.total} email threads. Stop any time with Ctrl-C; run \`nous backfill\` again to carry on.`;
  if (answered) return `${answered} reads done on your plan. Stop any time with Ctrl-C; run \`nous backfill\` again to carry on.`;
  return "Pulling your history. This can take a few minutes. Stop any time with Ctrl-C; run `nous backfill` again to carry on.";
}

/**
 * The loop: lease calls, answer them, until the job ends. Injected: `api` ({ calls, answer, resume }),
 * `run` (one command → stdout), `sleep`, `log`. Stopping loses nothing: every read that finished
 * is saved, and unanswered calls come back to the next run.
 */
export async function runBackfill({ api, agent, jobId, run, sleep, log, now = Date.now, workers = WORKERS, limitWaitMs = LIMIT_WAIT_MS, pollMs = POLL_MS, progressMs = PROGRESS_MS }) {
  let waitUntil = 0, answered = 0, lastLine = null, lastAt = -Infinity;
  const say = (line) => {
    if (!line || (line === lastLine && now() - lastAt < progressMs) || now() - lastAt < Math.min(progressMs, 1000)) return;
    lastLine = line; lastAt = now(); log(line);
  };
  const answerOne = async (call, models) => {
    for (let attempt = 0; ; attempt++) {
      if (now() < waitUntil) await sleep(waitUntil - now());
      try {
        const { text, usage } = parseAnswer(agent, await run(commandFor(agent, models[agent], call)));
        await api.answer(call.id, { answer: text, model: models[agent].model, usage });
        answered++;
        return;
      } catch (err) {
        if (isPlanLimit(err.message)) {
          if (now() >= waitUntil) log(`Your ${agent} plan hit its limit. Waiting ${Math.round(limitWaitMs / 60000)} minutes, then carrying on. You can stop now and run this again later instead.`);
          waitUntil = Math.max(waitUntil, now() + limitWaitMs);
          continue;
        }
        if (attempt >= RETRIES) { await api.answer(call.id, { error: err.message }); return; }
      }
    }
  };
  for (;;) {
    const page = await api.calls(jobId, workers);
    if (page.status === "done") return { status: "done", answered, read: page.reading?.read ?? 0, failed: page.reading?.failed ?? 0 };
    if (page.status === "failed") throw new Error(page.error || "The backfill failed on our side.");
    // The server gave up waiting for us (a long sleep, say). We're back, so pick it up.
    if (page.status === "paused_own_model") { await api.resume?.(); await sleep(pollMs); continue; }
    say(progressLine(page.reading, answered));
    if (!page.calls.length) { await sleep(pollMs); continue; }
    await Promise.all(page.calls.map((c) => answerOne(c, page.models)));
  }
}

/** The real pieces for runBackfill. */
export function liveRun() {
  const cwd = mkdtempSync(join(tmpdir(), "nous-backfill-"));
  return (command) => runCommand(command, cwd);
}
