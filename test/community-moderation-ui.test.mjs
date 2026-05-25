import assert from "node:assert/strict";
import { jsonHeaders, seedHostedSkill, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const server = await startCoreHubTestServer();
try {
  await seedHostedSkill(server.storage, { slug: "community-ui-skill" });
  const comment = await fetch(`${server.v2Url}/community/comments`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      targetType: "skill",
      targetId: "community-ui-skill",
      body: "Community moderation UI fixture.",
    }),
  });
  assert.equal(comment.status, 201);
  const commentPayload = await comment.json();
  const commentId = commentPayload.data.comment.id;

  for (const actor of ["github:reporter-one", "github:reporter-two", "github:reporter-three", "github:reporter-four"]) {
    const report = await fetch(`${server.v2Url}/community/comments/${encodeURIComponent(commentId)}/report`, {
      method: "POST",
      headers: {
        ...jsonHeaders,
        "x-corehub-user": actor,
      },
      body: JSON.stringify({ reason: `Community moderation report from ${actor}.` }),
    });
    assert.equal(report.status, 200);
  }

  const queue = await fetch(`${server.v2Url}/community/comment-reports?status=open`, { headers: jsonHeaders });
  assert.equal(queue.status, 200);
  const queuePayload = await queue.json();
  assert.equal(queuePayload.data.length, 4);
  assert.equal(queuePayload.data[0].comment.status, "hidden");
  assert.equal(queuePayload.data[0].targetStats.comments, 0);

  const signals = await fetch(`${server.v2Url}/community/signals`, { headers: jsonHeaders });
  assert.equal(signals.status, 200);
  const signalsPayload = await signals.json();
  assert.equal(signalsPayload.data.counts.hiddenComments, 1);
  assert.equal(signalsPayload.data.counts.openCommentReports, 4);
  assert.equal(signalsPayload.data.leaderboards.skills[0].targetId, "community-ui-skill");

  const resolve = await fetch(`${server.v2Url}/community/comment-reports/${encodeURIComponent(queuePayload.data[0].report.id)}/resolve`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      status: "reviewed",
      action: "unhide",
      note: "Community moderation UI fixture reviewed.",
    }),
  });
  assert.equal(resolve.status, 200);
  const resolvePayload = await resolve.json();
  assert.equal(resolvePayload.data.comment.status, "visible");
  assert.equal(resolvePayload.data.action, "unhide");

  const closedQueue = await fetch(`${server.v2Url}/community/comment-reports?status=open`, { headers: jsonHeaders });
  assert.equal(closedQueue.status, 200);
  assert.equal((await closedQueue.json()).data.length, 0);

  const comments = await fetch(`${server.v1Url}/skills/community-ui-skill/comments`);
  assert.equal(comments.status, 200);
  assert.equal((await comments.json()).data[0].id, commentId);
  assert.equal(server.storage.auditEvents.some((event) => event.action === "community.comment_report.resolve"), true);
  assert.equal(server.storage.auditEvents.some((event) => event.action === "community.comment.unhide"), true);
} finally {
  await server.close();
}
