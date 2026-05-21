import { deliverAuditAlert, formatAuditAlertDeliveryMetricsJsonl } from "./audit-alert-adapters.mjs";

const defaultRegistry = "https://coreblow.com/corehub";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runAuditIncidentCheck(env, { throwOnFail: true, logAlertMetrics: true }));
  },

  async fetch(_request, env) {
    const report = await runAuditIncidentCheck(env);
    return Response.json(report, { status: report.status === "fail_closed" ? 503 : 200 });
  },
};

export async function runAuditIncidentCheck(env = {}, options = {}) {
  const registry = normalizeRegistry(env.COREHUB_REGISTRY ?? defaultRegistry);
  const headers = {
    Accept: "application/json",
    "User-Agent": "corehub-audit-worker",
    ...(env.COREHUB_TOKEN ? { Authorization: `Bearer ${env.COREHUB_TOKEN}` } : {}),
    ...(env.COREHUB_USER ? { "x-corehub-user": env.COREHUB_USER } : {}),
  };
  const [verification, retention, recent] = await Promise.all([
    readV2Data(`${registry}/api/v2/audit/verify`, headers),
    readV2Data(`${registry}/api/v2/audit/retention`, headers),
    readV2Envelope(`${registry}/api/v2/audit/events?limit=${encodeURIComponent(env.COREHUB_AUDIT_INCIDENT_LIMIT ?? "50")}`, headers),
  ]);
  const failClosed = verification.valid === false || verification.behavior === "fail_closed";
  const report = {
    status: failClosed ? "fail_closed" : "ok",
    severity: failClosed ? "critical" : "informational",
    registry,
    generatedAt: new Date().toISOString(),
    verification,
    retention,
    recentAuditEvents: recent.data,
    recentAuditMeta: recent.meta,
  };
  if (failClosed) report.alertDelivery = await deliverAuditAlert(report, env);
  if (options.logAlertMetrics && report.alertDelivery?.metrics?.length) {
    console.log(formatAuditAlertDeliveryMetricsJsonl(report.alertDelivery.metrics));
  }
  if (report.alertDelivery?.deadLetter) {
    console.error(JSON.stringify(report.alertDelivery.deadLetter));
  }
  if (failClosed && options.throwOnFail) {
    throw new Error(`CoreHub audit incident fail_closed: ${verification.errors?.join("; ") || "unknown error"}`);
  }
  return report;
}

async function readV2Data(url, headers) {
  return (await readV2Envelope(url, headers)).data;
}

async function readV2Envelope(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`CoreHub audit request failed: ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (!payload || payload.apiVersion !== "v2" || !("data" in payload)) {
    throw new Error("CoreHub audit request returned an invalid v2 response");
  }
  return { data: payload.data, meta: payload.meta ?? {} };
}

function normalizeRegistry(value) {
  const text = String(value ?? "").replace(/\/$/, "");
  return text.endsWith("/corehub") ? text : `${text}/corehub`;
}
