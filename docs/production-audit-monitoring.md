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

## GitHub Actions Runner

Use `ops/github-actions/audit-incident-check.yml` as the workflow template. It is intentionally stored under `ops/` so operators can review it before copying into `.github/workflows/`.

Required secret:

| Secret | Purpose |
| --- | --- |
| `COREHUB_AUDIT_TOKEN` | Bearer token for audit API reads when production auth is enabled. |

The workflow uploads `corehub-audit-incident.md` as an artifact and fails automatically when the CLI returns `fail_closed`.

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

When the report status is `fail_closed`, the scheduled handler posts the report to `COREHUB_AUDIT_ALERT_WEBHOOK` when configured and throws so the scheduled run is marked failed.

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
