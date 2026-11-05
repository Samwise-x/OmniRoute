import test from "node:test";
import assert from "node:assert/strict";

import { getFleetSkills, clearFleetSkillsCache } from "../../src/lib/conductor/fleetSkills.ts";

const RUNNERS = [
  {
    id: "r_1",
    online: true,
    capabilities: {
      name: "devbox",
      clis: [
        { profile: "claude", models: [{ id: "claude-sonnet-5", cost: 3, capability: 4 }] },
        { profile: "codex" },
      ],
      skills: ["deploy"],
    },
  },
  {
    id: "r_2",
    online: true,
    capabilities: { name: "vm02", clis: [{ profile: "claude" }], skills: [] },
  },
  {
    id: "r_3",
    online: false, // offline: fora do anúncio
    capabilities: { name: "morta", clis: [{ profile: "gemini" }], skills: ["secret"] },
  },
];

function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

test.beforeEach(() => {
  clearFleetSkillsCache();
  process.env.CONDUCTOR_HUB_URL = "http://hub.test:7910";
  process.env.CONDUCTOR_HUB_TOKEN = "tok";
});

test.after(() => {
  delete process.env.CONDUCTOR_HUB_URL;
  delete process.env.CONDUCTOR_HUB_TOKEN;
});

test("derives one skill per unique online CLI profile + one per declared OASF skill", async () => {
  const { impl, calls } = fakeFetch(RUNNERS);
  const skills = await getFleetSkills({ fetchImpl: impl });
  const ids = skills.map((s) => s.id).sort();
  assert.deepEqual(ids, ["conductor-cli-claude", "conductor-cli-codex", "conductor-skill-deploy"]);
  assert.ok(calls[0].includes("/v1/runners"));
  const claude = skills.find((s) => s.id === "conductor-cli-claude")!;
  assert.match(claude.description, /2 runner/);
  assert.match(claude.description, /claude-sonnet-5/);
  assert.ok(claude.tags.includes("conductor"));
  // runner offline não anuncia nada (gemini/secret ausentes)
  assert.ok(!ids.some((i) => i.includes("gemini") || i.includes("secret")));
});

test("caches for the TTL and refetches after it expires (injectable clock)", async () => {
  const { impl, calls } = fakeFetch(RUNNERS);
  let now = 1_000_000;
  await getFleetSkills({ fetchImpl: impl, nowMs: () => now });
  await getFleetSkills({ fetchImpl: impl, nowMs: () => now + 30_000 });
  assert.equal(calls.length, 1, "dentro do TTL: sem refetch");
  now += 61_000;
  await getFleetSkills({ fetchImpl: impl, nowMs: () => now });
  assert.equal(calls.length, 2, "TTL vencido: refetch");
});

test("hub offline/erro → [] (o card omite a seção, nunca quebra)", async () => {
  const failing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await getFleetSkills({ fetchImpl: failing }), []);
  const { impl } = fakeFetch({ error: "x" }, 503);
  assert.deepEqual(await getFleetSkills({ fetchImpl: impl }), []);
});

test("sem CONDUCTOR_HUB_URL → [] sem nem tentar fetch", async () => {
  delete process.env.CONDUCTOR_HUB_URL;
  const { impl, calls } = fakeFetch(RUNNERS);
  assert.deepEqual(await getFleetSkills({ fetchImpl: impl }), []);
  assert.equal(calls.length, 0);
});

test("shape inválido do hub → [] (input não confiável)", async () => {
  const { impl } = fakeFetch({ nao: "é array" });
  assert.deepEqual(await getFleetSkills({ fetchImpl: impl }), []);
});

// Regression: the bundled Hub advertises `capabilities.clis[].models` as plain
// STRINGS (see services/omni-conductor/hub.mjs `cleanRunner` + the Runner's
// registration payload), while the OASF-shaped registry uses `{id}` objects.
// The strict `z.object({ id: z.string() })` rejected the real Hub shape and the
// whole fleet silently vanished from the Agent Card — a live deployment showed
// `skills: []` while `GET /v1/runners` was returning an online gateway runner.
test("accepts the bundled Hub's string model list (real deployment shape)", async () => {
  const REAL_HUB = [
    {
      id: "probe-runner",
      online: true,
      draining: false,
      capabilities: {
        name: "probe-runner",
        clis: [{ profile: "gateway", models: ["*"] }],
        skills: [],
      },
    },
    {
      id: "claude-box",
      online: true,
      draining: false,
      capabilities: {
        name: "claude-box",
        clis: [{ profile: "claude", models: ["claude-sonnet-5", "claude-opus-5"] }],
        skills: ["deploy"],
      },
    },
  ];
  const { impl } = fakeFetch(REAL_HUB);
  const skills = await getFleetSkills({ fetchImpl: impl });
  const ids = skills.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    "conductor-cli-claude",
    "conductor-cli-gateway",
    "conductor-skill-deploy",
  ]);
  const claude = skills.find((s) => s.id === "conductor-cli-claude")!;
  assert.match(claude.description, /claude-sonnet-5/);
  assert.ok(claude.tags.includes("claude"));
});

test("tolerates a mixed string/object model list without dropping the profile", async () => {
  const MIXED = [
    {
      id: "r",
      online: true,
      capabilities: {
        clis: [{ profile: "codex", models: [{ id: "gpt-5.5" }, "gpt-5.5-mini", 42] }],
      },
    },
  ];
  const { impl } = fakeFetch(MIXED);
  const skills = await getFleetSkills({ fetchImpl: impl });
  assert.deepEqual(
    skills.map((s) => s.id),
    ["conductor-cli-codex"]
  );
  assert.match(skills[0].description, /gpt-5\.5/);
  assert.match(skills[0].description, /gpt-5\.5-mini/);
});
