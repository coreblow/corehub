const defaultRunbook = "https://github.com/coreblow/corehub/blob/main/docs/audit-incident-response.md";

export function buildAuditAlertPayload(report, env = {}) {
  return {
    schemaVersion: "corehub.audit-alert.v1",
    alertType: "audit.fail_closed",
    status: "fail_closed",
    severity: "critical",
    registry: report.registry,
    generatedAt: report.generatedAt,
    summary: "CoreHub audit integrity verification failed. Stop retention pruning and escalate.",
    runbook: env.COREHUB_AUDIT_RUNBOOK_URL ?? defaultRunbook,
    incident: {
      head: report.verification?.head ?? "0".repeat(64),
      count: report.verification?.count ?? 0,
      errors: report.verification?.errors ?? [],
      retentionStatus: report.retention?.status ?? "unknown",
      recentAuditEventCount: report.recentAuditEvents?.length ?? 0,
    },
  };
}

export async function deliverAuditAlert(report, env = {}) {
  const webhook = env.COREHUB_AUDIT_ALERT_WEBHOOK;
  if (!webhook) return { delivered: false, destination: "none" };

  const destination = env.COREHUB_AUDIT_ALERT_DESTINATION ?? "webhook";
  const alert = buildAuditAlertPayload(report, env);
  const body = JSON.stringify(formatAlertForDestination(alert, destination, env));
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { delivered: true, destination };
}

export function formatAlertForDestination(alert, destination, env = {}) {
  if (destination === "slack") return formatSlackAlert(alert);
  if (destination === "teams") return formatTeamsAlert(alert);
  if (destination === "email") return formatEmailAlert(alert, env);
  return alert;
}

export function formatSlackAlert(alert) {
  return {
    text: `CoreHub audit ${alert.status}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*CoreHub audit ${alert.status}*\n${alert.summary}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Registry*\n${alert.registry}` },
          { type: "mrkdwn", text: `*Severity*\n${alert.severity}` },
          { type: "mrkdwn", text: `*Head*\n\`${alert.incident.head}\`` },
          { type: "mrkdwn", text: `*Errors*\n${alert.incident.errors.length}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open runbook" },
            url: alert.runbook,
          },
        ],
      },
    ],
  };
}

export function formatTeamsAlert(alert) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          version: "1.5",
          body: [
            { type: "TextBlock", weight: "Bolder", text: `CoreHub audit ${alert.status}` },
            { type: "TextBlock", text: alert.summary, wrap: true },
            { type: "FactSet", facts: alertFacts(alert) },
          ],
          actions: [{ type: "Action.OpenUrl", title: "Open runbook", url: alert.runbook }],
        },
      },
    ],
  };
}

export function formatEmailAlert(alert, env = {}) {
  return {
    to: env.COREHUB_AUDIT_ALERT_EMAIL_TO ?? "security@example.com",
    from: env.COREHUB_AUDIT_ALERT_EMAIL_FROM ?? "corehub@example.com",
    subject: env.COREHUB_AUDIT_ALERT_EMAIL_SUBJECT ?? `CoreHub audit ${alert.status}`,
    text: [
      alert.summary,
      "",
      `Registry: ${alert.registry}`,
      `Severity: ${alert.severity}`,
      `Head: ${alert.incident.head}`,
      `Errors: ${alert.incident.errors.join("; ") || "none"}`,
      `Runbook: ${alert.runbook}`,
    ].join("\n"),
    alert,
  };
}

function alertFacts(alert) {
  return [
    { title: "Registry", value: alert.registry },
    { title: "Severity", value: alert.severity },
    { title: "Head", value: alert.incident.head },
    { title: "Errors", value: String(alert.incident.errors.length) },
    { title: "Retention", value: alert.incident.retentionStatus },
  ];
}
