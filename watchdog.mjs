// Temporary external watchdog for the SquadRanks live data artifacts.
//
// It reads each competition's live pointer (<base>/manifests/<slug>/current.json)
// over the public CDN, fails when the pointer is unreachable, malformed or older
// than 48 hours, and posts a failing verdict to Sentry. The rules mirror the
// SquadRanks sensor (scripts/check-prod-artifacts.mjs, spec data-artifact-
// publishing REL-3): 48h limit, a `finished` competition is not aged, one
// board's problem never hides another's, a future publishedAt is corrupt, and an
// unknown lifecycle fails closed. It does NOT verify payload checksums.
//
// No dependencies: Node 20+ and a public CDN. Run: `node watchdog.mjs`.
// Environment: WATCH (slug[:lifecycle] list), BASE_URL, MAX_AGE_HOURS,
// SENTRY_DSN (optional), HOST (name in the alert), SELFTEST=1.

import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "https://data.squadranks.com";
export const DEFAULT_MAX_AGE_HOURS = 48;
export const FUTURE_SKEW_SLACK_HOURS = 1;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_RE = /^[A-Za-z0-9._-]+$/;

/** `slug` or `slug:lifecycle`, separated by whitespace or commas. */
export function parseTargets(text) {
  const tokens = String(text ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length === 0) throw new Error("WATCH lists no competitions");
  return tokens.map((token) => {
    const [slug, lifecycle] = token.split(":");
    if (!SLUG_RE.test(slug)) {
      throw new Error(`WATCH slug must be lowercase kebab-case, got ${JSON.stringify(slug)}`);
    }
    return { slug, lifecycle: lifecycle || null };
  });
}

export function pointerAgeHours(publishedAt, now = Date.now()) {
  if (typeof publishedAt !== "string") return null;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return null;
  return (now - t) / 3_600_000;
}

/** Returns `{ failures, warnings }` for one parsed pointer document. */
export function assessPointer(
  pointer,
  { slug, lifecycle = null, maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = Date.now() } = {},
) {
  const failures = [];
  const warnings = [];
  if (pointer === null || typeof pointer !== "object" || Array.isArray(pointer)) {
    return { failures: ["pointer is not a JSON object"], warnings };
  }

  if (pointer.schemaVersion !== "v1") {
    failures.push(`pointer schemaVersion is ${JSON.stringify(pointer.schemaVersion)} (expected v1)`);
  }
  if (typeof pointer.version !== "string" || pointer.version === "") {
    failures.push("pointer has no version");
  } else if (!VERSION_RE.test(pointer.version)) {
    failures.push(`pointer version ${JSON.stringify(pointer.version)} is not a valid version key`);
  }
  if (slug && pointer.slug !== undefined && pointer.slug !== slug) {
    failures.push(`pointer slug is ${JSON.stringify(pointer.slug)} but ${slug} was requested`);
  }

  const age = pointerAgeHours(pointer.publishedAt, now);
  if (age === null) {
    failures.push(
      `pointer publishedAt is missing or unparseable: ${JSON.stringify(pointer.publishedAt)}`,
    );
  } else if (age < -FUTURE_SKEW_SLACK_HOURS) {
    failures.push(
      `pointer publishedAt is ${(-age).toFixed(1)}h in the FUTURE (${pointer.publishedAt}): ` +
        `a skewed timestamp would make the freshness check pass forever`,
    );
  } else if (lifecycle === "finished") {
    warnings.push(
      `competition is finished: its board is frozen, so the pointer's age (${age.toFixed(1)}h) is not checked`,
    );
  } else if (age > maxAgeHours) {
    failures.push(
      `pointer is STALE: published ${age.toFixed(1)}h ago, over the ${maxAgeHours}h limit: ` +
        `the SquadRanks publishing cron may have stopped`,
    );
  }
  return { failures, warnings };
}

async function defaultFetch(url) {
  const res = await fetch(url, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

function decode(body) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  // The CDN may serve gzip without a Content-Encoding header.
  const bytes = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return bytes.toString("utf-8");
}

/** Check every target in turn; a throw for one becomes that target's row. */
export async function checkTargets({
  baseUrl = DEFAULT_BASE_URL,
  targets,
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  fetchImpl = defaultFetch,
  now = Date.now(),
}) {
  const rows = [];
  for (const { slug, lifecycle } of targets) {
    const currentUrl = `${baseUrl}/manifests/${slug}/current.json`;
    const row = {
      slug,
      lifecycle,
      ok: false,
      status: "unreachable",
      currentUrl,
      version: null,
      publishedAt: null,
      ageHours: null,
      warnings: [],
      failures: [],
    };
    rows.push(row);
    try {
      const res = await fetchImpl(currentUrl);
      if (res.status === 404) {
        row.status = "never-flipped";
        const note = `no live pointer at ${currentUrl} (HTTP 404): nothing has been flipped for this competition`;
        if (lifecycle === "upcoming") {
          row.ok = true;
          row.warnings.push(note);
        } else {
          row.failures.push(note);
        }
        continue;
      }
      if (res.status !== 200) {
        row.failures.push(`live pointer request failed: HTTP ${res.status} at ${currentUrl}`);
        continue;
      }
      let pointer;
      try {
        pointer = JSON.parse(decode(res.body));
      } catch (err) {
        row.failures.push(`live pointer at ${currentUrl} is not valid JSON: ${err.message}`);
        continue;
      }
      const { failures, warnings } = assessPointer(pointer, { slug, lifecycle, maxAgeHours, now });
      const age = pointerAgeHours(pointer?.publishedAt, now);
      row.version = pointer?.version ?? null;
      row.publishedAt = pointer?.publishedAt ?? null;
      row.ageHours = age === null ? null : Number(age.toFixed(2));
      row.warnings = warnings;
      row.failures = failures;
      row.ok = failures.length === 0;
      row.status = row.ok ? "ok" : "failed";
    } catch (err) {
      row.failures.push(`could not read ${currentUrl}: ${err.message}`);
    }
  }
  return rows;
}

const flatten = (text) => String(text).replace(/[\n\r]+/g, " ").replace(/ +/g, " ").slice(0, 900);

const SUMMARY_LIMIT = 900;

/**
 * One line naming every failing board. The names and ages always fit; each
 * board's first failure is appended while the 900-character cap leaves room, so
 * six stale boards are never reported as one.
 */
export function summarize(rows, host) {
  const bad = rows.filter((r) => !r.ok);
  const head = `artifact freshness watchdog FAILED on ${host}: `;
  const names = bad.map((r) => `${r.slug}:${r.status} ageHours=${r.ageHours}`).join(" | ");
  let line = flatten(head + names);
  const room = () => SUMMARY_LIMIT - line.length;
  const detail = bad.map((r) => `${r.slug}: ${flatten(r.failures[0] ?? "")}`);
  // Share what is left evenly, so no board's reason is dropped to fit another's.
  if (room() > 40) {
    const each = Math.floor((room() - 3) / bad.length) - 3;
    if (each >= 20) {
      line += " | " + detail.map((d) => (d.length > each ? d.slice(0, each - 1) + "…" : d)).join(" ; ");
    }
  }
  return line.slice(0, SUMMARY_LIMIT);
}

/** Post one event to Sentry's store endpoint. Returns true on a 2xx. */
export async function notifySentry({
  dsn,
  message,
  host,
  job = "artifact-freshness",
  level = "error",
  fetchImpl = fetch,
}) {
  if (!dsn) return false;
  // DSN shape: https://<public_key>@<host>/<project_id>
  const match = /^https:\/\/([^@/]+)@([^/]+)\/(\d+)$/.exec(dsn);
  if (!match) return false;
  const [, key, sentryHost, project] = match;
  try {
    const res = await fetchImpl(`https://${sentryHost}/api/${project}/store/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=squadranks-watchdog/1.0, sentry_key=${key}`,
      },
      body: JSON.stringify({
        message,
        level,
        platform: "other",
        server_name: host,
        tags: { job, source: "external-watchdog" },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok === true;
  } catch {
    return false;
  }
}

async function main(env = process.env) {
  const host = env.HOST || "github-actions-watchdog";
  const dsn = env.SENTRY_DSN || "";

  if (env.SELFTEST === "1") {
    const sent = await notifySentry({
      dsn,
      host,
      job: "artifact-freshness-watchdog-selftest",
      level: "info",
      message: "SquadRanks watchdog self-test: the alert path works. No action needed.",
    });
    console.log(sent ? "self-test: Sentry alert sent" : "self-test: Sentry alert FAILED to send");
    return sent ? 0 : 1;
  }

  const targets = parseTargets(env.WATCH);
  const maxAgeHours = env.MAX_AGE_HOURS ? Number(env.MAX_AGE_HOURS) : DEFAULT_MAX_AGE_HOURS;
  if (!(maxAgeHours > 0)) throw new Error(`MAX_AGE_HOURS must be positive, got ${env.MAX_AGE_HOURS}`);

  const rows = await checkTargets({
    baseUrl: env.BASE_URL || DEFAULT_BASE_URL,
    targets,
    maxAgeHours,
  });
  for (const r of rows) {
    console.log(
      `${r.ok ? "ok    " : "FAILED"} ${r.slug} ${r.status} ageHours=${r.ageHours} version=${r.version}`,
    );
    for (const w of r.warnings) console.log(`  warning: ${w}`);
    for (const f of r.failures) console.log(`::error title=${r.slug}::${f}`);
  }
  if (rows.every((r) => r.ok)) {
    console.log("every watched competition's live pointer is fresh");
    return 0;
  }
  const message = summarize(rows, host);
  console.log(message);
  const sent = await notifySentry({ dsn, host, message });
  console.log(sent ? "Sentry alert sent" : dsn ? "Sentry alert FAILED to send" : "SENTRY_DSN unset; skipping Sentry alert");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(2);
    },
  );
}
