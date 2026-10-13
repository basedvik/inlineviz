// `opencodeviz attach <url>`: follow a running OpenCode server (`opencode serve`,
// or the server behind a TUI) over its SSE event stream (GET /event), using the
// same OpenCodeAdapter as the TUI plugin. Context limits come from
// GET /config/providers. Loaded lazily so the rest of the CLI stays dependency-free.

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { SignalSink } from "../core/protocol.ts";
import { discoverArch } from "./discover.ts";
import { OpenCodeAdapter, type OpenCodeEvent } from "./opencode.ts";

export function attachOpenCode(baseUrl: string, sink: SignalSink, now: () => number, sessionID?: string) {
  const client = createOpencodeClient({ baseUrl });
  const limits = new Map<string, number>();
  const baseURLs = new Map<string, string>();
  const asked = new Set<string>();
  let stopped = false;

  const loadLimits = async () => {
    try {
      const res: any = await client.config.providers();
      for (const p of res?.data?.providers ?? []) {
        if (typeof p.options?.baseURL === "string") baseURLs.set(p.id, p.options.baseURL);
        for (const [id, m] of Object.entries<any>(p.models ?? {})) {
          if (m?.limit?.context) limits.set(`${p.id}/${id}`, m.limit.context);
        }
      }
    } catch {
      /* limits stay unknown → ~200k */
    }
  };

  // Same discovery as the TUI plugin (no persistent cache in the CLI).
  const withArch: SignalSink = (s) => {
    sink(s);
    if (s.t !== "model") return;
    const key = `${s.model.providerID}/${s.model.modelID}`;
    if (asked.has(key)) return;
    asked.add(key);
    void discoverArch({ providerID: s.model.providerID, modelID: s.model.modelID, baseURL: baseURLs.get(s.model.providerID) }, { fetch, lookup: "all", now })
      .then((arch) => { if (arch) sink({ t: "arch", ts: now(), modelID: s.model.modelID, arch }); })
      .catch(() => {});
  };

  const adapter = new OpenCodeAdapter(withArch, {
    activeSessionID: () => sessionID,
    contextLimit: (providerID, modelID) => limits.get(`${providerID}/${modelID}`),
    now,
  });

  const run = async () => {
    await loadLimits();
    let backoff = 500;
    while (!stopped) {
      try {
        const sub: any = await client.event.subscribe();
        backoff = 500;
        for await (const ev of sub.stream as AsyncIterable<OpenCodeEvent>) {
          if (stopped) break;
          if (ev && typeof ev.type === "string") adapter.handle(ev);
        }
      } catch {
        /* server restarting or unreachable: retry */
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 5000);
    }
  };
  void run();

  return {
    stop() {
      stopped = true;
    },
  };
}
