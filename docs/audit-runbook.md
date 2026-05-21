# CoreHub Audit Runbook

This runbook shows how an operator can export write-side audit evidence from a CoreHub registry.

## Review Approval Evidence

Export every approval event for review targets:

```sh
npm run corehub -- audit list --action review.approve --target-type review --format jsonl --output ./corehub-review-approvals.audit.jsonl --registry http://127.0.0.1:8787/corehub
```

Filter the same approval trail to one operator:

```sh
npm run corehub -- audit list --action review.approve --actor github:coreblow-admin --target-type review --format jsonl --output ./corehub-review-approvals-by-admin.audit.jsonl --registry http://127.0.0.1:8787/corehub
```

Inspect every event for a single review id:

```sh
npm run corehub -- audit list --target review-plugin-lab-0-1-0 --limit 20 --registry http://127.0.0.1:8787/corehub
```

Verify the audit hash chain:

```sh
npm run corehub -- audit verify --registry http://127.0.0.1:8787/corehub
```

Check the retention policy and prune plan:

```sh
npm run corehub -- audit retention --dry-run --registry http://127.0.0.1:8787/corehub
```

Export before pruning retained audit evidence:

```sh
npm run corehub -- audit retention --prune --output ./corehub-audit-retention.audit.jsonl --registry http://127.0.0.1:8787/corehub
```

If `corehub audit verify` returns `valid: false`, CoreHub reports `behavior: fail_closed`. Operators should stop pruning, export the current state file, and escalate before trusting write-side evidence.

## Artifact Verification Evidence

Export upload and verification events for an artifact upload:

```sh
npm run corehub -- audit list --target artifact-plugin-lab-0-1-0 --format jsonl --output ./corehub-artifact-plugin-lab.audit.jsonl --registry http://127.0.0.1:8787/corehub
```

## Expected Fields

Each audit event contains:

| Field | Meaning |
| --- | --- |
| `id` | Stable event id within the registry state file. |
| `actor` | User, publisher, moderator, or system actor. |
| `action` | Operation such as `artifact.upload.verify` or `review.approve`. |
| `targetType` | Target category, such as `review`, `submission`, or `artifactUpload`. |
| `targetId` | Target record id. |
| `metadata` | Action-specific context for investigation. |
| `createdAt` | Event timestamp. |
| `previousHash` | Previous event hash, or 64 zeroes for the first event. |
| `eventHash` | SHA-256 hash over the canonical event payload. |

Retention pruning uses checkpoint records. A checkpoint stores the pruned prefix head hash and the operator-held export hash, allowing the remaining audit chain to continue validating after old events are archived.
