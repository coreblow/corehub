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

## Enterprise Notes

CoreHub treats audit integrity failures as operational incidents, not routine warnings. The CLI exits non-zero for `fail_closed` so automation can halt retention jobs and alert operators.
