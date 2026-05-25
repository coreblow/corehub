import assert from "node:assert/strict";
import { createOAuthToken, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const server = await startCoreHubTestServer();
try {
  const ownerToken = createOAuthToken({ type: "user", id: "github:settings-owner" });
  const completeOwner = await fetch(`${server.v2Url}/oauth/github/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      login: "settings-owner",
      providerAccountId: "1001",
      displayName: "Settings Owner",
      profileUrl: "https://github.com/settings-owner",
    }),
  });
  assert.equal(completeOwner.status, 200);

  const profileUpdate = await fetch(`${server.v2Url}/account/me`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Updated Owner",
      bio: "CoreHub settings owner.",
      avatarUrl: "https://avatars.example.invalid/settings-owner.png",
      email: "owner@example.invalid",
    }),
  });
  assert.equal(profileUpdate.status, 200);
  const profilePayload = await profileUpdate.json();
  assert.equal(profilePayload.data.account.displayName, "Updated Owner");
  assert.equal(profilePayload.data.account.bio, "CoreHub settings owner.");
  assert.equal(server.storage.auditEvents.some((event) => event.action === "user.profile.update"), true);

  const orgCreate = await fetch(`${server.v2Url}/orgs`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      handle: "settings-org",
      displayName: "Settings Org",
      source: "https://github.com/settings-org",
    }),
  });
  assert.equal(orgCreate.status, 201);

  const orgUpdate = await fetch(`${server.v2Url}/orgs/settings-org`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Updated Settings Org",
      bio: "Organization settings fixture.",
      avatarUrl: "https://avatars.example.invalid/settings-org.png",
      contact: "https://github.com/settings-org/contact",
    }),
  });
  assert.equal(orgUpdate.status, 200);
  const orgUpdatePayload = await orgUpdate.json();
  assert.equal(orgUpdatePayload.data.publisher.displayName, "Updated Settings Org");
  assert.equal(orgUpdatePayload.data.publisher.bio, "Organization settings fixture.");
  assert.equal(server.storage.auditEvents.some((event) => event.action === "publisher.profile.update"), true);

  const invite = await fetch(`${server.v2Url}/orgs/settings-org/invites`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ githubLogin: "settings-member", role: "maintainer" }),
  });
  assert.equal(invite.status, 201);
  const invitePayload = await invite.json();
  assert.equal(invitePayload.data.member.status, "invited");
  assert.equal(invitePayload.data.member.inviteGithubLogin, "settings-member");

  const memberToken = createOAuthToken({ type: "user", id: "github:settings-member" });
  const completeMember = await fetch(`${server.v2Url}/oauth/github/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      login: "settings-member",
      providerAccountId: "1002",
      displayName: "Settings Member",
      profileUrl: "https://github.com/settings-member",
    }),
  });
  assert.equal(completeMember.status, 200);

  const accept = await fetch(`${server.v2Url}/orgs/settings-org/invites/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(accept.status, 200);
  const acceptPayload = await accept.json();
  assert.equal(acceptPayload.data.member.status, "active");
  assert.equal(acceptPayload.data.member.userId, "github:settings-member");

  const members = await fetch(`${server.v2Url}/orgs/settings-org/members`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(members.status, 200);
  const membersPayload = await members.json();
  assert.equal(membersPayload.data.members.some((member) => member.userId === "github:settings-member" && member.status === "active"), true);

  const remove = await fetch(`${server.v2Url}/orgs/settings-org/members/github%3Asettings-member`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).data.member.status, "removed");

  const deleteWithoutConfirm = await fetch(`${server.v2Url}/orgs/settings-org`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm: false }),
  });
  assert.equal(deleteWithoutConfirm.status, 409);

  const deleteOrg = await fetch(`${server.v2Url}/orgs/settings-org`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm: "settings-org" }),
  });
  assert.equal(deleteOrg.status, 200);
  assert.equal((await deleteOrg.json()).data.publisher.status, "blocked");

  const deleteAccount = await fetch(`${server.v2Url}/account/me`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm: "settings-member" }),
  });
  assert.equal(deleteAccount.status, 200);
  assert.equal((await deleteAccount.json()).data.account.status, "deleted");
  assert.equal(server.storage.auditEvents.some((event) => event.action === "user.account.delete"), true);
} finally {
  await server.close();
}
