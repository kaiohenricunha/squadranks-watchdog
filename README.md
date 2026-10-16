# squadranks-watchdog

A temporary, external freshness watchdog for the SquadRanks live data artifacts.

SquadRanks checks once a day that every competition's live pointer
(`https://data.squadranks.com/manifests/<slug>/current.json`) was published in the last 48
hours. That check normally runs as a workflow in the private SquadRanks repository. While
that repository's GitHub Actions billing is blocked (the October 2026 quota is used up and
resets on 2026-11-01), the workflow cannot start, so a stale board would go unnoticed.
This repository is public, so its hosted runs use no private-repo quota.

## What it does

`watchdog.mjs` reads each listed pointer over the public CDN and fails when a pointer is
unreachable, malformed, published in the future, or older than 48 hours. A `finished`
competition is not aged. On a failure it exits 1 (the run turns red and GitHub emails the
owner) and posts one event to Sentry, tagged `job: artifact-freshness`, that names every
failing board. The rules mirror SquadRanks' `scripts/check-prod-artifacts.mjs`.

It checks freshness and shape only. It does not verify payload checksums.

## Plug it in

1. Add the repository secret `SENTRY_DSN` (the same DSN the SquadRanks cron uses).
2. Run the workflow by hand with **selftest** ticked: it must post one info event to Sentry.
3. Run it again with selftest off: it must pass and print one line per competition.

The schedule then runs it daily at 07:30 UTC.

## Change what it watches

Edit the `WATCH` list in `.github/workflows/watchdog.yml` (`slug:lifecycle`, one per
line). A competition that is missing from the list is not checked.

## Plug it out

Delete this repository, or disable the **Artifact freshness watchdog** workflow. Nothing in
the SquadRanks repository depends on it. Do this when SquadRanks' own workflow runs again
(after 2026-11-01), so two checks do not alert twice.

## Limits

- It cannot tell you that it stopped running. GitHub pauses scheduled workflows in a public
  repository after 60 days without activity, which does not matter for a 16-day stand-in.
- The list of competitions is copied, so it can drift from SquadRanks' registry.

## Develop

```bash
node --test
WATCH="premier-league-2026-27:active" node watchdog.mjs
```
