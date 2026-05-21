# CoreHub Audit Incident Response

This runbook describes what an operator should do when CoreHub audit integrity verification reports `fail_closed`.

## First Check

Generate an incident report:

```sh
npm run corehub -- audit incident report --registry http://127.0.0.1:8787/corehub
```

Export a Markdown report for handoff:

```sh
npm run corehub -- audit incident report --format markdown --output ./corehub-audit-incident.md --registry http://127.0.0.1:8787/corehub
```

The report includes:

| Field | Meaning |
| --- | --- |
| `status` | `ok` or `fail_closed`. |
| `severity` | `informational` for a valid chain, `critical` for an invalid chain. |
| `verification` | Hash-chain verification result, head hash, checkpoint, and errors. |
| `retention` | Current retention policy and prune eligibility. |
| `recentAuditEvents` | Recent audit events for operator context. |
| `operatorActions` | Immediate next steps for the incident state. |

## Fail Closed Procedure

When `status` is `fail_closed`:

1. Stop audit retention pruning.
2. Export current audit events.
3. Preserve the local state file, storage metadata, deployment version, CI run, and operator report.
4. Escalate to the CoreHub operator or security owner.
5. Resume retention only after the audit chain is manually reviewed and repaired or archived.

## Clean Chain Procedure

When `status` is `ok`, the report can be stored as evidence that the audit chain was valid at the time of inspection. Retention pruning still requires export-before-prune:

```sh
npm run corehub -- audit retention --prune --output ./corehub-audit-retention.audit.jsonl --registry http://127.0.0.1:8787/corehub
```

## Automation Hook

Use the repository script for cron or CI jobs:

```sh
COREHUB_REGISTRY=https://coreblow.com/corehub npm run audit:incident
```

Equivalent explicit form:

```sh
npm run audit:incident -- --registry https://coreblow.com/corehub --output ./corehub-audit-incident.md --limit 50
```

Defaults:

| Setting | Default |
| --- | --- |
| `COREHUB_REGISTRY` | Required when `--registry` is omitted. |
| `COREHUB_AUDIT_INCIDENT_REPORT` | `.corehub-audit/corehub-audit-incident.md` |
| `COREHUB_AUDIT_INCIDENT_FORMAT` | `markdown` |
| `COREHUB_AUDIT_INCIDENT_LIMIT` | `50` |

Example cron entry:

```cron
*/30 * * * * cd /srv/corehub && COREHUB_REGISTRY=https://coreblow.com/corehub npm run audit:incident >> /var/log/corehub-audit-incident.log 2>&1
```

Example GitHub Actions step:

```yaml
- name: CoreHub audit incident check
  run: npm run audit:incident -- --registry https://coreblow.com/corehub --output ./corehub-audit-incident.md
```

The script writes the incident report and exits non-zero when the report status is `fail_closed`.

For production deployment templates, see `docs/production-audit-monitoring.md`.

The production alert payload is validated by `schemas/corehub.audit-alert.schema.json` and can be delivered as raw webhook JSON, Slack blocks, Teams adaptive cards, or a generic email-provider payload.

## Enterprise Notes

CoreHub treats audit integrity failures as operational incidents, not routine warnings. The CLI exits non-zero for `fail_closed` so automation can halt retention jobs and alert operators.
