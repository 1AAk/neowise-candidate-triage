import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const allowedTopics = new Set(["delivery", "pricing", "other"]);
const modelTimeoutMs = 300;
const maxInputBytes = 16 * 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function parseText(request) {
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxInputBytes) return null;
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (typeof body.text !== "string" || !body.text.trim()) return null;
    return body.text.trim();
  } catch {
    return null;
  }
}

async function queryModel(text) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Model timeout"));
      }, modelTimeoutMs);
    });
    const raw = await Promise.race([
      classify(text, { signal: controller.signal }),
      timeout,
    ]);
    const result = JSON.parse(raw);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Invalid model result");
    }
    if (!allowedTopics.has(result.topic) ||
        typeof result.draft !== "string" ||
        !result.draft.trim()) {
      throw new Error("Unexpected topic or empty draft");
    }
    return { status: "ready", topic: result.topic, draft: result.draft.trim() };
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  const text = await parseText(request);
  if (text === null) {
    json(response, 400, { status: "invalid_input" });
    return;
  }

  try {
    json(response, 200, await queryModel(text));
  } catch {
    // Never show an unchecked model response as a ready-to-send draft.
    json(response, 200, { status: "manual_review", topic: null, draft: null });
  }
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    json(response, 404, { status: "not_found" });
    return;
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
