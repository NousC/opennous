// Who counts as a workspace admin in the UI (GET-620 review): Rotate signing secret and the
// "Calls today" label key off this. Run: node --test apps/frontend/tests/roles.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkspaceAdmin, roleOf } from "../src/lib/roles.ts";

test("owners, admins and the founder are workspace admins; members and viewers are not", () => {
  assert.equal(isWorkspaceAdmin({ workspace_role: "owner" }), true);
  assert.equal(isWorkspaceAdmin({ workspace_role: "Admin" }), true);
  assert.equal(isWorkspaceAdmin({ workspace_role: "founder" }), true);
  assert.equal(isWorkspaceAdmin({ workspace_role: "member", is_founder: true }), true);
  assert.equal(isWorkspaceAdmin({ workspace_role: "member" }), false);
  assert.equal(isWorkspaceAdmin({ workspace_role: "viewer" }), false);
  assert.equal(isWorkspaceAdmin(null), false);
  assert.equal(roleOf({ workspace_role: "owner" }), "manager");
});
