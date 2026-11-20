import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

let processUnderTest;
let endpoint;

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  const port = await reserveLoopbackPort();
  endpoint = "http://127.0.0.1:" + port;
  processUnderTest = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/runner", PORT: String(port) },
    stdio: "ignore",
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (processUnderTest.exitCode !== null) {
      throw new Error("Server exited during startup: " + processUnderTest.exitCode);
    }
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(300) });
      if (response.status === 200) return;
    } catch {
      // A short loopback readiness probe; no external networking.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Server did not start on loopback");
});

after(async () => {
  if (processUnderTest?.exitCode === null) {
    processUnderTest.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => processUnderTest.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (processUnderTest.exitCode === null) processUnderTest.kill("SIGKILL");
  }
});

async function post(body) {
  const response = await fetch(endpoint + "/api/triage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(3500),
  });
  return { code: response.status, body: await response.json() };
}

const ready = (topic) => (result) => {
  assert.equal(result.code, 200);
  assert.equal(result.body.status, "ready");
  assert.equal(result.body.topic, topic);
  assert.equal(typeof result.body.draft, "string");
  assert.ok(result.body.draft.trim().length > 0);
};

const invalid = (result) => {
  assert.equal(result.code, 400);
  assert.deepEqual(result.body, { status: "invalid_input" });
};

const manual = (result) => {
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, { status: "manual_review", topic: null, draft: null });
};

test("valid delivery request is ready", async () => ready("delivery")(await post({ text: "Когда будет доставка?" })));
test("valid pricing request is ready", async () => ready("pricing")(await post({ text: "Какая цена товара?" })));
test("unclassified request is ready with other topic", async () => ready("other")(await post({ text: "Здравствуйте!" })));

test("empty text is invalid input", async () => invalid(await post({ text: "" })));
test("missing text is invalid input", async () => invalid(await post({})));
test("non-string text is invalid input", async () => invalid(await post({ text: 123 })));
test("broken JSON is invalid input", async () => invalid(await post("{bad JSON")));
test("whitespace-only text is invalid input", async () => invalid(await post({ text: "  \n\t " })));

test("model error requires manual review", async () => manual(await post({ text: "Заявка [error]" })));
test("malformed model JSON requires manual review", async () => manual(await post({ text: "Заявка [bad-json]" })));
test("unsupported topic requires manual review", async () => manual(await post({ text: "Заявка [bad-topic]" })));
test("empty model draft requires manual review", async () => manual(await post({ text: "Заявка [empty-draft]" })));

test("slow model returns manual review after 300 ms deadline", async () => {
  const started = performance.now();
  const result = await post({ text: "Заявка [timeout]" });
  const duration = performance.now() - started;
  manual(result);
  assert.ok(duration < 650, "Expected a 300 ms deadline, got " + duration.toFixed(1) + " ms");
});

test("unknown API route returns not_found", async () => {
  const response = await fetch(endpoint + "/api/not-found");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: "not_found" });
});

test("root page remains available", async () => {
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Текст заявки/);
});
