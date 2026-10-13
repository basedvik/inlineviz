// inlineviz Claude Code hook (runs async, never blocks Claude Code).
// Appends ONE compact line per event to the plugin data folder. It never records prompts, file
// contents, commands or tool output: only event name, ids, tool name, model and error type.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  const p = JSON.parse(readFileSync(0, "utf8"));
  const r = { t: Date.now(), e: String(p.hook_event_name ?? ""), sid: String(p.session_id ?? "") };
  if (typeof p.transcript_path === "string") r.tp = p.transcript_path;
  if (typeof p.agent_id === "string" && p.agent_id) r.aid = p.agent_id;
  if (typeof p.agent_type === "string") r.at = p.agent_type;
  if (typeof p.tool_name === "string") r.tool = p.tool_name;
  if (typeof p.tool_use_id === "string") r.id = p.tool_use_id;
  const model = p.model ?? p.to_model;
  if (typeof model === "string") r.model = model;
  if (p.error_type) r.err = String(p.error_type);
  const dir = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "inlineviz");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "events.ndjson");
  try {
    if (statSync(f).size > 5_000_000) renameSync(f, f + ".1");
  } catch {
    /* first write */
  }
  appendFileSync(f, JSON.stringify(r) + "\n");
} catch {
  /* never fail the user's session */
}
