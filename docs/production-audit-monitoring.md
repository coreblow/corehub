# CoreHub Production Audit Monitoring

This runbook wires the audit incident check into production operators, scheduled runners, or Cloudflare Workers.

## Production Contract

CoreHub production monitoring should run the incident check on a fixed schedule and fail closed when audit integrity is invalid.

Required behavior:

| Requirement | Contract |
| --- | --- |
| Registry URL | `COREHUB_REGISTRY=https://coreblow.com/corehub` |
| Auth | Use `COREHUB_TOKEN` when API v2 audit endpoints require bearer auth. |
| Report artifact | Preserve the generated incident report for review. |
| Failure behavior | Non-zero exit or Worker failure when status is `fail_closed`. |
| Alerting | Route the failure to the operator or security owner. |

## Alert Payload Contract

Every `fail_closed` alert uses `schemas/corehub.audit-alert.schema.json`.

Example payload:

```json
{
  "schemaVersion": "corehub.audit-alert.v1",
  "alertType": "audit.fail_closed",
  "status": "fail_closed",
  "severity": "critical",
  "registry": "https://coreblow.com/corehub",
  "generatedAt": "2026-05-21T18:45:00.000Z",
  "summary": "CoreHub audit integrity verification failed. Stop retention pruning and escalate.",
  "runbook": "https://github.com/coreblow/corehub/blob/main/docs/audit-incident-response.md",
  "incident": {
    "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "count": 1,
    "errors": ["audit-000001-fixture.eventHash expected aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    "retentionStatus": "blocked",
    "recentAuditEventCount": 1
  }
}
```

Validate the fixture:

```sh
npm run validate:alert-schema
```

## Node Cron Runner

Use the checked-in environment template:

```sh
cp ops/audit-incident.production.env.example .env.audit-incident
```

Install a cron entry based on:

```sh
cat ops/cron/corehub-audit-incident.cron
```

The job runs:

```sh
COREHUB_REGISTRY=https://coreblow.com/corehub npm run audit:incident
```

The default report path is `.corehub-audit/corehub-audit-incident.md`, which is ignored by git.

Set `COREHUB_AUDIT_ALERT_WEBHOOK` to send alerts from the Node runner when the report is `fail_closed`.

## GitHub Actions Runner

Use `ops/github-actions/audit-incident-check.yml` as the workflow template. It is intentionally stored under `ops/` so operators can review it before copying into `.github/workflows/`.

Required secret:

| Secret | Purpose |
| --- | --- |
| `COREHUB_AUDIT_TOKEN` | Bearer token for audit API reads when production auth is enabled. |
| `COREHUB_AUDIT_ALERT_WEBHOOK` | Slack, Teams, email gateway, or generic webhook endpoint for `fail_closed` alerts. |

The workflow uploads `corehub-audit-incident.md` as an artifact and fails automatically when the CLI returns `fail_closed`.

## Alert Destinations

Use `COREHUB_AUDIT_ALERT_DESTINATION` to choose the outbound payload format:

| Destination | Payload |
| --- | --- |
| `webhook` | Raw `corehub.audit-alert.v1` JSON payload. |
| `slack` | Slack Incoming Webhook message with blocks. |
| `teams` | Microsoft Teams adaptive-card message. |
| `email` | Generic email-provider JSON with `to`, `from`, `subject`, `text`, and raw alert. |

Email adapter variables:

| Variable | Purpose |
| --- | --- |
| `COREHUB_AUDIT_ALERT_EMAIL_TO` | Recipient address for the email gateway payload. |
| `COREHUB_AUDIT_ALERT_EMAIL_FROM` | Sender address for the email gateway payload. |
| `COREHUB_AUDIT_ALERT_EMAIL_SUBJECT` | Subject override. |

Alert delivery reliability variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COREHUB_AUDIT_ALERT_RETRIES` | `2` | Retry count after the first failed delivery attempt. |
| `COREHUB_AUDIT_ALERT_RETRY_DELAY_MS` | `250` | Delay between delivery attempts. |
| `COREHUB_AUDIT_ALERT_TIMEOUT_MS` | `5000` | Per-attempt request timeout. |
| `COREHUB_AUDIT_ALERT_DEAD_LETTER_PATH` | unset | Node runner path for the dead-letter JSON when delivery still fails after retries. |
| `COREHUB_AUDIT_ALERT_METRICS_PATH` | unset | Node runner path for alert delivery JSONL metrics. |

The Cloudflare Worker implementation lives in `ops/cloudflare/audit-alert-adapters.mjs`. It is intentionally provider-light: Slack and Teams use their webhook JSON formats, while email is shaped for a generic mail gateway such as a transactional email Worker, Queue consumer, or provider webhook.

When delivery fails after all retries, CoreHub does not hide the audit incident. The delivery result becomes `delivered: false` with a `corehub.audit-alert-dead-letter.v1` object containing the destination, webhook host, errors, timestamp, and original alert payload. The Node runner logs this object and can persist it with `COREHUB_AUDIT_ALERT_DEAD_LETTER_PATH`; the Worker includes it in the returned report for fetch-based checks and scheduled-run logs.

The incident report includes `alertDelivery` so operators can inspect delivery state without reading raw logs:

| Field | Meaning |
| --- | --- |
| `alertDelivery.status` | `not_configured`, `delivered`, or `dead_letter`. |
| `alertDelivery.destination` | `none`, `webhook`, `slack`, `teams`, or `email`. |
| `alertDelivery.attempts` | Number of outbound delivery attempts. |
| `alertDelivery.delivered` | Whether the alert endpoint accepted the payload. |
| `alertDelivery.deadLetter` | Present when delivery failed after retries. |

Each delivery attempt also emits a JSONL metric using `corehub.audit-alert-delivery-metric.v1`. The Node runner writes these lines to stderr and optionally to `COREHUB_AUDIT_ALERT_METRICS_PATH`; the Worker writes the same JSONL lines to scheduled-run logs.

Metric fields:

| Field | Meaning |
| --- | --- |
| `eventType` | `alert.delivery.attempt` or `alert.delivery.final`. |
| `status` | `delivered`, `retry`, `failed`, `dead_letter`, or `not_configured`. |
| `attempt` | Attempt number for attempt events. |
| `maxAttempts` | Maximum delivery attempts for attempt events. |
| `attempts` | Final number of attempts for final events. |
| `httpStatus` | HTTP status returned by the destination when available. |
| `durationMs` | Per-attempt delivery duration. |
| `error` | Delivery error text when available. |

Summarize a JSONL artifact:

```sh
npm run corehub -- audit alert-metrics summarize ./corehub-audit-alert-delivery-metrics.jsonl
```

Export a Markdown summary:

```sh
npm run corehub -- audit alert-metrics summarize ./corehub-audit-alert-delivery-metrics.jsonl --format markdown --output ./corehub-audit-alert-delivery-summary.md
```

The summary reports parsed metric count, ignored non-metric lines, destination counts, final delivered/dead-letter rates, retry rate, and failed attempt rate.

## Cloudflare Scheduled Worker

Use the Worker template:

```sh
cp ops/cloudflare/wrangler.audit-incident.example.toml wrangler.audit-incident.toml
wrangler secret put COREHUB_TOKEN --config wrangler.audit-incident.toml
wrangler secret put COREHUB_AUDIT_ALERT_WEBHOOK --config wrangler.audit-incident.toml
wrangler deploy --config wrangler.audit-incident.toml
```

The Worker runs every 30 minutes by default. It checks:

| Endpoint | Purpose |
| --- | --- |
| `/corehub/api/v2/audit/verify` | Hash-chain integrity and fail-closed behavior. |
| `/corehub/api/v2/audit/retention` | Retention policy and prune eligibility. |
| `/corehub/api/v2/audit/events` | Recent audit context for the report. |

When the report status is `fail_closed`, the scheduled handler posts the formatted alert to `COREHUB_AUDIT_ALERT_WEBHOOK` when configured and throws so the scheduled run is marked failed. Alert delivery is retried before the run fails; if delivery still fails, the report includes the dead-letter object for operator follow-up.

## Production Rollout Checklist

1. Confirm API v2 audit endpoints are reachable from the scheduled environment.
2. Configure `COREHUB_TOKEN` if audit endpoints require auth.
3. Run one manual check and preserve the report.
4. Enable the 30-minute schedule.
5. Verify one successful scheduled run.
6. Document the alert destination and owner.

## Related Docs

- `docs/audit-incident-response.md`
- `docs/audit-runbook.md`
- `docs/local-publish-runbook.md`
