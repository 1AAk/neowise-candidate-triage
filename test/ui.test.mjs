import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function setupPage(responses) {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "Page must contain a small inline script");
  const handlers = {};
  const nodes = Object.fromEntries([
    "form", "#message", "#feedback", "#notice", "#success",
    "#topic", "#draft", "button[type=submit]",
  ].map((selector) => [selector, {
    textContent: "", value: "", hidden: true, disabled: false,
    addEventListener(event, callback) { handlers[event] = callback; },
  }]));
  nodes.form.hidden = false;
  nodes["#message"].hidden = false;
  const document = { querySelector(selector) { return nodes[selector] ?? null; } };
  let calls = 0;
  const fetch = async () => {
    const response = responses[calls++];
    if (response instanceof Error) throw response;
    return {
      ok: response.ok !== false,
      status: response.code ?? 200,
      json: async () => response.body,
    };
  };
  vm.runInNewContext(script, { document, fetch, JSON, console }, { timeout: 1000 });
  assert.equal(typeof handlers.submit, "function", "Form must register submit handler");
  return {
    nodes,
    get calls() { return calls; },
    async submit(text) {
      nodes["#message"].value = text;
      await handlers.submit({ preventDefault() {} });
    },
  };
}

test("successful AI response displays topic and human-readable draft", async () => {
  const page = setupPage([{
    body: { status: "ready", topic: "delivery", draft: "Ответ для клиента" },
  }]);
  await page.submit("доставка");
  assert.equal(page.nodes["#feedback"].hidden, false);
  assert.equal(page.nodes["#success"].hidden, false);
  assert.match(page.nodes["#topic"].textContent, /достав/i);
  assert.equal(page.nodes["#draft"].textContent, "Ответ для клиента");
  assert.equal(page.nodes["button[type=submit]"].disabled, false);
});

test("manual_review removes previous AI draft and asks for human review", async () => {
  const page = setupPage([
    { body: { status: "ready", topic: "other", draft: "Прошлый черновик" } },
    { body: { status: "manual_review", topic: null, draft: null } },
  ]);
  await page.submit("обычный запрос");
  assert.equal(page.nodes["#draft"].textContent, "Прошлый черновик");
  await page.submit("[error]");
  assert.equal(page.nodes["#success"].hidden, true);
  assert.equal(page.nodes["#draft"].textContent, "");
  assert.equal(page.nodes["#topic"].textContent, "");
  assert.match(page.nodes["#notice"].textContent, /ручн/i);
  assert.equal(page.calls, 2);
});

test("invalid_input displays an actionable prompt and clears draft", async () => {
  const page = setupPage([
    { body: { status: "ready", topic: "pricing", draft: "Старый черновик" } },
    { ok: false, code: 400, body: { status: "invalid_input" } },
  ]);
  await page.submit("цена");
  await page.submit(" ");
  assert.equal(page.nodes["#draft"].textContent, "");
  assert.equal(page.nodes["#success"].hidden, true);
  assert.match(page.nodes["#notice"].textContent, /текст|заявк/i);
});

test("network failure never leaves a stale draft on screen", async () => {
  const page = setupPage([
    { body: { status: "ready", topic: "other", draft: "Не показывать снова" } },
    new Error("offline"),
  ]);
  await page.submit("обычный");
  await page.submit("повтор");
  assert.equal(page.nodes["#draft"].textContent, "");
  assert.equal(page.nodes["#success"].hidden, true);
  assert.match(page.nodes["#notice"].textContent, /ручн|не удалось/i);
  assert.equal(page.nodes["button[type=submit]"].disabled, false);
});
