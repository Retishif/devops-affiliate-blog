---
title: How Much Does Datadog Really Cost at Scale?
description: A worked cost model for a 200-host platform, the hidden charges that inflate Datadog bills, and when a self-hosted alternative actually saves money.
---

# How Much Does Datadog Really Cost at Scale?

Datadog's pricing page starts at $15 per host per month. Almost no real bill looks like that number. This guide walks through a realistic scenario, shows where the money goes, and explains when moving to a self-hosted stack makes sense, and when it doesn't.

::: info Illustrative scenario
The platform below is a composite built from common patterns, not a specific customer. List prices were checked against public sources in November 2026 and change often. Always verify against [datadoghq.com/pricing](https://www.datadoghq.com/pricing/) before making decisions.
:::

## The scenario

A SaaS company running on Kubernetes:

- 200 hosts monitored
- 80 of them run traced services (APM)
- About 3 TB of logs ingested per month
- About 500 million log events indexed per month (15-day retention)

## The list-price bill

| Line item | Calculation | Monthly cost |
|---|---|---|
| Infrastructure Pro | 200 hosts x $15 | $3,000 |
| APM | 80 hosts x $31 | $2,480 |
| Log ingestion | 3,000 GB x $0.10 | $300 |
| Log indexing | 500M events x $1.70 per million | $850 |
| **Subtotal** | | **$6,630** |

That is about **$79,600 per year** before the items below.

## What the list price leaves out

1. **APM is not standalone on the Infrastructure model.** Every APM host also pays the Infrastructure rate, so a traced host costs about $46, not $31.
2. **Billing is based on a high-water mark, not an average.** A short autoscaling spike can set your bill for the month.
3. **Containers and custom metrics have allotments.** Ephemeral pods and high-cardinality tags are a frequent source of unexpected overages.
4. **Logs are charged twice.** You pay to ingest every log, then again to index the ones you want to search.
5. **Monthly billing costs more than annual.** Annual commitments get the lower list prices, and usage above a commitment is billed at a premium.
6. **Everything else is a separate meter.** Synthetics, RUM, database monitoring, security, and CI visibility each add their own line.

For many teams, these extras add a meaningful percentage on top of the subtotal above. Your own invoice is the only reliable source.

## Where teams usually overspend

- **Indexing logs nobody searches.** Health checks and debug noise are indexed at full price.
- **Tracing every host by default.** Some services don't need full APM.
- **Tags with unbounded values** (user IDs, request IDs) that multiply custom metrics.
- **Test and staging environments** monitored at production rates.
- **No usage alerts**, so growth is only noticed on the invoice.

Fixing these inside Datadog is often the cheapest first step, and it doesn't require a migration.

## The self-hosted alternative

A common replacement is Grafana for dashboards, Loki for logs, and Prometheus for metrics (often with Tempo for traces). Costs shift from a vendor invoice to three places:

| Cost | What to estimate |
|---|---|
| Compute | Nodes for Prometheus, Loki, Grafana (plus HA if needed) |
| Storage | Object storage for logs and long-term metrics, which is usually cheap |
| Engineering time | Setup, upgrades, tuning, on-call, capacity planning |

The infrastructure bill is typically a fraction of the Datadog invoice. The engineering time is the part people underestimate. A rough planning assumption is several hours per month in steady state, with a much larger one-time effort to migrate dashboards, alerts, and instrumentation.

For the full setup, see my [Grafana, Loki, and Prometheus guide](/datadog-alternative-grafana-loki-prometheus).

## When self-hosting is a bad idea

- You have no one who wants to own the stack, or no on-call capacity.
- Your bill is small enough that engineer time costs more than the savings.
- You depend heavily on Datadog features you cannot easily replace (for example, some security or RUM products).
- You are mid-contract with a large commitment.

A middle path is also common: keep Datadog for APM and a few critical pieces, and move the high-volume, low-value data (usually logs) elsewhere.

## A simple way to estimate your own savings

1. Export the last three months of Datadog usage by product.
2. Find your top three cost lines. These are usually logs, APM, and infrastructure hosts.
3. For each, ask: could this data be reduced, sampled, moved, or dropped?
4. Estimate the self-hosted infrastructure cost for the data you would move.
5. Add engineering hours at your real internal rate.
6. Compare the total against the current bill, and be honest about migration effort.

## Bottom line

Start by trimming what you already pay for: logs nobody searches, tracing you don't need, and tags with unbounded values. Migrate only when the measured savings clearly beat the engineering time it takes to run the replacement.

*This article is for general information. Prices and plans change, so verify against current vendor documentation before making decisions.*
