const defaultRunbook = "https://github.com/coreblow/corehub/blob/main/docs/audit-incident-response.md";
const defaultRetries = 2;
const defaultRetryDelayMs = 250;
const defaultTimeoutMs = 5000;

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
  const outboundPayload = formatAlertForDestination(alert, destination, env);
  const body = JSON.stringify(outboundPayload);
  const retryConfig = readRetryConfig(env);
  const errors = [];

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    try {
      const response = await postWithTimeout(webhook, body, retryConfig.timeoutMs);
      if (response.ok) {
        return { delivered: true, destination, attempts: attempt };
      }
      errors.push(`attempt ${attempt}: HTTP ${response.status} ${response.statusText}`.trim());
    } catch (error) {
      errors.push(`attempt ${attempt}: ${formatError(error)}`);
    }

    if (attempt < retryConfig.maxAttempts) await sleep(retryConfig.retryDelayMs);
  }

  return {
    delivered: false,
    destination,
    attempts: retryConfig.maxAttempts,
    deadLetter: buildAuditAlertDeadLetter(alert, destination, webhook, errors),
  };
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

export function buildAuditAlertDeadLetter(alert, destination, webhook, errors) {
  return {
    schemaVersion: "corehub.audit-alert-dead-letter.v1",
    destination,
    webhookHost: safeWebhookHost(webhook),
    failedAt: new Date().toISOString(),
    errors,
    retryable: true,
    alert,
  };
}

async function postWithTimeout(webhook, body, timeoutMs) {
  if (!timeoutMs) {
    return fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function readRetryConfig(env) {
  const retries = readNonNegativeInteger(env.COREHUB_AUDIT_ALERT_RETRIES, defaultRetries);
  return {
    maxAttempts: retries + 1,
    retryDelayMs: readNonNegativeInteger(env.COREHUB_AUDIT_ALERT_RETRY_DELAY_MS, defaultRetryDelayMs),
    timeoutMs: readNonNegativeInteger(env.COREHUB_AUDIT_ALERT_TIMEOUT_MS, defaultTimeoutMs),
  };
}

function readNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatError(error) {
  if (error?.name === "AbortError") return "request timed out";
  return error instanceof Error ? error.message : String(error);
}

function safeWebhookHost(webhook) {
  try {
    return new URL(webhook).host;
  } catch {
    return "invalid-webhook-url";
  }
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
