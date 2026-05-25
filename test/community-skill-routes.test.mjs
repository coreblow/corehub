import assert from "node:assert/strict";
import { jsonHeaders, seedHostedSkill, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const server = await startCoreHubTestServer();
try {
  await seedHostedSkill(server.storage, { slug: "surface-skill" });

  const detail = await fetch(`${server.v1Url}/skills/surface-skill`);
  assert.equal(detail.status, 200);
  const detailPayload = await detail.json();
  assert.equal(detailPayload.data.rendered.html.includes("<h1>Surface Skill</h1>"), true);

  const security = await fetch(`${server.v1Url}/skills/surface-skill/security`);
  assert.equal(security.status, 200);
  assert.equal((await security.json()).data.blockedFromInstall, false);

  const star = await fetch(`${server.v2Url}/community/stars`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ targetType: "skill", targetId: "surface-skill" }),
  });
  assert.equal(star.status, 200);
  assert.equal((await star.json()).data.stats.stars, 1);

  const comment = await fetch(`${server.v2Url}/community/comments`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      targetType: "skill",
      targetId: "surface-skill",
      body: "Useful surface parity fixture.",
    }),
  });
  assert.equal(comment.status, 201);
  const commentPayload = await comment.json();
  assert.equal(commentPayload.data.stats.comments, 1);

  const community = await fetch(`${server.v1Url}/skills/surface-skill/community`);
  assert.equal(community.status, 200);
  const communityPayload = await community.json();
  assert.equal(communityPayload.data.stats.stars, 1);
  assert.equal(communityPayload.data.comments[0].body, "Useful surface parity fixture.");

  const leaderboard = await fetch(`${server.v1Url}/community/leaderboard?target=skills&sort=trending`);
  assert.equal(leaderboard.status, 200);
  const leaderboardPayload = await leaderboard.json();
  assert.equal(leaderboardPayload.data[0].targetId, "surface-skill");
  assert.equal(leaderboardPayload.data[0].score, 5);

  const report = await fetch(`${server.v2Url}/community/comments/${commentPayload.data.comment.id}/report`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ reason: "Surface moderation fixture." }),
  });
  assert.equal(report.status, 200);
  assert.equal((await report.json()).data.reported, true);

  const deleted = await fetch(`${server.v2Url}/community/comments/${commentPayload.data.comment.id}`, {
    method: "DELETE",
    headers: jsonHeaders,
  });
  assert.equal(deleted.status, 200);

  const commentsAfterDelete = await fetch(`${server.v1Url}/skills/surface-skill/comments`);
  assert.equal(commentsAfterDelete.status, 200);
  assert.equal((await commentsAfterDelete.json()).data.length, 0);
} finally {
  await server.close();
}
