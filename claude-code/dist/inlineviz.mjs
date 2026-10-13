import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/adapters/claude.ts
function usageFromAnthropic(u) {
  if (!u || typeof u !== "object")
    return;
  const n = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const out = n(u.output_tokens);
  const thinking = Math.min(out, n(u.output_tokens_details?.thinking_tokens));
  return {
    input: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    output: out - thinking,
    reasoning: thinking
  };
}

class ClaudeAdapter {
  sink;
  deps;
  current;
  models = new Map;
  transcripts = new Map;
  seenMessages = new Set;
  liveAgents = new Set;
  lastModel;
  constructor(sink, deps) {
    this.sink = sink;
    this.deps = deps;
  }
  get session() {
    return this.current;
  }
  get transcriptPath() {
    return this.current ? this.transcripts.get(this.current) : undefined;
  }
  learn(r) {
    if (!r.sid)
      return;
    if (r.tp)
      this.transcripts.set(r.sid, r.tp);
    if (r.model)
      this.models.set(r.sid, r.model);
  }
  focus(sid) {
    if (sid === this.current)
      return;
    this.current = sid;
    this.lastModel = undefined;
    this.liveAgents.clear();
    const ts = this.deps.now();
    this.sink({ t: "reset", ts, sessionKey: sid });
    this.sink({ t: "mode", ts, streaming: false });
    const m = this.models.get(sid);
    if (m)
      this.emitModel(m);
  }
  handleHook(r) {
    if (!r || typeof r.e !== "string" || !r.sid)
      return;
    this.learn(r);
    const pinned = this.deps.sessionID;
    if (pinned && r.sid !== pinned)
      return;
    if (pinned && this.current !== pinned)
      this.focus(pinned);
    if (!pinned && r.sid !== this.current && (r.e === "UserPromptSubmit" || r.e === "SessionStart" || !this.current))
      this.focus(r.sid);
    if (r.sid !== this.current)
      return;
    const ts = this.deps.now();
    const main = !r.aid;
    switch (r.e) {
      case "SessionStart":
      case "PostModelSwitch":
        if (r.model)
          this.emitModel(r.model);
        return;
      case "UserPromptSubmit":
        if (!main)
          return;
        this.sink({ t: "turn.start", ts });
        this.sink({ t: "step.start", ts });
        return;
      case "PreToolUse":
        if (main && r.id)
          this.sink({ t: "tool.start", ts, callID: r.id, tool: r.tool ?? "tool" });
        return;
      case "PostToolUse":
      case "PostToolUseFailure":
        if (main && r.id)
          this.sink({ t: "tool.end", ts, callID: r.id, ok: r.e === "PostToolUse" });
        return;
      case "PostToolBatch":
        if (main)
          this.sink({ t: "step.start", ts });
        return;
      case "SubagentStart":
        if (r.aid && r.at) {
          this.liveAgents.add(r.aid);
          this.sink({ t: "subagents", ts, busy: this.liveAgents.size });
        }
        return;
      case "SubagentStop":
        if (r.aid && this.liveAgents.delete(r.aid))
          this.sink({ t: "subagents", ts, busy: this.liveAgents.size });
        return;
      case "Stop":
        if (main)
          this.sink({ t: "idle", ts });
        return;
      case "StopFailure":
        if (main)
          this.sink({ t: "error", ts, message: r.err });
        return;
      case "SessionEnd":
        this.sink({ t: "idle", ts });
        return;
    }
  }
  handleTranscript(entry) {
    if (!entry || entry.type !== "assistant" || entry.isSidechain)
      return;
    const m = entry.message;
    if (!m || typeof m.id !== "string")
      return;
    if (typeof m.model === "string" && !m.model.startsWith("<"))
      this.emitModel(m.model);
    if (this.seenMessages.has(m.id))
      return;
    this.seenMessages.add(m.id);
    if (this.seenMessages.size > 5000)
      this.seenMessages.clear();
    const usage = usageFromAnthropic(m.usage);
    if (usage)
      this.sink({ t: "step.end", ts: this.deps.now(), usage, finish: typeof m.stop_reason === "string" ? m.stop_reason : undefined });
  }
  seedFromTranscript(entries) {
    for (let i = entries.length - 1;i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "assistant" || e.isSidechain || !e.message?.usage)
        continue;
      if (typeof e.message.id === "string")
        this.seenMessages.add(e.message.id);
      if (typeof e.message.model === "string" && !e.message.model.startsWith("<"))
        this.emitModel(e.message.model);
      const u = usageFromAnthropic(e.message.usage);
      this.sink({
        t: "step.end",
        ts: this.deps.now(),
        usage: { input: u.input + u.output + u.reasoning, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: 0, reasoning: 0 }
      });
      for (const x of entries)
        if (x?.type === "assistant" && typeof x.message?.id === "string")
          this.seenMessages.add(x.message.id);
      return;
    }
  }
  emitModel(model) {
    if (model === this.lastModel)
      return;
    this.lastModel = model;
    this.sink({ t: "model", ts: this.deps.now(), model: { providerID: "anthropic", modelID: model, contextLimit: claudeContextLimit(model) } });
  }
}
function claudeContextLimit(model) {
  return /\[1m\]/i.test(model) ? 1e6 : undefined;
}

// src/adapters/claude-tail.ts
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function findEventsFile(explicit, home = homedir()) {
  if (explicit)
    return explicit;
  const candidates = [];
  if (process.env.CLAUDE_PLUGIN_DATA)
    candidates.push(join(process.env.CLAUDE_PLUGIN_DATA, "events.ndjson"));
  const dataRoot = join(home, ".claude", "plugins", "data");
  try {
    for (const d of readdirSync(dataRoot))
      if (/inlineviz/i.test(d))
        candidates.push(join(dataRoot, d, "events.ndjson"));
  } catch {}
  candidates.push(join(home, ".claude", "inlineviz", "events.ndjson"));
  let best = candidates[candidates.length - 1];
  let bestM = -1;
  for (const c of candidates) {
    try {
      const m = statSync(c).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = c;
      }
    } catch {}
  }
  return best;
}
function readRange(path, from, to) {
  const len = Math.max(0, to - from);
  if (!len)
    return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}
function parseLines(text) {
  const out = [];
  for (const line of text.split(`
`)) {
    const s = line.trim();
    if (!s)
      continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

class Follower {
  path;
  offset = 0;
  rest = "";
  constructor(path, startAtEnd) {
    this.path = path;
    if (startAtEnd)
      this.offset = Math.max(0, sizeOf(path));
  }
  poll() {
    const size = sizeOf(this.path);
    if (size < 0)
      return [];
    if (size < this.offset) {
      this.offset = 0;
      this.rest = "";
    }
    if (size === this.offset)
      return [];
    const chunk = this.rest + readRange(this.path, this.offset, size);
    this.offset = size;
    const cut = chunk.lastIndexOf(`
`);
    if (cut < 0) {
      this.rest = chunk;
      return [];
    }
    this.rest = chunk.slice(cut + 1);
    return parseLines(chunk.slice(0, cut));
  }
}
function followClaude(o) {
  const adapter = new ClaudeAdapter(o.push, { now: o.now, sessionID: o.sessionID });
  let transcript;
  let eventsPath = "";
  let events;
  const followTranscript = () => {
    const tp = adapter.transcriptPath;
    if (!tp || transcript?.path === tp || !existsSync(tp))
      return;
    const size = sizeOf(tp);
    adapter.seedFromTranscript(parseLines(readRange(tp, Math.max(0, size - 2000000), size)));
    transcript = new Follower(tp, true);
  };
  const attach = (path) => {
    eventsPath = path;
    const size = Math.max(0, sizeOf(path));
    const recent = parseLines(readRange(path, Math.max(0, size - 512000), size));
    for (const r of recent)
      adapter.learn(r);
    const pick = o.sessionID ?? [...recent].reverse().find((r) => r.e === "UserPromptSubmit" || r.e === "SessionStart")?.sid ?? recent[recent.length - 1]?.sid;
    if (pick) {
      adapter.focus(pick);
      followTranscript();
      const mine = recent.filter((r) => r.sid === pick);
      let lastStop = -1;
      mine.forEach((r, i) => {
        if (r.e === "Stop" && !r.aid || r.e === "SessionEnd")
          lastStop = i;
      });
      const tail = mine.slice(lastStop + 1);
      const window = o.resumeWindowMs ?? 15 * 60000;
      if (tail.length && o.now() - tail[tail.length - 1].t < window)
        for (const r of tail)
          adapter.handleHook(r);
    }
    events = new Follower(path, true);
  };
  attach(findEventsFile(o.events, o.home));
  let polls = 0;
  const timer = setInterval(() => {
    if (!o.events && ++polls % 20 === 0) {
      const found = findEventsFile(undefined, o.home);
      if (found !== eventsPath && sizeOf(found) >= 0)
        attach(found);
    }
    for (const r of events?.poll() ?? []) {
      adapter.handleHook(r);
      followTranscript();
    }
    if (transcript)
      for (const e of transcript.poll())
        adapter.handleTranscript(e);
    else
      followTranscript();
  }, o.pollMs ?? 100);
  return {
    get eventsPath() {
      return eventsPath;
    },
    stop: () => clearInterval(timer)
  };
}
var init_claude_tail = () => {};

// node_modules/@opencode-ai/sdk/dist/gen/types.gen.js
var init_types_gen = () => {};

// node_modules/@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.js
var createSseClient = ({ onSseError, onSseEvent, responseTransformer, responseValidator, sseDefaultRetryDelay, sseMaxRetryAttempts, sseMaxRetryDelay, sseSleepFn, url, ...options }) => {
  let lastEventId;
  const sleep = sseSleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createStream = async function* () {
    let retryDelay = sseDefaultRetryDelay ?? 3000;
    let attempt = 0;
    const signal = options.signal ?? new AbortController().signal;
    while (true) {
      if (signal.aborted)
        break;
      attempt++;
      const headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
      if (lastEventId !== undefined) {
        headers.set("Last-Event-ID", lastEventId);
      }
      try {
        const response = await fetch(url, { ...options, headers, signal });
        if (!response.ok)
          throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
        if (!response.body)
          throw new Error("No body in SSE response");
        const reader = response.body.pipeThrough(new TextDecoderStream).getReader();
        let buffer = "";
        const abortHandler = () => {
          try {
            reader.cancel();
          } catch {}
        };
        signal.addEventListener("abort", abortHandler);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done)
              break;
            buffer += value;
            const chunks = buffer.split(`

`);
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const lines = chunk.split(`
`);
              const dataLines = [];
              let eventName;
              for (const line of lines) {
                if (line.startsWith("data:")) {
                  dataLines.push(line.replace(/^data:\s*/, ""));
                } else if (line.startsWith("event:")) {
                  eventName = line.replace(/^event:\s*/, "");
                } else if (line.startsWith("id:")) {
                  lastEventId = line.replace(/^id:\s*/, "");
                } else if (line.startsWith("retry:")) {
                  const parsed = Number.parseInt(line.replace(/^retry:\s*/, ""), 10);
                  if (!Number.isNaN(parsed)) {
                    retryDelay = parsed;
                  }
                }
              }
              let data;
              let parsedJson = false;
              if (dataLines.length) {
                const rawData = dataLines.join(`
`);
                try {
                  data = JSON.parse(rawData);
                  parsedJson = true;
                } catch {
                  data = rawData;
                }
              }
              if (parsedJson) {
                if (responseValidator) {
                  await responseValidator(data);
                }
                if (responseTransformer) {
                  data = await responseTransformer(data);
                }
              }
              onSseEvent?.({
                data,
                event: eventName,
                id: lastEventId,
                retry: retryDelay
              });
              if (dataLines.length) {
                yield data;
              }
            }
          }
        } finally {
          signal.removeEventListener("abort", abortHandler);
          reader.releaseLock();
        }
        break;
      } catch (error) {
        onSseError?.(error);
        if (sseMaxRetryAttempts !== undefined && attempt >= sseMaxRetryAttempts) {
          break;
        }
        const backoff = Math.min(retryDelay * 2 ** (attempt - 1), sseMaxRetryDelay ?? 30000);
        await sleep(backoff);
      }
    }
  };
  const stream = createStream();
  return { stream };
};

// node_modules/@opencode-ai/sdk/dist/gen/core/auth.gen.js
var getAuthToken = async (auth, callback) => {
  const token = typeof callback === "function" ? await callback(auth) : callback;
  if (!token) {
    return;
  }
  if (auth.scheme === "bearer") {
    return `Bearer ${token}`;
  }
  if (auth.scheme === "basic") {
    return `Basic ${btoa(token)}`;
  }
  return token;
};

// node_modules/@opencode-ai/sdk/dist/gen/core/bodySerializer.gen.js
var jsonBodySerializer;
var init_bodySerializer_gen = __esm(() => {
  jsonBodySerializer = {
    bodySerializer: (body) => JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value)
  };
});

// node_modules/@opencode-ai/sdk/dist/gen/core/pathSerializer.gen.js
var separatorArrayExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
}, separatorArrayNoExplode = (style) => {
  switch (style) {
    case "form":
      return ",";
    case "pipeDelimited":
      return "|";
    case "spaceDelimited":
      return "%20";
    default:
      return ",";
  }
}, separatorObjectExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
}, serializeArrayParam = ({ allowReserved, explode, name, style, value }) => {
  if (!explode) {
    const joinedValues = (allowReserved ? value : value.map((v) => encodeURIComponent(v))).join(separatorArrayNoExplode(style));
    switch (style) {
      case "label":
        return `.${joinedValues}`;
      case "matrix":
        return `;${name}=${joinedValues}`;
      case "simple":
        return joinedValues;
      default:
        return `${name}=${joinedValues}`;
    }
  }
  const separator = separatorArrayExplode(style);
  const joinedValues = value.map((v) => {
    if (style === "label" || style === "simple") {
      return allowReserved ? v : encodeURIComponent(v);
    }
    return serializePrimitiveParam({
      allowReserved,
      name,
      value: v
    });
  }).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
}, serializePrimitiveParam = ({ allowReserved, name, value }) => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error("Deeply-nested arrays/objects aren’t supported. Provide your own `querySerializer()` to handle these.");
  }
  return `${name}=${allowReserved ? value : encodeURIComponent(value)}`;
}, serializeObjectParam = ({ allowReserved, explode, name, style, value, valueOnly }) => {
  if (value instanceof Date) {
    return valueOnly ? value.toISOString() : `${name}=${value.toISOString()}`;
  }
  if (style !== "deepObject" && !explode) {
    let values = [];
    Object.entries(value).forEach(([key, v]) => {
      values = [...values, key, allowReserved ? v : encodeURIComponent(v)];
    });
    const joinedValues = values.join(",");
    switch (style) {
      case "form":
        return `${name}=${joinedValues}`;
      case "label":
        return `.${joinedValues}`;
      case "matrix":
        return `;${name}=${joinedValues}`;
      default:
        return joinedValues;
    }
  }
  const separator = separatorObjectExplode(style);
  const joinedValues = Object.entries(value).map(([key, v]) => serializePrimitiveParam({
    allowReserved,
    name: style === "deepObject" ? `${name}[${key}]` : key,
    value: v
  })).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
};

// node_modules/@opencode-ai/sdk/dist/gen/core/utils.gen.js
var PATH_PARAM_RE, defaultPathSerializer = ({ path, url: _url }) => {
  let url = _url;
  const matches = _url.match(PATH_PARAM_RE);
  if (matches) {
    for (const match of matches) {
      let explode = false;
      let name = match.substring(1, match.length - 1);
      let style = "simple";
      if (name.endsWith("*")) {
        explode = true;
        name = name.substring(0, name.length - 1);
      }
      if (name.startsWith(".")) {
        name = name.substring(1);
        style = "label";
      } else if (name.startsWith(";")) {
        name = name.substring(1);
        style = "matrix";
      }
      const value = path[name];
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        url = url.replace(match, serializeArrayParam({ explode, name, style, value }));
        continue;
      }
      if (typeof value === "object") {
        url = url.replace(match, serializeObjectParam({
          explode,
          name,
          style,
          value,
          valueOnly: true
        }));
        continue;
      }
      if (style === "matrix") {
        url = url.replace(match, `;${serializePrimitiveParam({
          name,
          value
        })}`);
        continue;
      }
      const replaceValue = encodeURIComponent(style === "label" ? `.${value}` : value);
      url = url.replace(match, replaceValue);
    }
  }
  return url;
}, getUrl = ({ baseUrl, path, query, querySerializer, url: _url }) => {
  const pathUrl = _url.startsWith("/") ? _url : `/${_url}`;
  let url = (baseUrl ?? "") + pathUrl;
  if (path) {
    url = defaultPathSerializer({ path, url });
  }
  let search = query ? querySerializer(query) : "";
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    url += `?${search}`;
  }
  return url;
};
var init_utils_gen = __esm(() => {
  PATH_PARAM_RE = /\{[^{}]+\}/g;
});

// node_modules/@opencode-ai/sdk/dist/gen/client/utils.gen.js
class Interceptors {
  _fns;
  constructor() {
    this._fns = [];
  }
  clear() {
    this._fns = [];
  }
  getInterceptorIndex(id) {
    if (typeof id === "number") {
      return this._fns[id] ? id : -1;
    } else {
      return this._fns.indexOf(id);
    }
  }
  exists(id) {
    const index = this.getInterceptorIndex(id);
    return !!this._fns[index];
  }
  eject(id) {
    const index = this.getInterceptorIndex(id);
    if (this._fns[index]) {
      this._fns[index] = null;
    }
  }
  update(id, fn) {
    const index = this.getInterceptorIndex(id);
    if (this._fns[index]) {
      this._fns[index] = fn;
      return id;
    } else {
      return false;
    }
  }
  use(fn) {
    this._fns = [...this._fns, fn];
    return this._fns.length - 1;
  }
}
var createQuerySerializer = ({ allowReserved, array, object } = {}) => {
  const querySerializer = (queryParams) => {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          const serializedArray = serializeArrayParam({
            allowReserved,
            explode: true,
            name,
            style: "form",
            value,
            ...array
          });
          if (serializedArray)
            search.push(serializedArray);
        } else if (typeof value === "object") {
          const serializedObject = serializeObjectParam({
            allowReserved,
            explode: true,
            name,
            style: "deepObject",
            value,
            ...object
          });
          if (serializedObject)
            search.push(serializedObject);
        } else {
          const serializedPrimitive = serializePrimitiveParam({
            allowReserved,
            name,
            value
          });
          if (serializedPrimitive)
            search.push(serializedPrimitive);
        }
      }
    }
    return search.join("&");
  };
  return querySerializer;
}, getParseAs = (contentType) => {
  if (!contentType) {
    return "stream";
  }
  const cleanContent = contentType.split(";")[0]?.trim();
  if (!cleanContent) {
    return;
  }
  if (cleanContent.startsWith("application/json") || cleanContent.endsWith("+json")) {
    return "json";
  }
  if (cleanContent === "multipart/form-data") {
    return "formData";
  }
  if (["application/", "audio/", "image/", "video/"].some((type) => cleanContent.startsWith(type))) {
    return "blob";
  }
  if (cleanContent.startsWith("text/")) {
    return "text";
  }
  return;
}, checkForExistence = (options, name) => {
  if (!name) {
    return false;
  }
  if (options.headers.has(name) || options.query?.[name] || options.headers.get("Cookie")?.includes(`${name}=`)) {
    return true;
  }
  return false;
}, setAuthParams = async ({ security, ...options }) => {
  for (const auth of security) {
    if (checkForExistence(options, auth.name)) {
      continue;
    }
    const token = await getAuthToken(auth, options.auth);
    if (!token) {
      continue;
    }
    const name = auth.name ?? "Authorization";
    switch (auth.in) {
      case "query":
        if (!options.query) {
          options.query = {};
        }
        options.query[name] = token;
        break;
      case "cookie":
        options.headers.append("Cookie", `${name}=${token}`);
        break;
      case "header":
      default:
        options.headers.set(name, token);
        break;
    }
  }
}, buildUrl = (options) => getUrl({
  baseUrl: options.baseUrl,
  path: options.path,
  query: options.query,
  querySerializer: typeof options.querySerializer === "function" ? options.querySerializer : createQuerySerializer(options.querySerializer),
  url: options.url
}), mergeConfigs = (a, b) => {
  const config = { ...a, ...b };
  if (config.baseUrl?.endsWith("/")) {
    config.baseUrl = config.baseUrl.substring(0, config.baseUrl.length - 1);
  }
  config.headers = mergeHeaders(a.headers, b.headers);
  return config;
}, mergeHeaders = (...headers) => {
  const mergedHeaders = new Headers;
  for (const header of headers) {
    if (!header || typeof header !== "object") {
      continue;
    }
    const iterator = header instanceof Headers ? header.entries() : Object.entries(header);
    for (const [key, value] of iterator) {
      if (value === null) {
        mergedHeaders.delete(key);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          mergedHeaders.append(key, v);
        }
      } else if (value !== undefined) {
        mergedHeaders.set(key, typeof value === "object" ? JSON.stringify(value) : value);
      }
    }
  }
  return mergedHeaders;
}, createInterceptors = () => ({
  error: new Interceptors,
  request: new Interceptors,
  response: new Interceptors
}), defaultQuerySerializer, defaultHeaders, createConfig = (override = {}) => ({
  ...jsonBodySerializer,
  headers: defaultHeaders,
  parseAs: "auto",
  querySerializer: defaultQuerySerializer,
  ...override
});
var init_utils_gen2 = __esm(() => {
  init_bodySerializer_gen();
  init_utils_gen();
  defaultQuerySerializer = createQuerySerializer({
    allowReserved: false,
    array: {
      explode: true,
      style: "form"
    },
    object: {
      explode: true,
      style: "deepObject"
    }
  });
  defaultHeaders = {
    "Content-Type": "application/json"
  };
});

// node_modules/@opencode-ai/sdk/dist/gen/client/client.gen.js
var createClient = (config = {}) => {
  let _config = mergeConfigs(createConfig(), config);
  const getConfig = () => ({ ..._config });
  const setConfig = (config) => {
    _config = mergeConfigs(_config, config);
    return getConfig();
  };
  const interceptors = createInterceptors();
  const beforeRequest = async (options) => {
    const opts = {
      ..._config,
      ...options,
      fetch: options.fetch ?? _config.fetch ?? globalThis.fetch,
      headers: mergeHeaders(_config.headers, options.headers),
      serializedBody: undefined
    };
    if (opts.security) {
      await setAuthParams({
        ...opts,
        security: opts.security
      });
    }
    if (opts.requestValidator) {
      await opts.requestValidator(opts);
    }
    if (opts.body && opts.bodySerializer) {
      opts.serializedBody = opts.bodySerializer(opts.body);
    }
    if (opts.serializedBody === undefined || opts.serializedBody === "") {
      opts.headers.delete("Content-Type");
    }
    const url = buildUrl(opts);
    return { opts, url };
  };
  const request = async (options) => {
    const { opts, url } = await beforeRequest(options);
    const requestInit = {
      redirect: "follow",
      ...opts,
      body: opts.serializedBody
    };
    let request = new Request(url, requestInit);
    for (const fn of interceptors.request._fns) {
      if (fn) {
        request = await fn(request, opts);
      }
    }
    const _fetch = opts.fetch;
    let response = await _fetch(request);
    for (const fn of interceptors.response._fns) {
      if (fn) {
        response = await fn(response, request, opts);
      }
    }
    const result = {
      request,
      response
    };
    if (response.ok) {
      if (response.status === 204 || response.headers.get("Content-Length") === "0") {
        return opts.responseStyle === "data" ? {} : {
          data: {},
          ...result
        };
      }
      const parseAs = (opts.parseAs === "auto" ? getParseAs(response.headers.get("Content-Type")) : opts.parseAs) ?? "json";
      let data;
      switch (parseAs) {
        case "arrayBuffer":
        case "blob":
        case "formData":
        case "json":
        case "text":
          data = await response[parseAs]();
          break;
        case "stream":
          return opts.responseStyle === "data" ? response.body : {
            data: response.body,
            ...result
          };
      }
      if (parseAs === "json") {
        if (opts.responseValidator) {
          await opts.responseValidator(data);
        }
        if (opts.responseTransformer) {
          data = await opts.responseTransformer(data);
        }
      }
      return opts.responseStyle === "data" ? data : {
        data,
        ...result
      };
    }
    const textError = await response.text();
    let jsonError;
    try {
      jsonError = JSON.parse(textError);
    } catch {}
    const error = jsonError ?? textError;
    let finalError = error;
    for (const fn of interceptors.error._fns) {
      if (fn) {
        finalError = await fn(error, response, request, opts);
      }
    }
    finalError = finalError || {};
    if (opts.throwOnError) {
      throw finalError;
    }
    return opts.responseStyle === "data" ? undefined : {
      error: finalError,
      ...result
    };
  };
  const makeMethod = (method) => {
    const fn = (options) => request({ ...options, method });
    fn.sse = async (options) => {
      const { opts, url } = await beforeRequest(options);
      return createSseClient({
        ...opts,
        body: opts.body,
        headers: opts.headers,
        method,
        url
      });
    };
    return fn;
  };
  return {
    buildUrl,
    connect: makeMethod("CONNECT"),
    delete: makeMethod("DELETE"),
    get: makeMethod("GET"),
    getConfig,
    head: makeMethod("HEAD"),
    interceptors,
    options: makeMethod("OPTIONS"),
    patch: makeMethod("PATCH"),
    post: makeMethod("POST"),
    put: makeMethod("PUT"),
    request,
    setConfig,
    trace: makeMethod("TRACE")
  };
};
var init_client_gen = __esm(() => {
  init_utils_gen2();
});

// node_modules/@opencode-ai/sdk/dist/gen/core/params.gen.js
var extraPrefixesMap, extraPrefixes;
var init_params_gen = __esm(() => {
  extraPrefixesMap = {
    $body_: "body",
    $headers_: "headers",
    $path_: "path",
    $query_: "query"
  };
  extraPrefixes = Object.entries(extraPrefixesMap);
});

// node_modules/@opencode-ai/sdk/dist/gen/client/index.js
var init_client = __esm(() => {
  init_bodySerializer_gen();
  init_params_gen();
  init_client_gen();
  init_utils_gen2();
});

// node_modules/@opencode-ai/sdk/dist/gen/client.gen.js
var client;
var init_client_gen2 = __esm(() => {
  init_client();
  client = createClient(createConfig({
    baseUrl: "http://localhost:4096"
  }));
});

// node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.js
class _HeyApiClient {
  _client = client;
  constructor(args) {
    if (args?.client) {
      this._client = args.client;
    }
  }
}
var Global, Project, Pty, Config, Tool, Instance, Path, Vcs, Session, Command, Oauth, Provider, Find, File, App, Auth, Mcp, Lsp, Formatter, Control, Tui, Event, OpencodeClient;
var init_sdk_gen = __esm(() => {
  init_client_gen2();
  Global = class Global extends _HeyApiClient {
    event(options) {
      return (options?.client ?? this._client).get.sse({
        url: "/global/event",
        ...options
      });
    }
  };
  Project = class Project extends _HeyApiClient {
    list(options) {
      return (options?.client ?? this._client).get({
        url: "/project",
        ...options
      });
    }
    current(options) {
      return (options?.client ?? this._client).get({
        url: "/project/current",
        ...options
      });
    }
  };
  Pty = class Pty extends _HeyApiClient {
    list(options) {
      return (options?.client ?? this._client).get({
        url: "/pty",
        ...options
      });
    }
    create(options) {
      return (options?.client ?? this._client).post({
        url: "/pty",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    remove(options) {
      return (options.client ?? this._client).delete({
        url: "/pty/{id}",
        ...options
      });
    }
    get(options) {
      return (options.client ?? this._client).get({
        url: "/pty/{id}",
        ...options
      });
    }
    update(options) {
      return (options.client ?? this._client).put({
        url: "/pty/{id}",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    connect(options) {
      return (options.client ?? this._client).get({
        url: "/pty/{id}/connect",
        ...options
      });
    }
  };
  Config = class Config extends _HeyApiClient {
    get(options) {
      return (options?.client ?? this._client).get({
        url: "/config",
        ...options
      });
    }
    update(options) {
      return (options?.client ?? this._client).patch({
        url: "/config",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    providers(options) {
      return (options?.client ?? this._client).get({
        url: "/config/providers",
        ...options
      });
    }
  };
  Tool = class Tool extends _HeyApiClient {
    ids(options) {
      return (options?.client ?? this._client).get({
        url: "/experimental/tool/ids",
        ...options
      });
    }
    list(options) {
      return (options.client ?? this._client).get({
        url: "/experimental/tool",
        ...options
      });
    }
  };
  Instance = class Instance extends _HeyApiClient {
    dispose(options) {
      return (options?.client ?? this._client).post({
        url: "/instance/dispose",
        ...options
      });
    }
  };
  Path = class Path extends _HeyApiClient {
    get(options) {
      return (options?.client ?? this._client).get({
        url: "/path",
        ...options
      });
    }
  };
  Vcs = class Vcs extends _HeyApiClient {
    get(options) {
      return (options?.client ?? this._client).get({
        url: "/vcs",
        ...options
      });
    }
  };
  Session = class Session extends _HeyApiClient {
    list(options) {
      return (options?.client ?? this._client).get({
        url: "/session",
        ...options
      });
    }
    create(options) {
      return (options?.client ?? this._client).post({
        url: "/session",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    status(options) {
      return (options?.client ?? this._client).get({
        url: "/session/status",
        ...options
      });
    }
    delete(options) {
      return (options.client ?? this._client).delete({
        url: "/session/{id}",
        ...options
      });
    }
    get(options) {
      return (options.client ?? this._client).get({
        url: "/session/{id}",
        ...options
      });
    }
    update(options) {
      return (options.client ?? this._client).patch({
        url: "/session/{id}",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    children(options) {
      return (options.client ?? this._client).get({
        url: "/session/{id}/children",
        ...options
      });
    }
    todo(options) {
      return (options.client ?? this._client).get({
        url: "/session/{id}/todo",
        ...options
      });
    }
    init(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/init",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    fork(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/fork",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    abort(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/abort",
        ...options
      });
    }
    unshare(options) {
      return (options.client ?? this._client).delete({
        url: "/session/{id}/share",
        ...options
      });
    }
    share(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/share",
        ...options
      });
    }
    diff(options) {
      return (options.client ?? this._client).get({
        url: "/session/{id}/diff",
        ...options
      });
    }
    summarize(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/summarize",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    messages(options) {
      return (options.client ?? this._client).get({
        url: "/session/{id}/message",
        ...options
      });
    }
    prompt(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/message",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    message(options) {
      return (options.client ?? this._client).get({
        url: "/session/{id}/message/{messageID}",
        ...options
      });
    }
    promptAsync(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/prompt_async",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    command(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/command",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    shell(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/shell",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    revert(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/revert",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    unrevert(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/unrevert",
        ...options
      });
    }
  };
  Command = class Command extends _HeyApiClient {
    list(options) {
      return (options?.client ?? this._client).get({
        url: "/command",
        ...options
      });
    }
  };
  Oauth = class Oauth extends _HeyApiClient {
    authorize(options) {
      return (options.client ?? this._client).post({
        url: "/provider/{id}/oauth/authorize",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    callback(options) {
      return (options.client ?? this._client).post({
        url: "/provider/{id}/oauth/callback",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
  };
  Provider = class Provider extends _HeyApiClient {
    list(options) {
      return (options?.client ?? this._client).get({
        url: "/provider",
        ...options
      });
    }
    auth(options) {
      return (options?.client ?? this._client).get({
        url: "/provider/auth",
        ...options
      });
    }
    oauth = new Oauth({ client: this._client });
  };
  Find = class Find extends _HeyApiClient {
    text(options) {
      return (options.client ?? this._client).get({
        url: "/find",
        ...options
      });
    }
    files(options) {
      return (options.client ?? this._client).get({
        url: "/find/file",
        ...options
      });
    }
    symbols(options) {
      return (options.client ?? this._client).get({
        url: "/find/symbol",
        ...options
      });
    }
  };
  File = class File extends _HeyApiClient {
    list(options) {
      return (options.client ?? this._client).get({
        url: "/file",
        ...options
      });
    }
    read(options) {
      return (options.client ?? this._client).get({
        url: "/file/content",
        ...options
      });
    }
    status(options) {
      return (options?.client ?? this._client).get({
        url: "/file/status",
        ...options
      });
    }
  };
  App = class App extends _HeyApiClient {
    log(options) {
      return (options?.client ?? this._client).post({
        url: "/log",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    agents(options) {
      return (options?.client ?? this._client).get({
        url: "/agent",
        ...options
      });
    }
  };
  Auth = class Auth extends _HeyApiClient {
    remove(options) {
      return (options.client ?? this._client).delete({
        url: "/mcp/{name}/auth",
        ...options
      });
    }
    start(options) {
      return (options.client ?? this._client).post({
        url: "/mcp/{name}/auth",
        ...options
      });
    }
    callback(options) {
      return (options.client ?? this._client).post({
        url: "/mcp/{name}/auth/callback",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    authenticate(options) {
      return (options.client ?? this._client).post({
        url: "/mcp/{name}/auth/authenticate",
        ...options
      });
    }
    set(options) {
      return (options.client ?? this._client).put({
        url: "/auth/{id}",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
  };
  Mcp = class Mcp extends _HeyApiClient {
    status(options) {
      return (options?.client ?? this._client).get({
        url: "/mcp",
        ...options
      });
    }
    add(options) {
      return (options?.client ?? this._client).post({
        url: "/mcp",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    connect(options) {
      return (options.client ?? this._client).post({
        url: "/mcp/{name}/connect",
        ...options
      });
    }
    disconnect(options) {
      return (options.client ?? this._client).post({
        url: "/mcp/{name}/disconnect",
        ...options
      });
    }
    auth = new Auth({ client: this._client });
  };
  Lsp = class Lsp extends _HeyApiClient {
    status(options) {
      return (options?.client ?? this._client).get({
        url: "/lsp",
        ...options
      });
    }
  };
  Formatter = class Formatter extends _HeyApiClient {
    status(options) {
      return (options?.client ?? this._client).get({
        url: "/formatter",
        ...options
      });
    }
  };
  Control = class Control extends _HeyApiClient {
    next(options) {
      return (options?.client ?? this._client).get({
        url: "/tui/control/next",
        ...options
      });
    }
    response(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/control/response",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
  };
  Tui = class Tui extends _HeyApiClient {
    appendPrompt(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/append-prompt",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    openHelp(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/open-help",
        ...options
      });
    }
    openSessions(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/open-sessions",
        ...options
      });
    }
    openThemes(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/open-themes",
        ...options
      });
    }
    openModels(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/open-models",
        ...options
      });
    }
    submitPrompt(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/submit-prompt",
        ...options
      });
    }
    clearPrompt(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/clear-prompt",
        ...options
      });
    }
    executeCommand(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/execute-command",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    showToast(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/show-toast",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    publish(options) {
      return (options?.client ?? this._client).post({
        url: "/tui/publish",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
    }
    control = new Control({ client: this._client });
  };
  Event = class Event extends _HeyApiClient {
    subscribe(options) {
      return (options?.client ?? this._client).get.sse({
        url: "/event",
        ...options
      });
    }
  };
  OpencodeClient = class OpencodeClient extends _HeyApiClient {
    postSessionIdPermissionsPermissionId(options) {
      return (options.client ?? this._client).post({
        url: "/session/{id}/permissions/{permissionID}",
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
    }
    global = new Global({ client: this._client });
    project = new Project({ client: this._client });
    pty = new Pty({ client: this._client });
    config = new Config({ client: this._client });
    tool = new Tool({ client: this._client });
    instance = new Instance({ client: this._client });
    path = new Path({ client: this._client });
    vcs = new Vcs({ client: this._client });
    session = new Session({ client: this._client });
    command = new Command({ client: this._client });
    provider = new Provider({ client: this._client });
    find = new Find({ client: this._client });
    file = new File({ client: this._client });
    app = new App({ client: this._client });
    mcp = new Mcp({ client: this._client });
    lsp = new Lsp({ client: this._client });
    formatter = new Formatter({ client: this._client });
    tui = new Tui({ client: this._client });
    auth = new Auth({ client: this._client });
    event = new Event({ client: this._client });
  };
});

// node_modules/@opencode-ai/sdk/dist/error-interceptor.js
function wrapClientError(error, response, request, opts) {
  if (!opts?.throwOnError)
    return error;
  if (error instanceof Error)
    return error;
  if (typeof error === "object" && error !== null && Object.keys(error).length > 0) {
    const obj = error;
    const message = typeof obj.data?.message === "string" && obj.data.message || typeof obj.message === "string" && obj.message || typeof obj.name === "string" && obj.name || describe(request, response);
    return new Error(message, { cause: { body: error, status: response?.status } });
  }
  if (typeof error === "string" && error.length > 0) {
    return new Error(error, { cause: { body: error, status: response?.status } });
  }
  const reason = response ? "(empty response body)" : "network error (no response)";
  return new Error(`opencode server ${describe(request, response)}: ${reason}`, {
    cause: { body: error, status: response?.status }
  });
}
function describe(request, response) {
  const method = request?.method ?? "?";
  const url = request?.url ?? "?";
  const status = response?.status;
  const statusText = response?.statusText;
  return `${method} ${url}${status ? " → " + status : ""}${statusText ? " " + statusText : ""}`;
}

// node_modules/@opencode-ai/sdk/dist/client.js
function pick(value, fallback) {
  if (!value)
    return;
  if (!fallback)
    return value;
  if (value === fallback)
    return fallback;
  if (value === encodeURIComponent(fallback))
    return fallback;
  return value;
}
function rewrite(request, directory) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return request;
  const value = pick(request.headers.get("x-opencode-directory"), directory);
  if (!value)
    return request;
  const url = new URL(request.url);
  if (!url.searchParams.has("directory")) {
    url.searchParams.set("directory", value);
  }
  const next = new Request(url, request);
  next.headers.delete("x-opencode-directory");
  return next;
}
function createOpencodeClient(config) {
  if (!config?.fetch) {
    const customFetch = (req) => {
      req.timeout = false;
      return fetch(req);
    };
    config = {
      ...config,
      fetch: customFetch
    };
  }
  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURIComponent(config.directory)
    };
  }
  const client = createClient(config);
  client.interceptors.request.use((request) => rewrite(request, config?.directory));
  client.interceptors.error.use(wrapClientError);
  return new OpencodeClient({ client });
}
var init_client2 = __esm(() => {
  init_client_gen();
  init_sdk_gen();
  init_types_gen();
});

// node_modules/isexe/windows.js
var require_windows = __commonJS(function(exports, module) {
  module.exports = isexe;
  isexe.sync = sync;
  var fs = __require("fs");
  function checkPathExt(path, options) {
    var pathext = options.pathExt !== undefined ? options.pathExt : process.env.PATHEXT;
    if (!pathext) {
      return true;
    }
    pathext = pathext.split(";");
    if (pathext.indexOf("") !== -1) {
      return true;
    }
    for (var i = 0;i < pathext.length; i++) {
      var p = pathext[i].toLowerCase();
      if (p && path.substr(-p.length).toLowerCase() === p) {
        return true;
      }
    }
    return false;
  }
  function checkStat(stat, path, options) {
    if (!stat.isSymbolicLink() && !stat.isFile()) {
      return false;
    }
    return checkPathExt(path, options);
  }
  function isexe(path, options, cb) {
    fs.stat(path, function(er, stat) {
      cb(er, er ? false : checkStat(stat, path, options));
    });
  }
  function sync(path, options) {
    return checkStat(fs.statSync(path), path, options);
  }
});

// node_modules/isexe/mode.js
var require_mode = __commonJS(function(exports, module) {
  module.exports = isexe;
  isexe.sync = sync;
  var fs = __require("fs");
  function isexe(path, options, cb) {
    fs.stat(path, function(er, stat) {
      cb(er, er ? false : checkStat(stat, options));
    });
  }
  function sync(path, options) {
    return checkStat(fs.statSync(path), options);
  }
  function checkStat(stat, options) {
    return stat.isFile() && checkMode(stat, options);
  }
  function checkMode(stat, options) {
    var mod = stat.mode;
    var uid = stat.uid;
    var gid = stat.gid;
    var myUid = options.uid !== undefined ? options.uid : process.getuid && process.getuid();
    var myGid = options.gid !== undefined ? options.gid : process.getgid && process.getgid();
    var u = parseInt("100", 8);
    var g = parseInt("010", 8);
    var o = parseInt("001", 8);
    var ug = u | g;
    var ret = mod & o || mod & g && gid === myGid || mod & u && uid === myUid || mod & ug && myUid === 0;
    return ret;
  }
});

// node_modules/isexe/index.js
var require_isexe = __commonJS(function(exports, module) {
  var fs = __require("fs");
  var core;
  if (process.platform === "win32" || global.TESTING_WINDOWS) {
    core = require_windows();
  } else {
    core = require_mode();
  }
  module.exports = isexe;
  isexe.sync = sync;
  function isexe(path, options, cb) {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    if (!cb) {
      if (typeof Promise !== "function") {
        throw new TypeError("callback not provided");
      }
      return new Promise(function(resolve, reject) {
        isexe(path, options || {}, function(er, is) {
          if (er) {
            reject(er);
          } else {
            resolve(is);
          }
        });
      });
    }
    core(path, options || {}, function(er, is) {
      if (er) {
        if (er.code === "EACCES" || options && options.ignoreErrors) {
          er = null;
          is = false;
        }
      }
      cb(er, is);
    });
  }
  function sync(path, options) {
    try {
      return core.sync(path, options || {});
    } catch (er) {
      if (options && options.ignoreErrors || er.code === "EACCES") {
        return false;
      } else {
        throw er;
      }
    }
  }
});

// node_modules/which/which.js
var require_which = __commonJS(function(exports, module) {
  var isWindows = process.platform === "win32" || process.env.OSTYPE === "cygwin" || process.env.OSTYPE === "msys";
  var path = __require("path");
  var COLON = isWindows ? ";" : ":";
  var isexe = require_isexe();
  var getNotFoundError = (cmd) => Object.assign(new Error(`not found: ${cmd}`), { code: "ENOENT" });
  var getPathInfo = (cmd, opt) => {
    const colon = opt.colon || COLON;
    const pathEnv = cmd.match(/\//) || isWindows && cmd.match(/\\/) ? [""] : [
      ...isWindows ? [process.cwd()] : [],
      ...(opt.path || process.env.PATH || "").split(colon)
    ];
    const pathExtExe = isWindows ? opt.pathExt || process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM" : "";
    const pathExt = isWindows ? pathExtExe.split(colon) : [""];
    if (isWindows) {
      if (cmd.indexOf(".") !== -1 && pathExt[0] !== "")
        pathExt.unshift("");
    }
    return {
      pathEnv,
      pathExt,
      pathExtExe
    };
  };
  var which = (cmd, opt, cb) => {
    if (typeof opt === "function") {
      cb = opt;
      opt = {};
    }
    if (!opt)
      opt = {};
    const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt);
    const found = [];
    const step = (i) => new Promise((resolve, reject) => {
      if (i === pathEnv.length)
        return opt.all && found.length ? resolve(found) : reject(getNotFoundError(cmd));
      const ppRaw = pathEnv[i];
      const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw;
      const pCmd = path.join(pathPart, cmd);
      const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd : pCmd;
      resolve(subStep(p, i, 0));
    });
    const subStep = (p, i, ii) => new Promise((resolve, reject) => {
      if (ii === pathExt.length)
        return resolve(step(i + 1));
      const ext = pathExt[ii];
      isexe(p + ext, { pathExt: pathExtExe }, (er, is) => {
        if (!er && is) {
          if (opt.all)
            found.push(p + ext);
          else
            return resolve(p + ext);
        }
        return resolve(subStep(p, i, ii + 1));
      });
    });
    return cb ? step(0).then((res) => cb(null, res), cb) : step(0);
  };
  var whichSync = (cmd, opt) => {
    opt = opt || {};
    const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt);
    const found = [];
    for (let i = 0;i < pathEnv.length; i++) {
      const ppRaw = pathEnv[i];
      const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw;
      const pCmd = path.join(pathPart, cmd);
      const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd : pCmd;
      for (let j = 0;j < pathExt.length; j++) {
        const cur = p + pathExt[j];
        try {
          const is = isexe.sync(cur, { pathExt: pathExtExe });
          if (is) {
            if (opt.all)
              found.push(cur);
            else
              return cur;
          }
        } catch (ex) {}
      }
    }
    if (opt.all && found.length)
      return found;
    if (opt.nothrow)
      return null;
    throw getNotFoundError(cmd);
  };
  module.exports = which;
  which.sync = whichSync;
});

// node_modules/path-key/index.js
var require_path_key = __commonJS(function(exports, module) {
  var pathKey = (options = {}) => {
    const environment = options.env || process.env;
    const platform = options.platform || process.platform;
    if (platform !== "win32") {
      return "PATH";
    }
    return Object.keys(environment).reverse().find((key) => key.toUpperCase() === "PATH") || "Path";
  };
  module.exports = pathKey;
  module.exports.default = pathKey;
});

// node_modules/cross-spawn/lib/util/resolveCommand.js
var require_resolveCommand = __commonJS(function(exports, module) {
  var path = __require("path");
  var which = require_which();
  var getPathKey = require_path_key();
  function resolveCommandAttempt(parsed, withoutPathExt) {
    const env = parsed.options.env || process.env;
    const cwd = process.cwd();
    const hasCustomCwd = parsed.options.cwd != null;
    const shouldSwitchCwd = hasCustomCwd && process.chdir !== undefined && !process.chdir.disabled;
    if (shouldSwitchCwd) {
      try {
        process.chdir(parsed.options.cwd);
      } catch (err) {}
    }
    let resolved;
    try {
      resolved = which.sync(parsed.command, {
        path: env[getPathKey({ env })],
        pathExt: withoutPathExt ? path.delimiter : undefined
      });
    } catch (e) {} finally {
      if (shouldSwitchCwd) {
        process.chdir(cwd);
      }
    }
    if (resolved) {
      resolved = path.resolve(hasCustomCwd ? parsed.options.cwd : "", resolved);
    }
    return resolved;
  }
  function resolveCommand(parsed) {
    return resolveCommandAttempt(parsed) || resolveCommandAttempt(parsed, true);
  }
  module.exports = resolveCommand;
});

// node_modules/cross-spawn/lib/util/escape.js
var require_escape = __commonJS(function(exports, module) {
  var metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;
  function escapeCommand(arg) {
    arg = arg.replace(metaCharsRegExp, "^$1");
    return arg;
  }
  function escapeArgument(arg, doubleEscapeMetaChars) {
    arg = `${arg}`;
    arg = arg.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
    arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
    arg = `"${arg}"`;
    arg = arg.replace(metaCharsRegExp, "^$1");
    if (doubleEscapeMetaChars) {
      arg = arg.replace(metaCharsRegExp, "^$1");
    }
    return arg;
  }
  exports.command = escapeCommand;
  exports.argument = escapeArgument;
});

// node_modules/shebang-regex/index.js
var require_shebang_regex = __commonJS(function(exports, module) {
  module.exports = /^#!(.*)/;
});

// node_modules/shebang-command/index.js
var require_shebang_command = __commonJS(function(exports, module) {
  var shebangRegex = require_shebang_regex();
  module.exports = (string = "") => {
    const match = string.match(shebangRegex);
    if (!match) {
      return null;
    }
    const [path, argument] = match[0].replace(/#! ?/, "").split(" ");
    const binary = path.split("/").pop();
    if (binary === "env") {
      return argument;
    }
    return argument ? `${binary} ${argument}` : binary;
  };
});

// node_modules/cross-spawn/lib/util/readShebang.js
var require_readShebang = __commonJS(function(exports, module) {
  var fs = __require("fs");
  var shebangCommand = require_shebang_command();
  function readShebang(command) {
    const size = 150;
    const buffer = Buffer.alloc(size);
    let fd;
    try {
      fd = fs.openSync(command, "r");
      fs.readSync(fd, buffer, 0, size, 0);
      fs.closeSync(fd);
    } catch (e) {}
    return shebangCommand(buffer.toString());
  }
  module.exports = readShebang;
});

// node_modules/cross-spawn/lib/parse.js
var require_parse = __commonJS(function(exports, module) {
  var path = __require("path");
  var resolveCommand = require_resolveCommand();
  var escape = require_escape();
  var readShebang = require_readShebang();
  var isWin = process.platform === "win32";
  var isExecutableRegExp = /\.(?:com|exe)$/i;
  var isCmdShimRegExp = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;
  function detectShebang(parsed) {
    parsed.file = resolveCommand(parsed);
    const shebang = parsed.file && readShebang(parsed.file);
    if (shebang) {
      parsed.args.unshift(parsed.file);
      parsed.command = shebang;
      return resolveCommand(parsed);
    }
    return parsed.file;
  }
  function parseNonShell(parsed) {
    if (!isWin) {
      return parsed;
    }
    const commandFile = detectShebang(parsed);
    const needsShell = !isExecutableRegExp.test(commandFile);
    if (parsed.options.forceShell || needsShell) {
      const needsDoubleEscapeMetaChars = isCmdShimRegExp.test(commandFile);
      parsed.command = path.normalize(parsed.command);
      parsed.command = escape.command(parsed.command);
      parsed.args = parsed.args.map((arg) => escape.argument(arg, needsDoubleEscapeMetaChars));
      const shellCommand = [parsed.command].concat(parsed.args).join(" ");
      parsed.args = ["/d", "/s", "/c", `"${shellCommand}"`];
      parsed.command = process.env.comspec || "cmd.exe";
      parsed.options.windowsVerbatimArguments = true;
    }
    return parsed;
  }
  function parse(command, args, options) {
    if (args && !Array.isArray(args)) {
      options = args;
      args = null;
    }
    args = args ? args.slice(0) : [];
    options = Object.assign({}, options);
    const parsed = {
      command,
      args,
      options,
      file: undefined,
      original: {
        command,
        args
      }
    };
    return options.shell ? parsed : parseNonShell(parsed);
  }
  module.exports = parse;
});

// node_modules/cross-spawn/lib/enoent.js
var require_enoent = __commonJS(function(exports, module) {
  var isWin = process.platform === "win32";
  function notFoundError(original, syscall) {
    return Object.assign(new Error(`${syscall} ${original.command} ENOENT`), {
      code: "ENOENT",
      errno: "ENOENT",
      syscall: `${syscall} ${original.command}`,
      path: original.command,
      spawnargs: original.args
    });
  }
  function hookChildProcess(cp, parsed) {
    if (!isWin) {
      return;
    }
    const originalEmit = cp.emit;
    cp.emit = function(name, arg1) {
      if (name === "exit") {
        const err = verifyENOENT(arg1, parsed);
        if (err) {
          return originalEmit.call(cp, "error", err);
        }
      }
      return originalEmit.apply(cp, arguments);
    };
  }
  function verifyENOENT(status, parsed) {
    if (isWin && status === 1 && !parsed.file) {
      return notFoundError(parsed.original, "spawn");
    }
    return null;
  }
  function verifyENOENTSync(status, parsed) {
    if (isWin && status === 1 && !parsed.file) {
      return notFoundError(parsed.original, "spawnSync");
    }
    return null;
  }
  module.exports = {
    hookChildProcess,
    verifyENOENT,
    verifyENOENTSync,
    notFoundError
  };
});

// node_modules/cross-spawn/index.js
var require_cross_spawn = __commonJS(function(exports, module) {
  var cp = __require("child_process");
  var parse = require_parse();
  var enoent = require_enoent();
  function spawn(command, args, options) {
    const parsed = parse(command, args, options);
    const spawned = cp.spawn(parsed.command, parsed.args, parsed.options);
    enoent.hookChildProcess(spawned, parsed);
    return spawned;
  }
  function spawnSync(command, args, options) {
    const parsed = parse(command, args, options);
    const result = cp.spawnSync(parsed.command, parsed.args, parsed.options);
    result.error = result.error || enoent.verifyENOENTSync(result.status, parsed);
    return result;
  }
  module.exports = spawn;
  module.exports.spawn = spawn;
  module.exports.sync = spawnSync;
  module.exports._parse = parse;
  module.exports._enoent = enoent;
});

// node_modules/@opencode-ai/sdk/dist/process.js
var init_process = () => {};

// node_modules/@opencode-ai/sdk/dist/server.js
var import_cross_spawn;
var init_server = __esm(() => {
  init_process();
  import_cross_spawn = __toESM(require_cross_spawn(), 1);
});

// node_modules/@opencode-ai/sdk/dist/index.js
var init_dist = __esm(() => {
  init_client2();
  init_server();
  init_client2();
  init_server();
});

// src/core/archparse.ts
function fullAttention(layerTypes) {
  if (!Array.isArray(layerTypes) || !layerTypes.length)
    return;
  const idx = layerTypes.flatMap((t, i) => typeof t === "string" && /full/i.test(t) ? [i + 1] : []);
  return idx.length && idx.length < layerTypes.length ? idx : undefined;
}
function archFromHFConfig(cfg, family) {
  if (!cfg || typeof cfg !== "object")
    return;
  const top = cfg;
  const t = top.text_config && typeof top.text_config === "object" ? top.text_config : top;
  const pick = (...keys) => first(...keys.map((k) => t[k]), ...keys.map((k) => top[k]));
  const layers = pick("num_hidden_layers", "n_layer", "num_layers", "n_layers");
  if (!layers)
    return;
  const fam = family ?? String(t.model_type ?? top.model_type ?? "hf");
  const experts = pick("num_experts", "num_local_experts", "n_routed_experts", "moe_num_experts", "n_experts");
  const active = pick("num_experts_per_tok", "num_selected_experts", "moe_top_k", "moe_topk", "top_k_experts");
  const fa = fullAttention(t.layer_types ?? top.layer_types);
  if (experts && experts > 1 && active) {
    const shared = first(t.n_shared_experts, t.num_shared_experts, top.n_shared_experts) ?? (num(t.shared_expert_intermediate_size ?? top.shared_expert_intermediate_size) ? 1 : 0);
    return { kind: "moe", family: fam, layers, experts, active, shared, source: "hf", ...fa ? { fullAttention: fa } : {} };
  }
  return { kind: "dense", family: fam, layers, source: "hf", ...fa ? { fullAttention: fa } : {} };
}
function archFromOllamaShow(show, family) {
  const info = show?.model_info;
  if (!info || typeof info !== "object")
    return;
  const find = (suffix) => {
    for (const [k, v] of Object.entries(info))
      if (k.endsWith(suffix))
        return num(v);
    return;
  };
  const layers = find(".block_count");
  if (!layers)
    return;
  const arch = String(info["general.architecture"] ?? family ?? "ollama");
  const experts = find(".expert_count");
  const active = find(".expert_used_count");
  if (experts && experts > 1 && active) {
    return { kind: "moe", family: family ?? arch, layers, experts, active, shared: find(".expert_shared_count") ?? 0, source: "server" };
  }
  return { kind: "dense", family: family ?? arch, layers, source: "server" };
}
function archFromServerMeta(meta, family) {
  if (!meta || typeof meta !== "object")
    return {};
  const m = meta;
  const layers = first(m.num_layers, m.n_layer, m.num_hidden_layers, m.block_count);
  const isMoe = typeof m.is_moe === "boolean" ? m.is_moe : undefined;
  const experts = first(m.num_experts, m.expert_count);
  const active = first(m.num_experts_per_tok, m.expert_used_count);
  const fam = family ?? String(m.architecture ?? "server");
  if (layers && experts && experts > 1 && active) {
    return { arch: { kind: "moe", family: fam, layers, experts, active, shared: first(m.n_shared_experts, m.expert_shared_count) ?? 0, source: "server" }, layers, isMoe: true };
  }
  if (layers && isMoe === false)
    return { arch: { kind: "dense", family: fam, layers, source: "server" }, layers, isMoe };
  return { layers, isMoe };
}
function mergeArch(server, hf) {
  if (server?.arch)
    return server.arch;
  if (!hf)
    return;
  if (hf.kind === "unknown")
    return hf;
  const layers = server?.layers ?? hf.layers;
  if (server?.isMoe === false)
    return { kind: "dense", family: hf.family, layers, source: "server", ...hf.fullAttention ? { fullAttention: hf.fullAttention } : {} };
  if (server?.isMoe === true && hf.kind === "dense")
    return;
  return { ...hf, layers };
}
function looksLikeHFRepo(modelID) {
  return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(modelID) && !modelID.includes("..");
}
var num = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined, first = (...vs) => {
  for (const v of vs) {
    const n = num(v);
    if (n !== undefined)
      return n;
  }
  return;
};

// src/adapters/discover.ts
async function discoverArch(input, deps) {
  if (deps.lookup === "off")
    return;
  const key = `inlineviz.arch:${input.providerID}/${input.modelID}`;
  const cached = deps.cache?.get(key);
  if (cached && typeof cached.at === "number" && deps.now() - cached.at < (cached.arch ? TTL_HIT : TTL_MISS)) {
    deps.log?.({ tag: "arch", modelID: input.modelID, from: "cache", arch: cached.arch ?? null });
    return cached.arch;
  }
  const timeout = deps.timeoutMs ?? 4000;
  const getJson = async (url, init) => {
    try {
      const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (!res.ok)
        return;
      return await res.json();
    } catch {
      return;
    }
  };
  let server;
  const base = input.baseURL?.replace(/\/+$/, "");
  if (base && /^https?:\/\//.test(base)) {
    const list = await getJson(`${base}/models`);
    const entry = Array.isArray(list?.data) ? list.data.find((m) => m?.id === input.modelID) : undefined;
    if (entry?.meta)
      server = archFromServerMeta(entry.meta);
    if (!server?.arch) {
      const origin = new URL(base).origin;
      const version = await getJson(`${origin}/api/version`);
      if (version && typeof version.version === "string") {
        const show = await getJson(`${origin}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: input.modelID })
        });
        const o = archFromOllamaShow(show);
        if (o)
          server = { arch: o, layers: o.kind === "unknown" ? undefined : o.layers };
      }
    }
  }
  let hf;
  if (deps.lookup === "all" && looksLikeHFRepo(input.modelID)) {
    hf = archFromHFConfig(await getJson(`https://huggingface.co/${input.modelID}/raw/main/config.json`));
  }
  let arch = mergeArch(server, hf);
  if (arch && server?.arch && hf && hf.kind === arch.kind && arch.kind !== "unknown" && hf.kind !== "unknown" && hf.layers === arch.layers && hf.fullAttention && !arch.fullAttention) {
    arch = { ...arch, fullAttention: hf.fullAttention };
  }
  deps.cache?.set(key, { at: deps.now(), ...arch ? { arch } : {} });
  deps.log?.({ tag: "arch", modelID: input.modelID, from: arch?.source ?? "none", arch: arch ?? null });
  return arch;
}
var DAY, TTL_HIT, TTL_MISS;
var init_discover = __esm(() => {
  DAY = 24 * 3600 * 1000;
  TTL_HIT = 7 * DAY;
  TTL_MISS = DAY;
});

// src/adapters/opencode.ts
function usageFromTokens(t) {
  if (!t)
    return;
  const n = (v) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
  return { input: n(t.input), output: n(t.output), reasoning: n(t.reasoning), cacheRead: n(t.cache?.read), cacheWrite: n(t.cache?.write) };
}

class OpenCodeAdapter {
  sink;
  deps;
  current;
  followed;
  roles = new Map;
  live = new Set;
  partKind = new Map;
  seen = new Map;
  toolStarted = new Set;
  toolEnded = new Set;
  busy = new Map;
  nextPath = new Set;
  lastModelKey;
  lastSubagents = -1;
  constructor(sink, deps) {
    this.sink = sink;
    this.deps = deps;
  }
  get session() {
    return this.current;
  }
  sync() {
    this.focus(undefined);
  }
  handle(ev) {
    const p = ev.properties ?? {};
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    const wasBusy = sid ? this.busy.get(sid) ?? false : false;
    if (ev.type === "session.status" && sid)
      this.trackBusy(sid, p.status?.type === "busy" || p.status?.type === "retry");
    if (ev.type === "session.idle" && sid)
      this.trackBusy(sid, false);
    if (!this.focus(sid))
      return;
    const ts = this.deps.now();
    switch (ev.type) {
      case "session.status": {
        const type = p.status?.type;
        if (type === "busy" && !wasBusy)
          this.sink({ t: "turn.start", ts });
        else if (type === "retry")
          this.sink({ t: "retry", ts, attempt: Number(p.status.attempt ?? 1), message: p.status.message });
        else if (type === "idle")
          this.sink({ t: "idle", ts });
        return;
      }
      case "session.idle":
        this.sink({ t: "idle", ts });
        return;
      case "session.error":
        this.sink({ t: "error", ts, message: errorMessage(p.error) });
        return;
      case "message.updated": {
        const info = p.info;
        if (!info?.id)
          return;
        this.roles.set(info.id, info.role);
        if (info.role !== "assistant")
          return;
        if (info.time?.completed)
          this.live.delete(info.id);
        else
          this.live.add(info.id);
        if (info.providerID && info.modelID) {
          const key = `${info.providerID}/${info.modelID}`;
          if (key !== this.lastModelKey) {
            this.lastModelKey = key;
            this.sink({
              t: "model",
              ts,
              model: { providerID: info.providerID, modelID: info.modelID, contextLimit: this.deps.contextLimit(info.providerID, info.modelID) }
            });
          }
        }
        return;
      }
      case "message.part.updated": {
        const part = p.part;
        if (!part?.type)
          return;
        switch (part.type) {
          case "step-start":
            this.sink({ t: "step.start", ts });
            return;
          case "step-finish":
            this.sink({ t: "step.end", ts, usage: usageFromTokens(part.tokens), finish: part.reason });
            return;
          case "text":
          case "reasoning": {
            this.partKind.set(part.id, part.type);
            if (part.synthetic || part.ignored)
              return;
            if (!this.live.has(part.messageID) || this.roles.get(part.messageID) !== "assistant")
              return;
            if (sid && this.nextPath.has(sid))
              return;
            const len = typeof part.text === "string" ? part.text.length : 0;
            const before = this.seen.get(part.id) ?? 0;
            if (len > before) {
              this.seen.set(part.id, len);
              this.sink({ t: "delta", ts, kind: part.type, chars: len - before });
            }
            return;
          }
          case "tool": {
            const callID = part.callID ?? part.id;
            const status = part.state?.status;
            if ((status === "pending" || status === "running") && !this.toolStarted.has(callID) && this.live.has(part.messageID)) {
              this.toolStarted.add(callID);
              this.sink({ t: "tool.start", ts, callID, tool: String(part.tool ?? "tool") });
            } else if ((status === "completed" || status === "error") && this.toolStarted.has(callID) && !this.toolEnded.has(callID)) {
              this.toolEnded.add(callID);
              this.sink({ t: "tool.end", ts, callID, ok: status === "completed" });
            }
            return;
          }
          default:
            return;
        }
      }
      case "message.part.delta": {
        if (p.field !== "text" || typeof p.delta !== "string" || !p.delta.length)
          return;
        if (this.roles.get(p.messageID) === "user")
          return;
        if (sid && this.nextPath.has(sid))
          return;
        const kind = this.partKind.get(p.partID) === "reasoning" ? "reasoning" : "text";
        this.seen.set(p.partID, (this.seen.get(p.partID) ?? 0) + p.delta.length);
        this.sink({ t: "delta", ts, kind, chars: p.delta.length });
        return;
      }
      default: {
        const kind = NEXT_DELTA[ev.type];
        if (!kind || typeof p.delta !== "string" || !p.delta.length)
          return;
        if (sid)
          this.nextPath.add(sid);
        this.sink({ t: "delta", ts, kind, chars: p.delta.length });
      }
    }
  }
  focus(sid) {
    const target = this.deps.activeSessionID() ?? this.followed;
    if (target && target !== this.current) {
      this.current = target;
      this.lastModelKey = undefined;
      this.sink({ t: "reset", ts: this.deps.now(), sessionKey: target });
    }
    if (!sid)
      return false;
    return sid === this.current;
  }
  trackBusy(sid, busy) {
    this.busy.set(sid, busy);
    if (busy && !this.deps.activeSessionID())
      this.followed = sid;
    let others = 0;
    for (const [id, b] of this.busy)
      if (b && id !== (this.deps.activeSessionID() ?? this.followed))
        others++;
    if (others !== this.lastSubagents) {
      this.lastSubagents = others;
      this.sink({ t: "subagents", ts: this.deps.now(), busy: others });
    }
  }
}
function errorMessage(e) {
  if (!e || typeof e !== "object")
    return;
  const o = e;
  return String(o.data?.message ?? o.message ?? o.name ?? "error");
}
var NEXT_DELTA;
var init_opencode = __esm(() => {
  NEXT_DELTA = {
    "session.next.text.delta": "text",
    "session.next.reasoning.delta": "reasoning",
    "session.text.delta": "text",
    "session.reasoning.delta": "reasoning"
  };
});

// src/adapters/opencode-sse.ts
function attachOpenCode(baseUrl, sink, now, sessionID) {
  const client = createOpencodeClient({ baseUrl });
  const limits = new Map;
  const baseURLs = new Map;
  const asked = new Set;
  let stopped = false;
  const loadLimits = async () => {
    try {
      const res = await client.config.providers();
      for (const p of res?.data?.providers ?? []) {
        if (typeof p.options?.baseURL === "string")
          baseURLs.set(p.id, p.options.baseURL);
        for (const [id, m] of Object.entries(p.models ?? {})) {
          if (m?.limit?.context)
            limits.set(`${p.id}/${id}`, m.limit.context);
        }
      }
    } catch {}
  };
  const withArch = (s) => {
    sink(s);
    if (s.t !== "model")
      return;
    const key = `${s.model.providerID}/${s.model.modelID}`;
    if (asked.has(key))
      return;
    asked.add(key);
    discoverArch({ providerID: s.model.providerID, modelID: s.model.modelID, baseURL: baseURLs.get(s.model.providerID) }, { fetch, lookup: "all", now }).then((arch) => {
      if (arch)
        sink({ t: "arch", ts: now(), modelID: s.model.modelID, arch });
    }).catch(() => {});
  };
  const adapter = new OpenCodeAdapter(withArch, {
    activeSessionID: () => sessionID,
    contextLimit: (providerID, modelID) => limits.get(`${providerID}/${modelID}`),
    now
  });
  const run = async () => {
    await loadLimits();
    let backoff = 500;
    while (!stopped) {
      try {
        const sub = await client.event.subscribe();
        backoff = 500;
        for await (const ev of sub.stream) {
          if (stopped)
            break;
          if (ev && typeof ev.type === "string")
            adapter.handle(ev);
        }
      } catch {}
      if (stopped)
        break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 5000);
    }
  };
  run();
  return {
    stop() {
      stopped = true;
    }
  };
}
var init_opencode_sse = __esm(() => {
  init_dist();
  init_discover();
  init_opencode();
});

// src/hosts/cli.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";

// src/core/frame.ts
var DEFAULT = -1;

class Frame {
  w;
  h;
  ch;
  fg;
  bg;
  bold;
  constructor(w, h) {
    this.w = Math.max(0, Math.floor(w));
    this.h = Math.max(0, Math.floor(h));
    const n = this.w * this.h;
    this.ch = new Array(n).fill(" ");
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(DEFAULT);
    this.bold = new Uint8Array(n);
  }
  set(x, y, ch, fg, bg = DEFAULT, bold = false) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h)
      return;
    const i = y * this.w + x;
    this.ch[i] = ch;
    this.fg[i] = fg;
    this.bg[i] = bg;
    this.bold[i] = bold ? 1 : 0;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h)
      return;
    const i = y * this.w + x;
    return { ch: this.ch[i], fg: this.fg[i], bg: this.bg[i], bold: this.bold[i] === 1 };
  }
  text(x, y, s, fg, bg = DEFAULT, bold = false) {
    for (const c of s) {
      this.set(x, y, c, fg, bg, bold);
      x++;
    }
    return x;
  }
  cellEquals(other, i) {
    return this.ch[i] === other.ch[i] && this.fg[i] === other.fg[i] && this.bg[i] === other.bg[i] && this.bold[i] === other.bold[i];
  }
  toText() {
    const lines = [];
    for (let y = 0;y < this.h; y++) {
      let s = "";
      for (let x = 0;x < this.w; x++)
        s += this.ch[y * this.w + x] || " ";
      lines.push(s);
    }
    return lines.join(`
`);
  }
  toAnsi(truecolor = true) {
    let out = "\x1B[?25l\x1B[2J\x1B[H";
    let pfg = -2, pbg = -2, pbold = -1;
    for (let y = 0;y < this.h; y++) {
      out += `\x1B[${y + 1};1H`;
      for (let x = 0;x < this.w; x++) {
        const i = y * this.w + x;
        if (this.fg[i] !== pfg) {
          out += sgrFg(this.fg[i], truecolor);
          pfg = this.fg[i];
        }
        if (this.bg[i] !== pbg) {
          out += sgrBg(this.bg[i], truecolor);
          pbg = this.bg[i];
        }
        if (this.bold[i] !== pbold) {
          out += this.bold[i] ? "\x1B[1m" : "\x1B[22m";
          pbold = this.bold[i];
        }
        out += this.ch[i] || " ";
      }
    }
    return out + "\x1B[0m\x1B[?25h";
  }
}
function rgbOf(c) {
  return [c >> 16 & 255, c >> 8 & 255, c & 255];
}
function to256(c) {
  const [r, g, b] = rgbOf(c);
  const q = (v) => v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
function sgrFg(c, truecolor = true) {
  if (c === DEFAULT)
    return "\x1B[39m";
  if (!truecolor)
    return `\x1B[38;5;${to256(c)}m`;
  const [r, g, b] = rgbOf(c);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function sgrBg(c, truecolor = true) {
  if (c === DEFAULT)
    return "\x1B[49m";
  if (!truecolor)
    return `\x1B[48;5;${to256(c)}m`;
  const [r, g, b] = rgbOf(c);
  return `\x1B[48;2;${r};${g};${b}m`;
}
function drawRoundedBox(f, r, fg) {
  const { x, y, w, h } = r;
  if (w < 2 || h < 2)
    return;
  for (let i = 1;i < w - 1; i++) {
    f.set(x + i, y, "─", fg);
    f.set(x + i, y + h - 1, "─", fg);
  }
  for (let j = 1;j < h - 1; j++) {
    f.set(x, y + j, "│", fg);
    f.set(x + w - 1, y + j, "│", fg);
  }
  f.set(x, y, "╭", fg);
  f.set(x + w - 1, y, "╮", fg);
  f.set(x, y + h - 1, "╰", fg);
  f.set(x + w - 1, y + h - 1, "╯", fg);
}
function embedSegment(f, y, x, text, left, right, border, fg, bold = false) {
  f.set(x, y, left, border);
  x++;
  for (const c of text) {
    f.set(x, y, c, fg, DEFAULT, bold);
    x++;
  }
  f.set(x, y, right, border);
  return x + 1;
}
function truncate(s, n) {
  if (n <= 0)
    return "";
  const r = [...s];
  return r.length <= n ? s : r.slice(0, n).join("");
}
function cpLen(s) {
  return [...s].length;
}

// src/core/render/illustrate.ts
function hash32(...xs) {
  let h = 2654435769 | 0;
  for (const x of xs) {
    let k = Math.imul(x | 0, 3432918353);
    k = k << 15 | k >>> 17;
    k = Math.imul(k, 461845907);
    h ^= k;
    h = h << 13 | h >>> 19;
    h = Math.imul(h, 5) + 3864292196 | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0;i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pickK(n, k, rng) {
  k = Math.max(0, Math.min(k, n));
  const out = [];
  const seen = new Set;
  while (out.length < k) {
    const v = Math.floor(rng() * n);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
function pickRecent(nFilled, m, rng) {
  m = Math.max(0, Math.min(m, nFilled));
  const out = [];
  const seen = new Set;
  let guard = 0;
  while (out.length < m && guard++ < m * 20) {
    const idx = nFilled - 1 - Math.floor(nFilled * Math.pow(rng(), 1.4));
    if (idx >= 0 && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

// src/core/demo.ts
var DEMO_NAMES = ["moe-chat", "agentic", "closed", "dense", "error"];

class Script {
  t;
  out = [];
  rng;
  constructor(t0, seed) {
    this.t = t0;
    this.rng = mulberry32(seed);
  }
  at(dt, sig) {
    this.t += dt;
    this.out.push({ ...sig, ts: Math.round(this.t) });
    return this;
  }
  wait(ms) {
    this.t += ms;
    return this;
  }
  stream(kind, tokens, tps) {
    const totalChars = tokens * 4;
    let sent = 0;
    while (sent < totalChars) {
      const dt = 20 + this.rng() * 100;
      const want = tps * 4 * dt / 1000 * (0.5 + this.rng());
      const chars = Math.max(1, Math.min(totalChars - sent, Math.round(want)));
      sent += chars;
      this.at(dt, { t: "delta", kind, chars });
    }
    return this;
  }
}
var usage = (u) => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...u });
var model = (providerID, modelID, contextLimit) => ({ providerID, modelID, contextLimit });
function moeChat(s) {
  s.at(0, { t: "model", model: model("openrouter", "qwen/qwen3-235b-a22b", 131072) }).at(10, { t: "step.end", finish: "stop", usage: usage({ input: 1200, cacheRead: 20500, output: 0 }) }).at(10, { t: "idle" }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(1400).stream("reasoning", 900, 70).stream("text", 300, 70).at(80, { t: "step.end", finish: "stop", usage: usage({ input: 1800, cacheRead: 22000, output: 300, reasoning: 900 }) }).at(150, { t: "idle" });
}
function agentic(s) {
  s.at(0, { t: "model", model: model("openrouter", "openai/gpt-oss-120b", 131072) }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(900).stream("reasoning", 150, 80).stream("text", 40, 80).at(60, { t: "tool.start", callID: "c1", tool: "bash" }).at(40, { t: "step.end", finish: "tool-calls", usage: usage({ input: 9000, output: 40, reasoning: 150 }) }).at(2300, { t: "tool.end", callID: "c1", ok: true }).at(30, { t: "step.start" }).wait(600).stream("reasoning", 80, 80).at(50, { t: "tool.start", callID: "c2", tool: "read" }).at(10, { t: "tool.start", callID: "c3", tool: "grep" }).at(30, { t: "step.end", finish: "tool-calls", usage: usage({ input: 1400, cacheRead: 9000, output: 0, reasoning: 80 }) }).at(800, { t: "tool.end", callID: "c2", ok: true }).at(600, { t: "tool.end", callID: "c3", ok: false }).at(30, { t: "step.start" }).wait(500).stream("text", 400, 60).at(60, { t: "step.end", finish: "stop", usage: usage({ input: 900, cacheRead: 10400, output: 400 }) }).at(150, { t: "idle" });
}
function closed(s) {
  s.at(0, { t: "model", model: model("anthropic", "claude-sonnet-4-5", 200000) }).at(10, { t: "step.end", finish: "stop", usage: usage({ input: 2000, cacheRead: 148000, output: 0 }) }).at(10, { t: "idle" }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(2200).stream("text", 700, 90).at(60, { t: "step.end", finish: "stop", usage: usage({ input: 3000, cacheRead: 150000, cacheWrite: 2000, output: 700 }) }).at(150, { t: "idle" });
}
function dense(s) {
  s.at(0, { t: "model", model: model("together", "meta-llama/llama-3.1-70b-instruct", 131072) }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(1100).stream("text", 250, 25).at(60, { t: "step.end", finish: "stop", usage: usage({ input: 4000, output: 250 }) }).at(150, { t: "idle" });
}
function error(s) {
  s.at(0, { t: "model", model: model("deepseek", "deepseek-chat", 65536) }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(1500).at(0, { t: "retry", attempt: 1, message: "overloaded" }).at(2000, { t: "step.start" }).wait(1000).at(0, { t: "retry", attempt: 2, message: "overloaded" }).at(2000, { t: "error", message: "provider overloaded" });
}
var SCRIPTS = { "moe-chat": moeChat, agentic, closed, dense, error };
function demoSignals(name, t0 = 0) {
  const s = new Script(t0, 12648430);
  if (name === "all") {
    for (const n of DEMO_NAMES) {
      SCRIPTS[n](s);
      s.wait(3000);
    }
  } else {
    SCRIPTS[name](s);
  }
  return s.out;
}
function isDemoName(n) {
  return n === "all" || DEMO_NAMES.includes(n);
}
function demoDuration(name) {
  const sigs = demoSignals(name, 0);
  return (sigs.length ? sigs[sigs.length - 1].ts : 0) + 3500;
}

// src/core/registry.ts
var moe = (family, layers, experts, active, shared, note) => ({ kind: "moe", family, layers, experts, active, shared, ...note ? { note } : {} });
var dense2 = (family, layers, note) => ({ kind: "dense", family, layers, ...note ? { note } : {} });
var unknown = (family, note) => ({ kind: "unknown", family, ...note ? { note } : {} });
var RULES = [
  { re: /deepseek.*(v3|r1|chat|reasoner)/, arch: moe("deepseek-v3", 61, 256, 8, 1, "first 3 layers dense") },
  { re: /kimi-k2/, arch: moe("kimi-k2", 61, 384, 8, 1) },
  { re: /qwen3-coder.*480b/, arch: moe("qwen3-coder-480b", 62, 160, 8, 0) },
  { re: /qwen3.*235b/, arch: moe("qwen3-235b", 94, 128, 8, 0) },
  { re: /qwen3.*30b-a3b/, arch: moe("qwen3-30b-a3b", 48, 128, 8, 0) },
  { re: /gpt-oss-120b/, arch: moe("gpt-oss-120b", 36, 128, 4, 0) },
  { re: /gpt-oss-20b/, arch: moe("gpt-oss-20b", 24, 32, 4, 0) },
  { re: /mixtral.*8x22b/, arch: moe("mixtral-8x22b", 56, 8, 2, 0) },
  { re: /mixtral.*8x7b/, arch: moe("mixtral-8x7b", 32, 8, 2, 0) },
  { re: /llama-4-maverick/, arch: moe("llama-4-maverick", 48, 128, 1, 1, "alternating dense/MoE layers") },
  { re: /llama-4-scout/, arch: moe("llama-4-scout", 48, 16, 1, 1) },
  { re: /glm-4\.5(?!-air)/, arch: moe("glm-4.5", 92, 160, 8, 1, "verify") },
  { re: /llama-?3.*405b/, arch: dense2("llama-3-405b", 126) },
  { re: /llama-?3.*70b/, arch: dense2("llama-3-70b", 80) },
  { re: /llama-?3.*8b/, arch: dense2("llama-3-8b", 32) },
  { re: /qwen2\.5-coder.*32b/, arch: dense2("qwen2.5-coder-32b", 64) },
  { re: /claude|gpt-[45]|^o[134]|gemini|grok/, arch: unknown("closed", "closed weights") }
];
var UNKNOWN = unknown("unknown");
function normalizeModelID(id) {
  const s = id.toLowerCase();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
function archFor(model, overrides, discovered) {
  if (!model)
    return UNKNOWN;
  const id = normalizeModelID(model.modelID);
  if (overrides) {
    for (const [pat, arch] of Object.entries(overrides)) {
      try {
        if (new RegExp(pat, "i").test(id) || new RegExp(pat, "i").test(model.modelID))
          return { ...arch, source: "override" };
      } catch {}
    }
  }
  const found = discovered?.get(model.modelID);
  if (found && found.kind !== "unknown")
    return found;
  for (const r of RULES)
    if (r.re.test(id))
      return { ...r.arch, source: "table" };
  return UNKNOWN;
}
var NOISE_SUFFIX = /-(?:bf16|fp16|f16|fp32|fp8|f8|int8|int4|w\d+a\d+|\d+(?:\.\d+)?bpw|\d+-?bits?|q\d+(?:_k)?(?:_[a-z0-9]+)*|iq\d+[a-z0-9_]*|awq|gptq|exl2|gguf|mlx|serve|mixed(?:-\d+)*|dwq|ud|mtp|instruct|chat|it|hf|uncensored|abliterated|heretic|preserved|native)$/i;
function shortModelName(modelID) {
  let s = normalizeModelID(modelID);
  for (let i = 0;i < 12; i++) {
    const next = s.replace(NOISE_SUFFIX, "");
    if (next === s || next.length < 4)
      break;
    s = next;
  }
  return s;
}
function archSummary(a) {
  switch (a.kind) {
    case "moe":
      return `MoE ${a.experts}e/${a.active}a · ${a.layers}L`;
    case "dense":
      return `dense · ${a.layers}L`;
    default:
      return "arch unknown";
  }
}

// src/core/sim/rate.ts
var RATE_CAP = 256;
var RATE_WINDOW_TICKS = 60;
var MIN_SPAN_TICKS = 15;
function createRate() {
  return { ticks: new Array(RATE_CAP).fill(0), toks: new Array(RATE_CAP).fill(0), head: 0, size: 0 };
}
function ratePush(r, tick, tokens) {
  r.ticks[r.head] = tick;
  r.toks[r.head] = tokens;
  r.head = (r.head + 1) % RATE_CAP;
  if (r.size < RATE_CAP)
    r.size++;
}
function rateTps(r, tick, hz) {
  let sum = 0;
  let oldest = Infinity;
  for (let k = 0;k < r.size; k++) {
    const i = (r.head - 1 - k + RATE_CAP) % RATE_CAP;
    const t = r.ticks[i];
    if (tick - t >= RATE_WINDOW_TICKS)
      break;
    sum += r.toks[i];
    if (t < oldest)
      oldest = t;
  }
  if (oldest === Infinity)
    return -1;
  const span = Math.max(MIN_SPAN_TICKS, tick - oldest + 1);
  return sum * hz / span;
}

// src/core/sim/sim.ts
var TICK_HZ = 30;
var TICK_MS = 1000 / TICK_HZ;
var DEFAULT_CONTEXT = 200000;
var IDLE_TIMEOUT_TICKS = 90;
var ERROR_TICKS = 36;
var PULSE_MIN_GAP = 3;
var MAX_PULSES = 6;
var FLASH_TTL = 45;
var EST_PREFILL_TICKS = 18;
var DEFAULT_EST_TPS = 40;
var CALIB_MIN_EST = 20;
function createSim(sessionKey = "default", archOverrides) {
  return {
    tick: 0,
    sessionKey,
    phase: "idle",
    phaseTick: 0,
    stream: "text",
    arch: UNKNOWN,
    archOverrides,
    discovered: new Map,
    contextLimit: DEFAULT_CONTEXT,
    contextApprox: true,
    stepOpen: false,
    stepStartTick: 0,
    stepRawEst: 0,
    stepTokens: 0,
    stepGenStart: 0,
    tools: new Map,
    toolsCalled: 0,
    promptGenBase: 0,
    generated: [],
    genTotal: 0,
    turnReasoning: 0,
    turnText: 0,
    bank: 0,
    draining: false,
    streaming: true,
    estimating: false,
    estTps: new Map,
    stepStarts: [],
    tps: 0,
    tpsApprox: false,
    lastDeltaTick: -1e6,
    calib: new Map,
    pulses: [],
    flashes: [],
    nextPulseIndex: 0,
    lastEmitTick: -1e6,
    lastSignalTick: 0,
    subagentsBusy: 0,
    rate: createRate()
  };
}
function promptTokens(u) {
  return u.input + u.cacheRead + u.cacheWrite;
}
function setPhase(s, p) {
  if (s.phase === p)
    return;
  s.phase = p;
  s.phaseTick = s.tick;
}
function calibKey(s) {
  return s.model?.modelID ?? "?";
}
function addGenerated(s, stream, tokens) {
  if (tokens <= 0)
    return;
  const last = s.generated[s.generated.length - 1];
  if (last && last.stream === stream)
    last.tokens += tokens;
  else
    s.generated.push({ stream, tokens });
  s.genTotal += tokens;
  if (stream === "reasoning")
    s.turnReasoning += tokens;
  else
    s.turnText += tokens;
}
function spawnPulse(s, tokens, est = false) {
  const sweep = Math.max(9, Math.min(20, Math.round(270 / Math.max(s.tps, 1))));
  s.pulses.push({ index: s.nextPulseIndex++, bornTick: s.tick, tokens, stream: s.stream, sweepTicks: sweep, ...est ? { est: true } : {} });
  s.bank -= tokens;
  if (s.bank < 0.000000001)
    s.bank = 0;
  s.lastEmitTick = s.tick;
  if (!est)
    addGenerated(s, s.stream, tokens);
}
function stopEstimating(s) {
  if (!s.estimating)
    return;
  s.estimating = false;
  s.bank = 0;
}
function flushBank(s) {
  if (s.bank >= 0.5)
    spawnPulse(s, s.bank);
  else
    s.bank = 0;
}
function startTurn(s) {
  if (s.promptTokens !== undefined)
    s.promptTokens += Math.max(0, s.genTotal - s.promptGenBase);
  s.generated = [];
  s.genTotal = 0;
  s.promptGenBase = 0;
  s.turnReasoning = 0;
  s.turnText = 0;
  s.pulses = [];
  s.bank = 0;
  s.draining = false;
  s.tools.clear();
  s.toolsCalled = 0;
  s.turnTick = s.tick;
  s.ttftTicks = undefined;
  s.tpsApprox = false;
}
function beginPrefill(s) {
  s.prefillTick = s.tick;
  s.ttftTicks = undefined;
  setPhase(s, "prefill");
}
function applySignal(s, sig) {
  s.lastSignalTick = s.tick;
  switch (sig.t) {
    case "model": {
      s.model = sig.model;
      s.arch = archFor(sig.model, s.archOverrides, s.discovered);
      if (sig.model.contextLimit && sig.model.contextLimit > 0) {
        s.contextLimit = sig.model.contextLimit;
        s.contextApprox = false;
      }
      return;
    }
    case "arch": {
      s.discovered.set(sig.modelID, sig.arch);
      if (s.model?.modelID === sig.modelID)
        s.arch = archFor(s.model, s.archOverrides, s.discovered);
      return;
    }
    case "mode": {
      s.streaming = sig.streaming;
      if (s.streaming)
        stopEstimating(s);
      return;
    }
    case "turn.start": {
      stopEstimating(s);
      startTurn(s);
      beginPrefill(s);
      return;
    }
    case "step.start": {
      if (!s.streaming) {
        if (s.phase === "idle" || s.phase === "error")
          startTurn(s);
        while (s.stepStarts.length && (s.tick - s.stepStarts[0] > 10 * 60 * TICK_HZ || s.stepStarts.length >= 16))
          s.stepStarts.shift();
        s.stepStarts.push(s.tick);
        s.stepOpen = true;
        s.stepStartTick = s.tick;
        if (s.phase !== "prefill")
          beginPrefill(s);
        s.retryAttempt = undefined;
        return;
      }
      if (s.stepOpen)
        return;
      if (s.phase === "idle" || s.phase === "error")
        startTurn(s);
      s.stepOpen = true;
      s.stepStartTick = s.tick;
      s.stepRawEst = 0;
      s.stepTokens = 0;
      s.stepGenStart = s.genTotal;
      if (s.phase !== "prefill")
        beginPrefill(s);
      s.retryAttempt = undefined;
      return;
    }
    case "delta": {
      const raw = sig.tokens ?? sig.chars / 4;
      if (!(raw > 0))
        return;
      const k = s.calib.get(calibKey(s)) ?? 1;
      const est = raw * k;
      s.stepRawEst += raw;
      s.stepTokens += est;
      s.bank += est;
      s.stream = sig.kind;
      s.lastDeltaTick = s.tick;
      s.tpsApprox = false;
      ratePush(s.rate, s.tick, est);
      const r = rateTps(s.rate, s.tick, TICK_HZ);
      if (r >= 0)
        s.tps = r;
      if (s.phase === "tool")
        return;
      if (s.phase === "prefill" && s.prefillTick !== undefined)
        s.ttftTicks = s.tick - s.prefillTick;
      if (s.phase === "idle" || s.phase === "error")
        startTurn(s);
      s.retryAttempt = undefined;
      setPhase(s, "decode");
      return;
    }
    case "tool.start": {
      if (s.tools.has(sig.callID))
        return;
      stopEstimating(s);
      s.tools.set(sig.callID, { tool: sig.tool, startTick: s.tick });
      s.toolsCalled++;
      if (s.phase === "decode")
        flushBank(s);
      setPhase(s, "tool");
      return;
    }
    case "tool.end": {
      if (!s.tools.delete(sig.callID))
        return;
      if (!sig.ok)
        s.flashes.push({ kind: "toolFail", bornTick: s.tick });
      if (s.tools.size === 0 && s.phase === "tool")
        beginPrefill(s);
      return;
    }
    case "step.end": {
      if (sig.usage && !s.streaming) {
        const u = sig.usage;
        const started = s.stepStarts.shift();
        s.usage = u;
        s.promptTokens = promptTokens(u);
        s.promptGenBase = s.genTotal;
        addGenerated(s, "reasoning", u.reasoning);
        addGenerated(s, "text", u.output);
        const observed = u.output + u.reasoning;
        const secs = started === undefined ? 0 : (s.tick - started) / TICK_HZ;
        if (observed > 0 && secs > 0.3) {
          const rate = observed / secs;
          const key = calibKey(s);
          const prev = s.estTps.get(key);
          s.estTps.set(key, prev === undefined ? rate : prev + (rate - prev) * 0.5);
          s.tps = rate;
          s.tpsApprox = true;
        }
        if (u.reasoning > u.output)
          s.stream = "reasoning";
        s.lastFinish = sig.finish;
        return;
      }
      if (sig.usage) {
        const u = sig.usage;
        s.usage = u;
        s.promptTokens = promptTokens(u);
        s.promptGenBase = s.stepGenStart;
        const observed = u.output + u.reasoning;
        if (s.stepRawEst > CALIB_MIN_EST && observed > 0) {
          const key = calibKey(s);
          const k = s.calib.get(key) ?? 1;
          const next = k + (observed / s.stepRawEst - k) * 0.3;
          s.calib.set(key, Math.max(0.5, Math.min(2, next)));
        }
        if (s.stepTokens === 0 && observed > 0) {
          const secs = Math.max(1, s.tick - s.stepStartTick) / TICK_HZ;
          s.tps = observed / secs;
          s.tpsApprox = true;
          s.bank += observed;
          s.stream = u.output >= u.reasoning ? "text" : "reasoning";
          s.draining = true;
          if (s.phase === "prefill" && s.prefillTick !== undefined)
            s.ttftTicks = undefined;
          setPhase(s, "decode");
        }
      }
      if (!s.draining && s.phase === "decode")
        flushBank(s);
      s.stepOpen = false;
      s.lastFinish = sig.finish;
      return;
    }
    case "retry": {
      s.retryAttempt = sig.attempt;
      setPhase(s, "retry");
      return;
    }
    case "error": {
      stopEstimating(s);
      s.stepStarts = [];
      s.flashes.push({ kind: "error", bornTick: s.tick });
      s.tools.clear();
      s.stepOpen = false;
      s.bank = 0;
      s.draining = false;
      setPhase(s, "error");
      return;
    }
    case "idle": {
      stopEstimating(s);
      if (!s.draining)
        flushBank(s);
      s.tools.clear();
      s.stepOpen = false;
      if (s.phase !== "error")
        setPhase(s, "idle");
      return;
    }
    case "subagents": {
      s.subagentsBusy = Math.max(0, sig.busy);
      return;
    }
    case "reset": {
      const keep = { calib: s.calib, overrides: s.archOverrides, discovered: s.discovered, tick: s.tick, streaming: s.streaming, estTps: s.estTps };
      Object.assign(s, createSim(sig.sessionKey, keep.overrides));
      s.calib = keep.calib;
      s.discovered = keep.discovered;
      s.streaming = keep.streaming;
      s.estTps = keep.estTps;
      s.tick = keep.tick;
      s.phaseTick = keep.tick;
      s.lastSignalTick = keep.tick;
      return;
    }
  }
}
function step(s) {
  s.tick++;
  const t = s.tick;
  if (!s.streaming && !s.estimating && s.stepOpen && s.phase === "prefill" && s.tools.size === 0 && t - (s.prefillTick ?? t) >= EST_PREFILL_TICKS) {
    s.estimating = true;
    s.tps = s.estTps.get(calibKey(s)) ?? DEFAULT_EST_TPS;
    s.tpsApprox = true;
    setPhase(s, "decode");
  }
  if (s.estimating)
    s.bank += s.tps / TICK_HZ;
  const emitting = s.phase === "decode" || s.draining;
  if (emitting && s.bank >= 1 && t - s.lastEmitTick >= PULSE_MIN_GAP && s.pulses.length < MAX_PULSES) {
    const per = Math.max(1, Math.ceil(s.tps / 10));
    const take = Math.min(s.bank, s.bank > per * 4 ? Math.ceil(s.bank / 4) : per);
    spawnPulse(s, take, s.estimating);
  }
  if (s.draining && s.bank < 1) {
    if (s.bank > 0)
      spawnPulse(s, s.bank);
    s.draining = false;
  }
  if (s.pulses.length)
    s.pulses = s.pulses.filter((p) => t - p.bornTick <= p.sweepTicks * 1.5);
  if (s.flashes.length)
    s.flashes = s.flashes.filter((f) => t - f.bornTick <= FLASH_TTL);
  if (!s.tpsApprox && t - s.lastDeltaTick > 30 && s.tps > 0) {
    s.tps *= 0.9;
    if (s.tps < 1)
      s.tps = 0;
  }
  if (s.phase === "error" && t - s.phaseTick >= ERROR_TICKS)
    setPhase(s, "idle");
  if (s.phase !== "idle" && s.phase !== "error" && s.phase !== "retry" && !s.stepOpen && s.tools.size === 0 && !s.draining && s.bank < 1 && t - s.lastSignalTick >= IDLE_TIMEOUT_TICKS) {
    setPhase(s, "idle");
  }
}
function inflightTokens(s) {
  let n = 0;
  for (const p of s.pulses)
    if (!p.est && s.tick - p.bornTick < p.sweepTicks)
      n += p.tokens;
  return n;
}
function contextView(s) {
  const known = s.promptTokens !== undefined && s.usage !== undefined;
  const cached = known ? s.usage.cacheRead : 0;
  const fresh = known ? Math.max(0, s.promptTokens - s.usage.cacheRead) : 0;
  let skip = s.promptGenBase;
  let remaining = Math.max(0, s.genTotal - s.promptGenBase - inflightTokens(s));
  const gen = [];
  for (const r of s.generated) {
    let n = r.tokens;
    if (skip > 0) {
      const d = Math.min(skip, n);
      skip -= d;
      n -= d;
    }
    if (n <= 0 || remaining <= 0)
      continue;
    const take = Math.min(n, remaining);
    remaining -= take;
    gen.push({ stream: r.stream, tokens: take });
  }
  const genSum = gen.reduce((a, r) => a + r.tokens, 0);
  return {
    limit: s.contextLimit,
    approx: s.contextApprox,
    cached,
    fresh,
    generated: gen,
    used: cached + fresh + genSum,
    known
  };
}

// src/core/sim/driver.ts
class Driver {
  sim;
  queue = [];
  t0;
  maxCatchUp;
  constructor(sim, opts = {}) {
    this.sim = sim;
    this.maxCatchUp = opts.maxCatchUp ?? 10;
    this.t0 = opts.t0;
  }
  get origin() {
    return this.t0;
  }
  push(sig) {
    if (this.t0 === undefined)
      this.t0 = sig.ts - this.sim.tick * TICK_MS;
    this.queue.push(sig);
  }
  tickOf(ts) {
    return Math.floor((ts - (this.t0 ?? ts)) / TICK_MS + 0.000001);
  }
  advanceTo(nowMs) {
    if (this.t0 === undefined)
      this.t0 = nowMs - this.sim.tick * TICK_MS;
    let target = this.tickOf(nowMs);
    let steps = target - this.sim.tick;
    if (steps > this.maxCatchUp) {
      this.t0 += (steps - this.maxCatchUp) * TICK_MS;
      target = this.sim.tick + this.maxCatchUp;
      steps = this.maxCatchUp;
    }
    this.applyDue();
    let taken = 0;
    while (this.sim.tick < target) {
      step(this.sim);
      taken++;
      this.applyDue();
    }
    return taken;
  }
  applyDue() {
    if (this.queue.length === 0)
      return;
    let i = 0;
    while (i < this.queue.length && this.tickOf(this.queue[i].ts) <= this.sim.tick) {
      applySignal(this.sim, this.queue[i]);
      i++;
    }
    if (i > 0)
      this.queue.splice(0, i);
  }
  get pending() {
    return this.queue.length;
  }
}

// src/core/palette.ts
var DEFAULT_PALETTE = {
  border: 4936291,
  label: 9147297,
  text: 14146272,
  gridBlue: 3893914,
  gridBlueLt: 8366031,
  gridEmpty: 3817291,
  attendDot: 15895592,
  route: 6001607,
  hex: [15233130, 13123663, 11129230, 5219246],
  hidden: 4885703,
  meshPink: 14711456,
  meshBlue: 9287896,
  output: 12045795,
  reasoning: 10980346,
  textOut: 16102485,
  tool: 5219246,
  warn: 16102485,
  error: 15026253,
  bg: 1447965
};
var LEVELS = 32;
function shade(color, bg, i) {
  if (!(i > 0))
    return bg === DEFAULT ? DEFAULT : bg;
  if (i >= 1)
    return color;
  const t = Math.round(Math.pow(i, 0.8) * LEVELS) / LEVELS;
  const b = bg === DEFAULT ? DEFAULT_PALETTE.bg : bg;
  const r = (color >> 16 & 255) * t + (b >> 16 & 255) * (1 - t);
  const g = (color >> 8 & 255) * t + (b >> 8 & 255) * (1 - t);
  const bl = (color & 255) * t + (b & 255) * (1 - t);
  return Math.round(r) << 16 | Math.round(g) << 8 | Math.round(bl);
}

// src/core/render/braille.ts
var BITS = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128]
];
var DOT_THRESHOLD = 0.04;
var DOMINANCE = 0.5;

class BrailleCanvas {
  cw;
  ch;
  mask;
  inten;
  color;
  constructor(cw, ch) {
    this.cw = Math.max(0, cw);
    this.ch = Math.max(0, ch);
    const n = this.cw * this.ch;
    this.mask = new Uint8Array(n);
    this.inten = new Float32Array(n);
    this.color = new Int32Array(n);
  }
  get pw() {
    return this.cw * 2;
  }
  get ph() {
    return this.ch * 4;
  }
  plot(sx, sy, color, i) {
    if (sx < 0 || sy < 0 || sx >= this.cw * 2 || sy >= this.ch * 4 || i < DOT_THRESHOLD)
      return;
    const c = (sy >> 2) * this.cw + (sx >> 1);
    const bit = BITS[sy & 3][sx & 1];
    const cur = this.inten[c];
    if (i * DOMINANCE > cur) {
      this.mask[c] = bit;
      this.inten[c] = i;
      this.color[c] = color;
    } else if (i >= cur * DOMINANCE) {
      this.mask[c] |= bit;
      if (i > cur) {
        this.inten[c] = i;
        this.color[c] = color;
      }
    }
  }
  line(x0, y0, x1, y1, color, i, opts = {}) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const upTo = opts.upTo === undefined ? 1 : Math.max(0, Math.min(1, opts.upTo));
    const last = Math.floor(n * upTo);
    const st = Math.max(1, opts.stipple ?? 1);
    if (n === 0) {
      if (upTo > 0)
        this.plot(x0, y0, color, i);
      return;
    }
    for (let k = 0;k <= last; k += st) {
      this.plot(Math.round(x0 + (x1 - x0) * k / n), Math.round(y0 + (y1 - y0) * k / n), color, i);
    }
  }
  blitTo(f, ox, oy, bg) {
    for (let y = 0;y < this.ch; y++) {
      for (let x = 0;x < this.cw; x++) {
        const c = y * this.cw + x;
        if (this.mask[c] === 0)
          continue;
        f.set(ox + x, oy + y, String.fromCharCode(10240 + this.mask[c]), shade(this.color[c], bg, this.inten[c]), bg);
      }
    }
  }
}

// src/core/render/layout.ts
var FULL_MIN = { w: 90, h: 18 };
var COMPACT_MIN = { w: 34, h: 10 };
var STRIP_MIN_W = 12;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function layout(w, h, _arch) {
  w = Math.floor(w);
  h = Math.floor(h);
  if (w >= FULL_MIN.w && h >= FULL_MIN.h)
    return full(w, h);
  if (w >= COMPACT_MIN.w && h >= COMPACT_MIN.h)
    return compact(w, h);
  if (w >= STRIP_MIN_W && h >= 1)
    return { mode: "strip", line: { x: 0, y: 0, w, h: 1 } };
  return { mode: "tiny" };
}
function full(w, h) {
  const ix = 1, iy = 1, iw = w - 2, ih = h - 2;
  const gw = clamp(Math.round(iw * 0.14), 8, 22);
  const gh = clamp(Math.round(ih * 0.62), 6, ih);
  const grid = { x: ix + 1, y: iy + Math.floor((ih - gh) / 2), w: gw, h: gh };
  const fanAx = grid.x + grid.w + 1;
  const fanA = { x: fanAx, y: iy, w: Math.round(iw * 0.47) - fanAx, h: ih };
  const experts = { x: fanA.x + fanA.w + 1, y: iy, w: 1, h: ih };
  const hidden = { x: experts.x + 2, y: iy, w: 1, h: ih };
  const outX = ix + iw - 2;
  const outN = Math.min(clamp(Math.round(ih * 0.4), 4, 12), Math.floor((ih + 1) / 2));
  const fanB = { x: hidden.x + 2, y: iy, w: outX - 1 - (hidden.x + 2), h: ih };
  const out = { x: outX, y: iy + Math.floor((ih - (2 * outN - 1)) / 2), w: 1, h: 2 * outN - 1 };
  return { mode: "full", box: { x: 0, y: 0, w, h }, grid, fanA, experts, hidden, fanB, out, outN, cometY: h - 2 };
}
function compact(w, h) {
  const ix = 1, iy = 1, iw = w - 2, ih = h - 2;
  const gw = clamp(Math.round(iw * 0.25), 6, 16);
  const gh = clamp(Math.round(ih * 0.7), 3, ih);
  const grid = { x: ix + 1, y: iy + Math.floor((ih - gh) / 2), w: gw, h: gh };
  const fanAx = grid.x + grid.w + 1;
  const fanA = { x: fanAx, y: iy, w: w - 6 - fanAx, h: ih };
  const experts = { x: w - 5, y: iy, w: 1, h: ih };
  const outN = Math.min(clamp(Math.round(ih * 0.5), 3, 8), Math.floor((ih + 1) / 2));
  const out = { x: w - 3, y: iy + Math.floor((ih - (2 * outN - 1)) / 2), w: 1, h: 2 * outN - 1 };
  return { mode: "compact", box: { x: 0, y: 0, w, h }, grid, fanA, experts, out, outN, cometY: h - 2 };
}
function outY(L, i) {
  return L.out.y + 2 * i;
}
function gridCell(grid, i) {
  const h = Math.max(1, grid.h);
  const col = Math.floor(i / h), row = i % h;
  return { col, row, x: grid.x + col, y: grid.y + row };
}

// src/core/render/strip.ts
function renderStrip(f, s, pal, opts) {
  const bg = opts.bg;
  const G = glyphsFor(opts.asciiSafe);
  const t = s.tick;
  const parts = [];
  const gm = gridModel(contextView(s), 9);
  const bar = [{ text: "◖", color: pal.border, i: 1 }];
  for (let i = 0;i < 9; i++) {
    const k = gm.kind[i];
    let glyph = k === CELL_CACHED ? "▓" : k === CELL_FRESH ? "▒" : k === CELL_REASONING || k === CELL_TEXT ? "█" : "·";
    if (k && gm.frac[i] > 0 && gm.frac[i] < 1)
      glyph = " ░▒▓█"[Math.max(1, Math.ceil(gm.frac[i] * 4))];
    const color = k === CELL_CACHED ? pal.gridBlue : k === CELL_FRESH ? pal.gridBlueLt : k === CELL_REASONING ? pal.reasoning : k === CELL_TEXT ? pal.textOut : pal.gridEmpty;
    bar.push({ text: glyph, color, i: k ? 0.8 : 0.9 });
  }
  parts.push(bar);
  const slots = expertSlots(s.arch, { x: 0, y: 0, w: 1, h: 8 });
  const lit = new Float32Array(slots.ys.length);
  const seed = hashStr(s.sessionKey);
  let sample = 0;
  let sampleColor = pal.output;
  for (const p of s.pulses) {
    const u = pulseU(s, p);
    if (u >= 1)
      continue;
    const eI = stageI(u, 0.3, 0.42, p.sweepTicks);
    if (eI > 0)
      for (const sl of pulseSlots(s.arch, slots, seed, p, 1))
        lit[sl] = Math.max(lit[sl], eI);
    const sI = stageI(u, 0.85, 0.92, p.sweepTicks);
    if (sI > sample) {
      sample = sI;
      sampleColor = p.stream === "reasoning" ? pal.reasoning : pal.textOut;
    }
  }
  const ex = [{ text: " ", color: 0, i: 0 }];
  for (let i = 0;i < slots.ys.length; i++) {
    const shimmer = s.arch.kind === "unknown" ? 0.15 + 0.08 * Math.sin(t / 10 + i) : 0.25;
    const I = Math.max(shimmer, lit[i]);
    ex.push({ text: lit[i] > 0.3 ? G.hex : G.hexOff, color: pal.hex[i % pal.hex.length], i: I });
  }
  ex.push({ text: "~", color: pal.label, i: 0.5 });
  parts.push(ex);
  parts.push([{ text: " ", color: 0, i: 0 }, { text: sample > 0.3 ? G.sample : G.node, color: sample > 0.3 ? sampleColor : pal.output, i: Math.max(0.3, sample) }]);
  if (s.tps >= 1)
    parts.push([{ text: ` ${s.tpsApprox ? "≈" : ""}${Math.round(s.tps)}t/s`, color: pal.text, i: 0.85 }]);
  if (s.tools.size > 0) {
    const first = [...s.tools.values()][0];
    parts.push([{ text: ` ⚙${first.tool}`, color: pal.tool, i: 1 }]);
  } else if (s.phase === "prefill") {
    parts.push([{ text: " prefill", color: pal.gridBlueLt, i: 0.8 }]);
  } else if (s.phase === "error") {
    parts.push([{ text: " ✕", color: pal.error, i: 1 }]);
  }
  let x = 0;
  for (const group of parts) {
    const len = group.reduce((n, p) => n + [...p.text].length, 0);
    if (x + len > f.w)
      break;
    for (const p of group)
      x = f.text(x, 0, p.text, p.i > 0 ? shade(p.color, bg, p.i) : 0, bg);
  }
}

// src/core/render/viz.ts
var DEFAULT_VIZ_OPTS = { labels: true, asciiSafe: false, bg: DEFAULT };
var SPINNER = "⠁⠂⠄⡀⢀⠠⠐⠈";
var TAU = 5;
var LAND_TAU = 8;
function glyphsFor(asciiSafe) {
  return {
    hex: asciiSafe ? "◆" : "⬢",
    hexOff: asciiSafe ? "◇" : "⬡",
    shared: asciiSafe ? "◆" : "◈",
    sample: asciiSafe ? "@" : "◉",
    node: "●",
    nodeOff: "○",
    dense: "┃"
  };
}
function stageI(u, a, b, sweep) {
  if (u < a)
    return 0;
  if (u <= b)
    return 1;
  return Math.exp(-((u - b) * sweep) / TAU);
}
function sampleIndex(seed, p, outN) {
  return Math.floor(mulberry32(hash32(seed, p.index, 23))() * outN);
}
function pulseU(s, p) {
  return (s.tick - p.bornTick) / p.sweepTicks;
}
function expertSlots(arch, col) {
  const rows = col.h;
  let count;
  let shared = 0;
  let perSlot = 1;
  let experts = rows;
  if (arch.kind === "moe") {
    shared = Math.min(arch.shared, Math.max(0, rows - 1));
    experts = arch.experts;
    const avail = Math.max(1, rows - shared);
    perSlot = arch.experts <= avail ? 1 : Math.ceil(arch.experts / avail);
    count = shared + Math.ceil(arch.experts / perSlot);
  } else {
    count = rows;
  }
  count = Math.max(1, Math.min(count, rows));
  const spacing = Math.max(1, Math.floor(rows / count));
  const offset = Math.max(0, Math.floor((rows - ((count - 1) * spacing + 1)) / 2));
  const ys = [];
  for (let i = 0;i < count; i++)
    ys.push(col.y + offset + i * spacing);
  return { ys, shared, perSlot, experts };
}
function pulseSlots(arch, slots, seed, p, layer) {
  const rng = mulberry32(hash32(seed, p.index, layer, 7));
  if (arch.kind === "moe") {
    const set = new Set;
    for (let i = 0;i < slots.shared; i++)
      set.add(i);
    for (const e of pickK(arch.experts, arch.active, rng))
      set.add(slots.shared + Math.floor(e / slots.perSlot));
    return [...set].filter((i) => i < slots.ys.length);
  }
  if (arch.kind === "dense")
    return slots.ys.map((_, i) => i);
  return pickK(slots.ys.length, Math.min(3, slots.ys.length), rng);
}
var CELL_EMPTY = 0;
var CELL_CACHED = 1;
var CELL_FRESH = 2;
var CELL_REASONING = 3;
var CELL_TEXT = 4;
function gridModel(cv, cells) {
  const kind = new Uint8Array(cells);
  const frac = new Float32Array(cells);
  const tpc = Math.max(1, Math.ceil(cv.limit / Math.max(1, cells)));
  const segs = [];
  let acc = 0;
  if (cv.cached > 0)
    segs.push({ end: acc += cv.cached, kind: CELL_CACHED });
  if (cv.fresh > 0)
    segs.push({ end: acc += cv.fresh, kind: CELL_FRESH });
  for (const r of cv.generated)
    segs.push({ end: acc += r.tokens, kind: r.stream === "reasoning" ? CELL_REASONING : CELL_TEXT });
  const used = Math.min(acc, tpc * cells);
  const segAt = (tok) => {
    for (const s of segs)
      if (tok < s.end)
        return s.kind;
    return segs.length ? segs[segs.length - 1].kind : CELL_EMPTY;
  };
  let nFilled = 0;
  for (let i = 0;i < cells; i++) {
    const start = i * tpc;
    if (used <= start)
      continue;
    nFilled++;
    if (used < start + tpc) {
      kind[i] = segAt(used - 0.000001);
      frac[i] = (used - start) / tpc;
    } else {
      kind[i] = segAt(start + tpc / 2);
      frac[i] = 1;
    }
  }
  return { kind, frac, nFilled, tokensPerCell: tpc };
}
function fmtK(n) {
  n = Math.max(0, n);
  if (n < 1000)
    return `${Math.round(n)}`;
  if (n < 1e4)
    return `${(n / 1000).toFixed(1)}k`;
  if (n < 1e6)
    return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
var secs = (ticks) => `${(ticks / TICK_HZ).toFixed(1)}s`;
function renderViz(w, h, sim, pal, opts = DEFAULT_VIZ_OPTS) {
  const f = new Frame(w, h);
  const L = layout(w, h, sim.arch);
  if (L.mode === "tiny") {
    f.set(Math.floor(f.w / 2), Math.floor(f.h / 2), "·", shade(pal.label, opts.bg, 0.7));
    return f;
  }
  if (L.mode === "strip") {
    renderStrip(f, sim, pal, opts);
    return f;
  }
  drawScene(f, L, sim, pal, opts);
  return f;
}
function drawScene(f, L, s, pal, opts) {
  const bg = opts.bg;
  const t = s.tick;
  const G = glyphsFor(opts.asciiSafe);
  const seed = hashStr(s.sessionKey);
  const arch = s.arch;
  const full = L.mode === "full";
  const sh = (c, i) => shade(c, bg, i);
  const idle = s.phase === "idle";
  const base = idle ? 0.06 + 0.06 * (1 + Math.sin(2 * Math.PI * t / 120)) / 2 : 0.1;
  const g = L.grid;
  const cells = g.w * g.h;
  const cv = contextView(s);
  const gm = gridModel(cv, cells);
  const gridI = new Float32Array(cells);
  const gridGlyph = new Array(cells).fill("·");
  const gridColor = new Int32Array(cells).fill(pal.gridEmpty);
  for (let i = 0;i < cells; i++) {
    const k = gm.kind[i];
    const partial = gm.frac[i] > 0 && gm.frac[i] < 1;
    switch (k) {
      case CELL_CACHED:
        gridGlyph[i] = "▓";
        gridColor[i] = pal.gridBlue;
        gridI[i] = 0.75;
        break;
      case CELL_FRESH:
        gridGlyph[i] = "▒";
        gridColor[i] = pal.gridBlueLt;
        gridI[i] = 0.7;
        break;
      case CELL_REASONING:
        gridGlyph[i] = "█";
        gridColor[i] = pal.reasoning;
        gridI[i] = 0.85;
        break;
      case CELL_TEXT:
        gridGlyph[i] = "█";
        gridColor[i] = pal.textOut;
        gridI[i] = 0.85;
        break;
      default:
        gridI[i] = 0.9;
    }
    if (k !== CELL_EMPTY && partial)
      gridGlyph[i] = " ░▒▓█"[Math.max(1, Math.ceil(gm.frac[i] * 4))];
  }
  if (s.phase === "prefill") {
    const since = t - (s.prefillTick ?? t);
    const bx = since % 27 / 27 * (g.w + 6) - 3;
    const anyFresh = gm.kind.some((k) => k === CELL_FRESH);
    for (let i = 0;i < cells; i++) {
      const d = Math.abs(gridCell(g, i).col - bx);
      if (d >= 2.5)
        continue;
      const boost = 1 - d / 2.5 * 0.5;
      if (gm.kind[i] === CELL_FRESH)
        gridI[i] = Math.max(gridI[i], boost);
      else if (!anyFresh && gm.kind[i] === CELL_EMPTY && gridCell(g, i).col < Math.max(2, g.w / 3)) {
        gridGlyph[i] = "░";
        gridColor[i] = pal.gridBlueLt;
        gridI[i] = 0.5 * boost;
      }
    }
  }
  const slots = expertSlots(arch, L.experts);
  const expertI = new Float32Array(slots.ys.length);
  const expertBase = arch.kind === "unknown" ? 0.12 + 0.06 * Math.sin(t / 10) : 0.22;
  for (let i = 0;i < slots.ys.length; i++) {
    expertI[i] = arch.kind === "unknown" ? Math.max(0.06, expertBase + 0.05 * Math.sin(t / 10 + i * 0.7)) : expertBase;
  }
  const hiddenRows = full ? L.hidden.h : 0;
  const hiddenI = new Float32Array(hiddenRows);
  const outN = L.outN;
  const outI = new Float32Array(outN);
  const outBase = s.phase === "tool" ? 0.12 : 0.25;
  outI.fill(outBase);
  let sampled = -1;
  let sampledColor = pal.textOut;
  let sampledI = 0;
  const fanA = new BrailleCanvas(L.fanA.w, L.fanA.h);
  const fanB = full ? new BrailleCanvas(L.fanB.w, L.fanB.h) : undefined;
  const ay = (yAbs) => (yAbs - L.fanA.y) * 4 + 2;
  const ax1 = L.fanA.w * 2 - 1;
  {
    const rng = mulberry32(hash32(L.box.w, L.box.h, hashStr(arch.family), 11));
    for (let r = 0;r < g.h; r++) {
      if (rng() >= 0.4)
        continue;
      for (const sl of pickK(slots.ys.length, Math.min(2, slots.ys.length), rng)) {
        fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, base);
      }
    }
  }
  if (fanB && full) {
    const FL = L;
    const by = (yAbs) => (yAbs - FL.fanB.y) * 4 + 2;
    const bx1 = FL.fanB.w * 2 - 1;
    for (let r = 1;r < FL.hidden.h; r += 4) {
      for (let o = 0;o < outN; o++) {
        fanB.line(0, by(FL.hidden.y + r), bx1, by(outY(FL, o)), (r + o) % 2 ? pal.meshPink : pal.meshBlue, base * 0.8, { stipple: 2 });
      }
    }
  }
  if (idle) {
    const cyc = Math.floor(t / 90);
    const ph = t % 90 / 30;
    if (ph < 1 && g.h > 0 && slots.ys.length > 0) {
      const rng = mulberry32(hash32(seed, cyc, 17));
      const r = Math.floor(rng() * g.h);
      const sl = Math.floor(rng() * slots.ys.length);
      fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, 0.35 * (1 - ph), { upTo: ph });
    }
  }
  if (s.phase === "prefill") {
    for (let j = 0;j < 3; j++) {
      const b = Math.floor(t / 3) - j;
      const age = t - b * 3;
      const rng = mulberry32(hash32(seed, b, 13));
      const I = 0.45 * Math.exp(-age / 4);
      for (let n = 0;n < 6 && g.h > 0; n++) {
        const r = Math.floor(rng() * g.h);
        const sl = Math.floor(rng() * slots.ys.length);
        fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, I);
      }
    }
    for (let i = 0;i < slots.ys.length; i++) {
      if (hash32(seed, i, Math.floor(t / 2), 19) / 4294967296 < 0.6) {
        expertI[i] = Math.max(expertI[i], 0.35 + 0.15 * Math.sin(t / 4 + i));
      }
    }
  }
  let newest;
  let landed;
  const attendByPulse = [];
  for (const p of s.pulses) {
    const u = pulseU(s, p);
    if (u < 1 && (!newest || p.bornTick >= newest.bornTick))
      newest = p;
    if (u >= 1 && (!landed || p.bornTick >= landed.bornTick))
      landed = p;
    if (u >= 1)
      continue;
    const sweep = p.sweepTicks;
    const rng = mulberry32(hash32(seed, p.index, 3));
    const color = p.stream === "reasoning" ? pal.reasoning : pal.textOut;
    const layers = arch.kind === "unknown" ? 1 : arch.layers;
    const layer = 1 + Math.min(layers - 1, Math.floor(u * layers));
    const m = 2 + Math.floor(rng() * 3);
    const att = pickRecent(gm.nFilled, m, rng);
    const aI = stageI(u, 0, 0.3, sweep);
    attendByPulse.push({ born: p.bornTick, cells: att, i: aI });
    const routeLayer = u < 0.3 ? 0 : layer;
    const lit = pulseSlots(arch, slots, seed, p, routeLayer);
    if (att.length && lit.length) {
      const n = Math.max(att.length, Math.min(lit.length, 8));
      const lineI = 0.9 * aI;
      for (let l = 0;l < n; l++) {
        const cell = att[l % att.length];
        const sl = lit[l % lit.length];
        fanA.line(0, ay(gridCell(g, cell).y), ax1, ay(slots.ys[sl]), pal.route, lineI, { upTo: Math.min(1, u / 0.3) });
      }
    }
    const eI = stageI(u, 0.3, 0.42, sweep);
    if (eI > 0)
      for (const sl of lit)
        expertI[sl] = Math.max(expertI[sl], arch.kind === "unknown" ? 0.55 * eI : eI);
    let litHidden = [];
    if (full) {
      const FL = L;
      const hI = stageI(u, 0.42, 0.52, sweep);
      const hr = mulberry32(hash32(seed, p.index, 5));
      for (let r = 0;r < FL.hidden.h; r++)
        if (hr() < 0.35)
          litHidden.push(r);
      if (hI > 0)
        for (const r of litHidden)
          hiddenI[r] = Math.max(hiddenI[r], hI);
      const pI = stageI(u, 0.52, 0.85, sweep);
      if (pI > 0 && fanB) {
        const by = (yAbs) => (yAbs - FL.fanB.y) * 4 + 2;
        const bx1 = FL.fanB.w * 2 - 1;
        const upTo = Math.min(1, (u - 0.52) / 0.33);
        const targets = new Set([sampleIndex(seed, p, outN), ...pickK(outN, Math.min(3, outN), mulberry32(hash32(seed, p.index, 31)))]);
        for (const r of litHidden.slice(0, 3)) {
          for (const o of targets) {
            fanB.line(0, by(FL.hidden.y + r), bx1, by(outY(FL, o)), (r + o) % 2 ? pal.meshPink : pal.meshBlue, 0.8 * pI, { upTo });
          }
        }
      }
    }
    const sI = stageI(u, 0.85, 0.92, sweep);
    if (sI > 0) {
      const o = sampleIndex(seed, p, outN);
      if (sI >= sampledI) {
        sampled = o;
        sampledColor = color;
        sampledI = sI;
      }
      outI[o] = Math.max(outI[o], sI);
    }
    if (u >= 0.92) {
      const fr = Math.min(1, (u - 0.92) / 0.08);
      const startX = L.out.x - 1;
      const endX = g.x + g.w;
      const hx = Math.round(startX + (endX - startX) * fr);
      const tail = ["•", "∙", "·"];
      for (let k = 0;k < 3; k++) {
        const x = hx + k;
        if (x > startX)
          break;
        f.set(x, L.cometY, tail[k], sh(color, 1 - k * 0.3), bg);
      }
    }
  }
  const attended = new Map;
  const newestAttend = attendByPulse.filter((a) => a.i > 0.05).sort((a, b) => b.born - a.born)[0];
  if (newestAttend)
    for (const c of newestAttend.cells)
      attended.set(c, newestAttend.i);
  if (landed && gm.nFilled > 0) {
    const age = s.tick - (landed.bornTick + landed.sweepTicks);
    const I = Math.exp(-age / LAND_TAU);
    const c = gm.nFilled - 1;
    gridI[c] = Math.max(gridI[c], I);
  }
  fanA.blitTo(f, L.fanA.x, L.fanA.y, bg);
  if (fanB && full)
    fanB.blitTo(f, L.fanB.x, L.fanB.y, bg);
  for (let i = 0;i < cells; i++) {
    const { x, y } = gridCell(g, i);
    const a = attended.get(i);
    if (a !== undefined && a > 0.05 && gm.kind[i] !== CELL_EMPTY)
      f.set(x, y, "●", sh(pal.attendDot, Math.max(0.35, a)), bg);
    else
      f.set(x, y, gridGlyph[i], sh(gridColor[i], gridI[i]), bg);
  }
  for (let i = 0;i < slots.ys.length; i++) {
    const hue = pal.hex[hash32(i, 29) % pal.hex.length];
    let ch;
    if (arch.kind === "dense")
      ch = G.dense;
    else if (arch.kind === "unknown")
      ch = G.hexOff;
    else
      ch = i < slots.shared ? G.shared : G.hex;
    const color = arch.kind === "dense" ? pal.hidden : arch.kind === "unknown" ? pal.label : hue;
    f.set(L.experts.x, slots.ys[i], ch, sh(color, expertI[i]), bg);
  }
  if (full) {
    const FL = L;
    for (let r = 0;r < FL.hidden.h; r++) {
      const on = hiddenI[r] > 0.3;
      f.set(FL.hidden.x, FL.hidden.y + r, on ? G.node : G.nodeOff, sh(pal.hidden, Math.max(0.3, hiddenI[r])), bg);
    }
  }
  for (let o = 0;o < outN; o++) {
    if (o === sampled)
      f.set(L.out.x, outY(L, o), G.sample, sh(sampledColor, Math.max(0.5, sampledI)), bg);
    else
      f.set(L.out.x, outY(L, o), G.node, sh(pal.output, outI[o]), bg);
  }
  if (!full && sampled >= 0)
    f.set(L.out.x - 1, outY(L, sampled), "─", sh(sampledColor, sampledI), bg);
  let borderColor = pal.border;
  if (s.phase === "error") {
    const e = Math.exp(-(t - s.phaseTick) / 12);
    borderColor = mixColor(pal.border, pal.error, e);
  }
  const fail = s.flashes.find((fl) => fl.kind === "toolFail");
  drawRoundedBox(f, L.box, borderColor);
  drawHud(f, L, s, pal, opts, newest, cv, borderColor, fail ? Math.exp(-(t - fail.bornTick) / 10) : 0);
}
function mixColor(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  const ch = (sh) => Math.round((a >> sh & 255) * (1 - t) + (b >> sh & 255) * t);
  return ch(16) << 16 | ch(8) << 8 | ch(0);
}
function placeSegs(f, y, segs, x0, x1, border) {
  const avail = x1 - x0 + 1;
  const order = [...segs].sort((a, b) => b.prio - a.prio);
  const chosen = new Set;
  const width = new Map;
  let used = 0;
  for (const sg of order) {
    const need = cpLen(sg.text) + 2 + (chosen.size ? 1 : 0);
    if (used + need <= avail) {
      chosen.add(sg);
      width.set(sg, cpLen(sg.text));
      used += need;
    } else if (sg.minLen !== undefined) {
      const room = avail - used - 2 - (chosen.size ? 1 : 0);
      if (room >= sg.minLen) {
        chosen.add(sg);
        width.set(sg, room);
        used += room + 2 + (chosen.size > 1 ? 1 : 0);
      }
    }
  }
  const left = segs.filter((sg) => chosen.has(sg) && sg.side === "l");
  const right = segs.filter((sg) => chosen.has(sg) && sg.side === "r");
  let x = x0;
  const fit = (t, n) => cpLen(t) <= n ? t : n <= 1 ? truncate(t, n) : truncate(t, n - 1) + "…";
  for (const sg of left) {
    const txt = fit(sg.text, width.get(sg));
    x = embedSegment(f, y, x, txt, "┤", "├", border, sg.fg, sg.bold) + 1;
  }
  let xr = x1;
  for (let i = right.length - 1;i >= 0; i--) {
    const sg = right[i];
    const txt = fit(sg.text, width.get(sg));
    const start = xr - (cpLen(txt) + 2) + 1;
    embedSegment(f, y, start, txt, "┤", "├", border, sg.fg, sg.bold);
    xr = start - 2;
  }
  return [...chosen];
}
function archSourceTag(a) {
  switch (a.source) {
    case "server":
      return " · via server";
    case "hf":
      return " · via HF";
    case "override":
      return " · custom";
    default:
      return "";
  }
}
function honestyLabel(arch, full) {
  if (arch.kind === "unknown")
    return full ? "architecture unknown" : "arch unknown";
  return full ? "illustrative routing" : "illustrative";
}
function drawHud(f, L, s, pal, opts, newest, cv, border, failI) {
  const full = L.mode === "full";
  const t = s.tick;
  const bg = opts.bg;
  const dim = (c, i = 0.85) => shade(c, bg, i);
  const arch = s.arch;
  let phaseText;
  let phaseColor = pal.text;
  const tps = s.tps >= 1 ? `${s.tpsApprox ? "≈" : ""}${Math.round(s.tps)}${full ? " tok/s" : "t/s"}` : "";
  switch (s.phase) {
    case "idle":
      phaseText = "○ idle";
      phaseColor = dim(pal.label, 0.8);
      break;
    case "prefill": {
      const since = t - (s.prefillTick ?? t);
      phaseText = full ? `▸ PREFILL  ttft ${secs(since)}` : `▸ PREFILL ${secs(since)}`;
      phaseColor = pal.gridBlueLt;
      break;
    }
    case "decode": {
      const label = s.estimating ? "WORKING" : s.stream === "reasoning" ? full ? "REASONING" : "THINK" : "DECODE";
      phaseColor = s.stream === "reasoning" ? pal.reasoning : pal.textOut;
      if (full) {
        let lay = "";
        if (arch.kind === "unknown")
          lay = "L ?";
        else if (newest) {
          const u = pulseU(s, newest);
          const L = 1 + Math.min(arch.layers - 1, Math.floor(u * arch.layers));
          lay = `L ${L}/${arch.layers}${arch.fullAttention?.includes(L) ? " full-attn" : ""}`;
        } else
          lay = `L –/${arch.layers}`;
        const ttft = s.ttftTicks !== undefined ? `  ttft ${secs(s.ttftTicks)}` : "";
        phaseText = `▸ ${label}  ${lay}${tps ? "  " + tps : ""}${ttft}`;
      } else {
        phaseText = `▸ ${label}${tps ? " " + tps : ""}`;
      }
      break;
    }
    case "tool":
      phaseText = "⚙ TOOL";
      phaseColor = pal.tool;
      break;
    case "retry":
      phaseText = `RETRY #${s.retryAttempt ?? 1}`;
      phaseColor = Math.floor(t / 15) % 2 ? pal.warn : dim(pal.warn, 0.5);
      break;
    case "error":
      phaseText = "✕ ERROR";
      phaseColor = pal.error;
      break;
  }
  const modelName = s.model ? full ? normalizeModelID(s.model.modelID) : shortModelName(s.model.modelID) : "no model yet";
  const top = [
    { text: full ? `${modelName} · ${archSummary(arch)}${archSourceTag(arch)}` : modelName, fg: pal.text, side: "l", prio: 2, minLen: 6 },
    { text: phaseText, fg: phaseColor, side: "r", prio: 3, bold: true }
  ];
  if (s.subagentsBusy > 0)
    top.push({ text: `+${s.subagentsBusy} agents`, fg: pal.label, side: "l", prio: 1 });
  placeSegs(f, L.box.y, top, L.box.x + 2, L.box.x + L.box.w - 3, border);
  const bottom = [];
  const label = honestyLabel(arch, full);
  bottom.push({ text: label, fg: dim(pal.label, 0.75), side: "r", prio: 10 });
  if (s.tools.size > 0) {
    let first;
    for (const v of s.tools.values())
      if (!first || v.startTick < first.startTick)
        first = v;
    const more = s.tools.size > 1 ? ` +${s.tools.size - 1}` : "";
    const spin = SPINNER[Math.floor(t / 3) % SPINNER.length];
    bottom.push({
      text: `⚙ ${first.tool}${more} ${secs(t - first.startTick)} ${spin}`,
      fg: failI > 0.2 ? pal.error : pal.tool,
      side: "l",
      prio: 6,
      minLen: 6
    });
  } else if (failI > 0.2) {
    bottom.push({ text: "⚙ tool failed", fg: pal.error, side: "l", prio: 6 });
  }
  bottom.push({ text: ctxText(cv, full), fg: dim(pal.gridBlueLt), side: "l", prio: 4, minLen: 5 });
  if (full && (s.turnReasoning > 0 || s.turnText > 0)) {
    bottom.push({ text: `think ~${fmtK(s.turnReasoning)} · out ~${fmtK(s.turnText)}`, fg: dim(pal.label), side: "l", prio: 3 });
  }
  placeSegs(f, L.box.y + L.box.h - 1, bottom, L.box.x + 2, L.box.x + L.box.w - 3, border);
}
function ctxText(cv, full) {
  const lim = `${cv.approx ? "~" : ""}${fmtK(cv.limit)}`;
  if (!cv.known) {
    if (cv.used === 0)
      return full ? `ctx ? / ${lim}` : `ctx ?`;
    return full ? `ctx ? + ${fmtK(cv.used)} new / ${lim}` : `ctx ?+${fmtK(cv.used)}`;
  }
  const pct = cv.cached + cv.fresh > 0 ? Math.round(cv.cached / (cv.cached + cv.fresh) * 100) : 0;
  if (!full)
    return `ctx ${fmtK(cv.used)}/${lim}`;
  const n = 8;
  const toCells = (v) => Math.round(v / Math.max(1, cv.limit) * n);
  const c = Math.min(n, toCells(cv.cached));
  const fr = Math.min(n - c, toCells(cv.fresh));
  const gen = Math.min(n - c - fr, toCells(cv.used - cv.cached - cv.fresh));
  const bar = "▓".repeat(c) + "▒".repeat(fr) + "█".repeat(gen) + "·".repeat(n - c - fr - gen);
  return `ctx ${bar} ${pct}% cached · ${fmtK(cv.used)}/${lim}`;
}

// src/core/headless.ts
function* play(signals, o) {
  const sim = createSim(o.sessionKey ?? "demo", o.arch);
  const t0 = signals.length ? signals[0].ts : 0;
  const d = new Driver(sim, { t0, maxCatchUp: Number.MAX_SAFE_INTEGER });
  for (const s of signals)
    d.push(s);
  const endTick = o.limit ?? (signals.length ? Math.ceil((signals[signals.length - 1].ts - t0) / TICK_MS) + 90 : 90);
  const every = Math.max(1, o.every ?? 1);
  for (let tick = 0;tick <= endTick; tick++) {
    d.advanceTo(t0 + tick * TICK_MS);
    if (tick % every === 0)
      yield { tick, sim, frame: renderViz(o.w, o.h, sim, o.pal, o.viz) };
  }
}
function phaseTicks(signals, o) {
  const seen = new Map;
  let decodeStart = -1;
  const out = [];
  for (const { tick, sim } of play(signals, { ...o, every: 1, w: 1, h: 1 })) {
    const key = sim.phase === "decode" ? `decode:${sim.stream}` : sim.phase;
    if (!seen.has(key)) {
      seen.set(key, tick);
      out.push({ label: key, tick: tick + (sim.phase === "prefill" ? 12 : 0) });
    }
    if (sim.phase === "decode" && decodeStart < 0)
      decodeStart = tick;
    if (decodeStart >= 0 && tick === decodeStart + 20)
      out.push({ label: "decode+20", tick });
  }
  return out;
}

// src/core/protocol.ts
var TYPES = new Set([
  "model",
  "arch",
  "mode",
  "turn.start",
  "step.start",
  "delta",
  "tool.start",
  "tool.end",
  "step.end",
  "retry",
  "error",
  "idle",
  "subagents",
  "reset"
]);
function isSignal(v) {
  if (typeof v !== "object" || v === null)
    return false;
  const o = v;
  if (typeof o.t !== "string" || !TYPES.has(o.t) || typeof o.ts !== "number" || !Number.isFinite(o.ts))
    return false;
  switch (o.t) {
    case "model": {
      const m = o.model;
      return !!m && typeof m.providerID === "string" && typeof m.modelID === "string";
    }
    case "arch": {
      const a = o.arch;
      return typeof o.modelID === "string" && !!a && (a.kind === "moe" || a.kind === "dense" || a.kind === "unknown");
    }
    case "mode":
      return typeof o.streaming === "boolean";
    case "delta":
      return (o.kind === "text" || o.kind === "reasoning") && typeof o.chars === "number";
    case "tool.start":
      return typeof o.callID === "string" && typeof o.tool === "string";
    case "tool.end":
      return typeof o.callID === "string" && typeof o.ok === "boolean";
    case "retry":
      return typeof o.attempt === "number";
    case "subagents":
      return typeof o.busy === "number";
    case "reset":
      return typeof o.sessionKey === "string";
    default:
      return true;
  }
}

// src/backends/ansi.ts
function narrow(c) {
  const cp = c.codePointAt(0) ?? 32;
  return cp < 127 || cp === 183 || cp === 8226 || cp === 8729 || cp >= 9472 && cp <= 9727 || cp >= 10240 && cp <= 10495;
}

class Blitter {
  truecolor;
  prev;
  constructor(truecolor = true) {
    this.truecolor = truecolor;
  }
  reset() {
    this.prev = undefined;
  }
  blit(f, termW = f.w, termH = f.h) {
    const full = !this.prev || this.prev.w !== f.w || this.prev.h !== f.h;
    let out = "\x1B[?2026h";
    if (full)
      out += "\x1B[0m\x1B[2J\x1B[H";
    let px = -1, py = -1, pfg = -2, pbg = -2, pbold = -1;
    const W = Math.min(f.w, termW), H = Math.min(f.h, termH);
    for (let y = 0;y < H; y++) {
      for (let x = 0;x < W; x++) {
        const i = y * f.w + x;
        if (!full && this.prev.cellEquals(f, i))
          continue;
        if (px !== x || py !== y) {
          out += `\x1B[${y + 1};${x + 1}H`;
          px = x;
          py = y;
        }
        if (f.fg[i] !== pfg) {
          out += sgrFg(f.fg[i], this.truecolor);
          pfg = f.fg[i];
        }
        if (f.bg[i] !== pbg) {
          out += sgrBg(f.bg[i], this.truecolor);
          pbg = f.bg[i];
        }
        if (f.bold[i] !== pbold) {
          out += f.bold[i] ? "\x1B[1m" : "\x1B[22m";
          pbold = f.bold[i];
        }
        const ch = f.ch[i] || " ";
        out += ch;
        px = narrow(ch) ? px + 1 : -1;
      }
    }
    this.prev = f;
    return out + "\x1B[0m\x1B[?2026l";
  }
}
function detectTruecolor(env = process.env) {
  const ct = (env.COLORTERM ?? "").toLowerCase();
  return ct === "truecolor" || ct === "24bit";
}
function runInteractive(o) {
  const out = process.stdout;
  const inp = process.stdin;
  if (!out.isTTY) {
    process.stderr.write("inlineviz: interactive mode needs a TTY (try `capture` or `screens` for headless output)\n");
    process.exit(2);
  }
  const blitter = new Blitter(detectTruecolor());
  let resized = true;
  let closed = false;
  let viz = { ...o.viz };
  let frameNo = 0;
  const restore = () => {
    if (closed)
      return;
    closed = true;
    clearInterval(timer);
    try {
      o.onExit?.();
    } catch {}
    try {
      if (inp.isTTY)
        inp.setRawMode(false);
    } catch {}
    out.write("\x1B[0m\x1B[?25h\x1B[?1049l");
  };
  const quit = (code = 0) => {
    restore();
    process.exit(code);
  };
  process.on("exit", restore);
  process.on("SIGINT", () => quit(130));
  process.on("SIGTERM", () => quit(143));
  process.on("uncaughtException", (e) => {
    restore();
    process.stderr.write(`inlineviz: ${e?.stack ?? e}
`);
    process.exit(1);
  });
  out.on("resize", () => {
    resized = true;
  });
  out.write("\x1B[?1049h\x1B[?25l\x1B[2J");
  if (inp.isTTY) {
    inp.setRawMode(true);
    inp.resume();
    inp.setEncoding("utf8");
    inp.on("data", (k) => {
      if (k === "q" || k === "\x03")
        quit(0);
      else if (k === "l")
        viz = { ...viz, labels: !viz.labels };
      else
        o.onKey?.(k);
    });
  }
  const tickMs = 1000 / Math.max(1, Math.min(60, o.fps));
  const timer = setInterval(() => {
    if (closed)
      return;
    if (resized) {
      resized = false;
      blitter.reset();
    }
    o.driver.advanceTo(Date.now());
    const s = o.driver.sim;
    frameNo++;
    if (s.phase === "idle" && s.pulses.length === 0 && frameNo % 3 !== 0)
      return;
    const w = out.columns || 80, h = out.rows || 24;
    out.write(blitter.blit(renderViz(w, h, s, o.pal, { ...viz, bg: DEFAULT }), w, h));
  }, tickMs);
}

// src/adapters/ndjson.ts
function parseNdjsonLine(line) {
  const s = line.trim();
  if (!s || s.startsWith("#"))
    return;
  try {
    const v = JSON.parse(s);
    return isSignal(v) ? v : undefined;
  } catch {
    return;
  }
}

// src/hosts/cli.ts
var HELP = `inlineviz — live visualization of what an LLM is doing

usage:
  inlineviz                          demo loop (all scripts)
  inlineviz demo [script]            ${DEMO_NAMES.join(" | ")} | all
  inlineviz replay <file.ndjson> [-speed 2]
  inlineviz stdin                    read NDJSON Signals from stdin
  inlineviz attach <url> [-session id]   follow a running OpenCode server (opencode serve)
  inlineviz claude [-session id] [-events file]   follow Claude Code (needs the inlineviz Claude Code plugin)
  inlineviz open [claude|demo]         open the viewer in a tmux split or a new terminal window
  inlineviz capture -script agentic -size 100x30 [-every 15] [-limit N] [-text|-ansi] [-out frames]
  inlineviz screens [-size 100x30] [-script agentic] [-tick N] [-visible 0.3]
                                       every phase at a size (all sizes if omitted);
                                       -visible blanks cells dimmer than a luminance threshold
  inlineviz registry                 print the architecture table
  inlineviz help

common flags: -fps 30  -ascii-safe  -no-labels  -record out.ndjson  -arch '<json {regex: Arch}>'
`;
function parseFlags(args) {
  const pos = [];
  const flags = {};
  for (let i = 0;i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-") && a.length > 1 && isNaN(Number(a))) {
      const k = a.replace(/^-+/, "");
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[k] = next;
        i++;
      } else
        flags[k] = true;
    } else
      pos.push(a);
  }
  return { pos, flags };
}
function die(msg) {
  process.stderr.write(`inlineviz: ${msg}
`);
  process.exit(2);
}
function parseSize(v, def) {
  if (typeof v !== "string")
    return def;
  const m = v.match(/^(\d+)x(\d+)$/);
  if (!m)
    die(`bad -size ${v} (want WxH)`);
  return [Number(m[1]), Number(m[2])];
}
function vizOpts(flags) {
  return { labels: !flags["no-labels"], asciiSafe: !!flags["ascii-safe"], bg: DEFAULT };
}
function archOverrides(flags) {
  if (typeof flags.arch !== "string")
    return;
  try {
    return JSON.parse(flags.arch);
  } catch {
    die('-arch must be JSON: {"regex": {"kind":"moe",...}}');
  }
}
function scriptName(v, def) {
  if (typeof v !== "string")
    return def;
  if (!isDemoName(v))
    die(`unknown script ${v} (${DEMO_NAMES.join(", ")}, all)`);
  return v;
}
function capture(flags) {
  const name = scriptName(flags.script, "agentic");
  const [w, h] = parseSize(flags.size, [100, 30]);
  const every = Number(flags.every ?? 15);
  if (!(every >= 1))
    die("-every must be >= 1");
  const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;
  const out = typeof flags.out === "string" ? flags.out : "frames";
  const ansi = !!flags.ansi;
  mkdirSync(out, { recursive: true });
  let n = 0;
  for (const { tick, frame } of play(demoSignals(name), { w, h, pal: DEFAULT_PALETTE, viz: vizOpts(flags), every, limit, arch: archOverrides(flags) })) {
    const file = join2(out, `frame-${String(tick).padStart(5, "0")}.${ansi ? "ans" : "txt"}`);
    writeFileSync(file, ansi ? frame.toAnsi() : frame.toText() + `
`);
    n++;
  }
  process.stdout.write(`wrote ${n} frames to ${out}/
`);
}
var SCREEN_SIZES = [[40, 14], [62, 19], [90, 30], [137, 45], [40, 1]];
function visibleText(f, min) {
  const lines = [];
  for (let y = 0;y < f.h; y++) {
    let s = "";
    for (let x = 0;x < f.w; x++) {
      const i = y * f.w + x;
      const c = f.fg[i];
      const lum = c === DEFAULT ? 1 : (0.2126 * (c >> 16 & 255) + 0.7152 * (c >> 8 & 255) + 0.0722 * (c & 255)) / 255;
      s += lum >= min ? f.ch[i] : " ";
    }
    lines.push(s);
  }
  return lines.join(`
`);
}
function screens(flags) {
  const vis = flags.visible === true ? 0.3 : typeof flags.visible === "string" ? Number(flags.visible) : undefined;
  const name = scriptName(flags.script, "agentic");
  const sizes = typeof flags.size === "string" ? [parseSize(flags.size, [100, 30])] : SCREEN_SIZES;
  const sigs = demoSignals(name);
  const viz = vizOpts(flags);
  const ticks = typeof flags.tick === "string" ? [{ label: `tick ${flags.tick}`, tick: Number(flags.tick) }] : phaseTicks(sigs, { w: 1, h: 1, pal: DEFAULT_PALETTE, viz });
  for (const [w, h] of sizes) {
    for (const { label, tick } of ticks) {
      let shown = false;
      for (const fr of play(sigs, { w, h, pal: DEFAULT_PALETTE, viz, every: 1, limit: tick, arch: archOverrides(flags) })) {
        if (fr.tick !== tick)
          continue;
        const body = vis !== undefined ? visibleText(fr.frame, vis) : fr.frame.toText();
        process.stdout.write(`── ${name} ${w}x${h} · ${label} · tick ${tick} · phase ${fr.sim.phase} ──
${body}

`);
        shown = true;
      }
      if (!shown)
        process.stdout.write(`── ${w}x${h} · ${label}: tick ${tick} out of range ──
`);
    }
  }
}
function registry() {
  for (const r of RULES)
    process.stdout.write(`${r.re.source.padEnd(40)} ${r.arch.kind.padEnd(8)} ${archSummary(r.arch)}${r.arch.note ? `  (${r.arch.note})` : ""}
`);
}
function makeLive(flags) {
  const sim = createSim("live", archOverrides(flags));
  const driver = new Driver(sim);
  const record = typeof flags.record === "string" ? flags.record : undefined;
  if (record)
    writeFileSync(record, `# inlineviz recording ${new Date().toISOString()}
`);
  const push = (s) => {
    driver.push(s);
    if (record)
      writeFileSync(record, JSON.stringify(s) + `
`, { flag: "a" });
  };
  return { sim, driver, push };
}
function startInteractive(flags, setup, onKey) {
  const live = makeLive(flags);
  const cleanup = setup(live.push, Date.now) || undefined;
  runInteractive({
    driver: live.driver,
    pal: DEFAULT_PALETTE,
    viz: vizOpts(flags),
    fps: Number(flags.fps ?? 30),
    onKey,
    onExit: cleanup
  });
}
function scheduleDemo(name, push, loop) {
  let timers = [];
  let stopped = false;
  const run = () => {
    if (stopped)
      return;
    const t0 = Date.now();
    for (const s of demoSignals(name, t0))
      timers.push(setTimeout(() => push({ ...s, ts: Date.now() }), s.ts - t0));
    if (loop)
      timers.push(setTimeout(run, demoDuration(name)));
  };
  run();
  return () => {
    stopped = true;
    for (const t of timers)
      clearTimeout(t);
    timers = [];
  };
}
function demo(pos, flags, loopDefault) {
  let idx = Math.max(0, DEMO_NAMES.indexOf(pos[0] ?? ""));
  let name = pos[0] ? scriptName(pos[0], "all") : "all";
  let stop;
  let pushRef;
  startInteractive(flags, (push) => {
    pushRef = push;
    stop = scheduleDemo(name, push, loopDefault || name === "all");
    return () => stop?.();
  }, (k) => {
    if (k === "d" && pushRef) {
      stop?.();
      idx = (idx + 1) % DEMO_NAMES.length;
      name = DEMO_NAMES[idx];
      pushRef({ t: "reset", ts: Date.now(), sessionKey: `demo-${name}` });
      stop = scheduleDemo(name, pushRef, true);
    }
  });
}
function replay(pos, flags) {
  const file = pos[0] ?? die("replay needs a file");
  const speed = Number(flags.speed ?? 1);
  const sigs = [];
  for (const line of readFileSync(file, "utf8").split(`
`)) {
    const s = parseNdjsonLine(line);
    if (s)
      sigs.push(s);
  }
  if (!sigs.length)
    die(`no signals in ${file}`);
  startInteractive(flags, (push) => {
    const src0 = sigs[0].ts;
    const t0 = Date.now() + 300;
    const timers = sigs.map((s) => setTimeout(() => push({ ...s, ts: Date.now() }), Math.max(0, t0 + (s.ts - src0) / speed - Date.now())));
    return () => timers.forEach(clearTimeout);
  });
}
function stdin(flags) {
  if (process.stdin.isTTY)
    die("stdin: pipe NDJSON Signals in, e.g. `cat rec.ndjson | inlineviz stdin`");
  startInteractive(flags, (push) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf(`
`)) >= 0) {
        const s = parseNdjsonLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (s)
          push({ ...s, ts: Date.now() });
      }
    });
  });
}
function claude(flags) {
  startInteractive(flags, (push, now) => {
    (async () => {
      await Promise.resolve().then(() => init_claude_tail());
      const f = followClaude({
        push,
        now,
        sessionID: typeof flags.session === "string" ? flags.session : undefined,
        events: typeof flags.events === "string" ? flags.events : undefined
      });
      stopClaude = f.stop;
    })();
    return () => stopClaude?.();
  });
}
var stopClaude;
var shq = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
async function open(pos) {
  const what = pos[0] === "demo" ? "demo" : "claude";
  const cmd = [process.execPath, process.argv[1], what].map(shq).join(" ");
  const { spawnSync } = await import("node:child_process");
  if (process.env.TMUX) {
    const r = spawnSync("tmux", ["split-window", "-h", "-l", "42%", cmd], { stdio: "ignore" });
    if (r.status === 0)
      return void process.stdout.write(`inlineviz: opened in a tmux split
`);
  }
  if (process.platform === "darwin") {
    const esc = cmd.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    const iterm = process.env.TERM_PROGRAM === "iTerm.app";
    const script = iterm ? `tell application "iTerm" to create window with default profile command "${esc}"` : `tell application "Terminal"
  activate
  do script "${esc}"
end tell`;
    const r = spawnSync("osascript", ["-e", script], { stdio: "ignore" });
    if (r.status === 0)
      return void process.stdout.write(`inlineviz: opened in a new ${iterm ? "iTerm" : "Terminal"} window
`);
  }
  process.stdout.write(`inlineviz: run this in another terminal pane:
  ${cmd}
`);
}
async function attach(pos, flags) {
  const url = pos[0] ?? "http://127.0.0.1:4096";
  await Promise.resolve().then(() => init_opencode_sse());
  startInteractive(flags, (push, now) => {
    const ctl = attachOpenCode(url, push, now, typeof flags.session === "string" ? flags.session : undefined);
    return () => ctl.stop();
  });
}
async function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseFlags(rest);
  switch (cmd) {
    case undefined:
      return demo([], parseFlags(argv).flags, true);
    case "demo":
      return demo(pos, flags, false);
    case "replay":
      return replay(pos, flags);
    case "stdin":
      return stdin(flags);
    case "attach":
      return attach(pos, flags);
    case "claude":
      return claude(flags);
    case "open":
      return open(pos);
    case "capture":
      return capture(flags);
    case "screens":
      return screens(flags);
    case "registry":
      return registry();
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    default:
      if (cmd.startsWith("-"))
        return demo([], parseFlags(argv).flags, true);
      die(`unknown command ${cmd}

${HELP}`);
  }
}
if (false) {}

// src/hosts/cli-entry.ts
await main(process.argv.slice(2));
