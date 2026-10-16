import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import {
  assessPointer,
  checkTargets,
  notifySentry,
  parseTargets,
  pointerAgeHours,
  summarize,
} from "./watchdog.mjs";

const NOW = Date.parse("2026-10-16T08:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const pointer = (over = {}) => ({
  schemaVersion: "v1",
  slug: "premier-league-2026-27",
  version: "2026-10-15-3a5ba91666d4",
  publishedAt: hoursAgo(19),
  ...over,
});
const assess = (p, opts = {}) =>
  assessPointer(p, { slug: "premier-league-2026-27", lifecycle: "active", now: NOW, ...opts });

test("a fresh pointer has no failures", () => {
  assert.deepEqual(assess(pointer()), { failures: [], warnings: [] });
});

test("the 48h limit: 47.9h passes, 48.1h is STALE", () => {
  assert.deepEqual(assess(pointer({ publishedAt: hoursAgo(47.9) })).failures, []);
  const stale = assess(pointer({ publishedAt: hoursAgo(48.1) }));
  assert.equal(stale.failures.length, 1);
  assert.match(stale.failures[0], /STALE/);
});

test("--max-age-hours is honoured", () => {
  const r = assess(pointer({ publishedAt: hoursAgo(5) }), { maxAgeHours: 4 });
  assert.match(r.failures[0], /STALE/);
});

test("a future publishedAt beyond 1h of skew is a failure, within 1h it is fine", () => {
  assert.match(assess(pointer({ publishedAt: hoursAgo(-3) })).failures[0], /FUTURE/);
  assert.deepEqual(assess(pointer({ publishedAt: hoursAgo(-0.5) })).failures, []);
});

test("a missing or unparseable publishedAt fails instead of reading as fresh", () => {
  assert.match(assess(pointer({ publishedAt: undefined })).failures[0], /missing or unparseable/);
  assert.match(assess(pointer({ publishedAt: "yesterday" })).failures[0], /missing or unparseable/);
  assert.equal(pointerAgeHours(null, NOW), null);
});

test("a finished competition is not aged, but its other checks still apply", () => {
  const old = pointer({ publishedAt: hoursAgo(327) });
  const ok = assess(old, { lifecycle: "finished" });
  assert.deepEqual(ok.failures, []);
  assert.match(ok.warnings[0], /finished/);
  const broken = assess(pointer({ publishedAt: undefined }), { lifecycle: "finished" });
  assert.match(broken.failures[0], /missing or unparseable/);
});

test("only the exact string `finished` is exempt: an unknown lifecycle fails closed", () => {
  const old = pointer({ publishedAt: hoursAgo(327) });
  assert.match(assess(old, { lifecycle: null }).failures[0], /STALE/);
  assert.match(assess(old, { lifecycle: "Finished" }).failures[0], /STALE/);
});

test("wrong schemaVersion, slug mismatch and a bad version key fail", () => {
  assert.match(assess(pointer({ schemaVersion: "v2" })).failures[0], /schemaVersion/);
  assert.match(assess(pointer({ slug: "other" })).failures[0], /slug/);
  assert.match(assess(pointer({ version: "../../x" })).failures[0], /valid version key/);
  assert.match(assess(pointer({ version: "" })).failures[0], /no version/);
});

test("a non-object pointer fails closed", () => {
  assert.ok(assess(null).failures.length > 0);
  assert.ok(assess("x").failures.length > 0);
});

test("parseTargets reads slug[:lifecycle] separated by spaces, commas or newlines", () => {
  assert.deepEqual(parseTargets("a-b:finished\n c-d:active, e-f"), [
    { slug: "a-b", lifecycle: "finished" },
    { slug: "c-d", lifecycle: "active" },
    { slug: "e-f", lifecycle: null },
  ]);
});

test("parseTargets rejects an empty list and a slug that is not kebab-case", () => {
  assert.throws(() => parseTargets("  "), /no competitions/);
  assert.throws(() => parseTargets("Bad_Slug"), /kebab-case/);
  assert.throws(() => parseTargets("../x"), /kebab-case/);
});

const reply = (status, body) => ({ status, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });
const fetcher = (table) => async (url) => {
  const hit = table[url.split("/manifests/")[1].split("/")[0]];
  if (hit instanceof Error) throw hit;
  return hit;
};
const run = (targets, table, extra = {}) =>
  checkTargets({
    baseUrl: "https://data.example",
    targets,
    fetchImpl: fetcher(table),
    now: NOW,
    ...extra,
  });

test("one board's problem never hides another board's STALE", async () => {
  const rows = await run(
    [{ slug: "a", lifecycle: "active" }, { slug: "b", lifecycle: "active" }, { slug: "c", lifecycle: "active" }],
    {
      a: new Error("socket hang up"),
      b: reply(200, pointer({ slug: "b", publishedAt: hoursAgo(60) })),
      c: reply(200, pointer({ slug: "c" })),
    },
  );
  assert.deepEqual(rows.map((r) => [r.slug, r.status]), [["a", "unreachable"], ["b", "failed"], ["c", "ok"]]);
  assert.match(rows[0].failures[0], /socket hang up/);
  assert.match(rows[1].failures[0], /STALE/);
});

test("HTTP 404: a failure for an active board, a warning for an upcoming one", async () => {
  const rows = await run(
    [{ slug: "a", lifecycle: "active" }, { slug: "b", lifecycle: "upcoming" }],
    { a: reply(404, "nope"), b: reply(404, "nope") },
  );
  assert.deepEqual(rows.map((r) => [r.status, r.ok]), [["never-flipped", false], ["never-flipped", true]]);
  assert.equal(rows[1].warnings.length, 1);
});

test("any other HTTP status, and a non-JSON body, are failures", async () => {
  const rows = await run(
    [{ slug: "a", lifecycle: "active" }, { slug: "b", lifecycle: "active" }],
    { a: reply(503, "down"), b: reply(200, "<html>") },
  );
  assert.deepEqual(rows.map((r) => [r.status, r.ok]), [["unreachable", false], ["unreachable", false]]);
  assert.match(rows[0].failures[0], /HTTP 503/);
  assert.match(rows[1].failures[0], /not valid JSON/);
});

test("a gzip body without a content-encoding header is decoded", async () => {
  const body = gzipSync(Buffer.from(JSON.stringify(pointer({ slug: "a" }))));
  const rows = await run([{ slug: "a", lifecycle: "active" }], { a: { status: 200, body } });
  assert.equal(rows[0].status, "ok");
});

test("summarize names every failing board on one short line", async () => {
  const rows = await run(
    [{ slug: "a", lifecycle: "active" }, { slug: "b", lifecycle: "active" }],
    { a: reply(200, pointer({ slug: "a", publishedAt: hoursAgo(60) })), b: reply(200, pointer({ slug: "b" })) },
  );
  const line = summarize(rows, "github-actions");
  assert.match(line, /^artifact freshness watchdog FAILED on github-actions: /);
  assert.match(line, /a:failed/);
  assert.doesNotMatch(line, /b:ok/);
  assert.ok(!line.includes("\n") && line.length <= 900);
});

test("notifySentry posts a valid event to the DSN's store endpoint, and reports failure", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const ok = await notifySentry({
    dsn: "https://abc123@o1.ingest.sentry.io/42",
    message: "hello \"world\"\tx",
    host: "github-actions",
    fetchImpl,
  });
  assert.equal(ok, true);
  assert.equal(calls[0].url, "https://o1.ingest.sentry.io/api/42/store/");
  assert.match(calls[0].init.headers["X-Sentry-Auth"], /sentry_key=abc123/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.level, "error");
  assert.equal(body.tags.job, "artifact-freshness");
  assert.equal(body.message, "hello \"world\"\tx");

  assert.equal(await notifySentry({ dsn: "", message: "m", host: "h", fetchImpl }), false);
  assert.equal(await notifySentry({ dsn: "not-a-dsn", message: "m", host: "h", fetchImpl }), false);
  assert.equal(
    await notifySentry({ dsn: "https://k@h.io/1", message: "m", host: "h", fetchImpl: async () => ({ ok: false, status: 400 }) }),
    false,
  );
  assert.equal(
    await notifySentry({ dsn: "https://k@h.io/1", message: "m", host: "h", fetchImpl: async () => { throw new Error("x"); } }),
    false,
  );
});

test("notifySentry can tag a self-test so it never matches the real alert rule", async () => {
  let body;
  await notifySentry({
    dsn: "https://k@h.io/1",
    message: "m",
    host: "h",
    job: "artifact-freshness-watchdog-selftest",
    level: "info",
    fetchImpl: async (_u, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(body.tags.job, "artifact-freshness-watchdog-selftest");
  assert.equal(body.level, "info");
});

test("summarize names EVERY failing board even when all of them fail (900-character cap)", async () => {
  const slugs = ["premier-league-2026-27", "brasileirao-serie-a-2026", "la-liga-2026-27", "serie-a-2026-27", "champions-league-2026-27", "bundesliga-2026-27"];
  const table = Object.fromEntries(slugs.map((slug) => [slug, reply(200, pointer({ slug, publishedAt: hoursAgo(60) }))]));
  const rows = await run(slugs.map((slug) => ({ slug, lifecycle: "active" })), table);
  const line = summarize(rows, "github-actions");
  for (const slug of slugs) assert.ok(line.includes(slug), `${slug} missing from: ${line}`);
  assert.ok(line.length <= 900 && !line.includes("\n"));
  assert.match(line, /STALE/);
});
