import { Database } from "bun:sqlite";
import { maybeSpawnReviewChild } from "./src/services/command-hooks.ts";
const db = new Database("C:\\Users\\oh\\Downloads\\opencode-webui-portable-0.3.14-win-x64\\data\\opencode.db", { readonly: true });
const run: any = {
  id: "test-run-1",
  sessionId: "ses_test",
  repoId: 2,
  commandName: "review",
  args: "",
  directory: "C:\\Users\\oh\\Downloads\\opencode-webui-portable-0.3.14-win-x64\\workspace\\repos\\bbb",
  messageId: null,
  status: "started",
  origin: "verify",
  kind: "command",
  startedAt: Date.now(),
  finishedAt: null,
  createdAt: Date.now(),
  registrySha: null,
  targetHash: null,
};
// NOTE: portable backend :5002 serves opencode on :5552? No - single-server manager resolves its own.
// This script runs with cwd=backend src checkout; OPENCODE port env may differ. Just attempt.
const ok = await maybeSpawnReviewChild({
  sessionId: run.sessionId,
  directory: run.directory,
  repoId: run.repoId,
  commandName: run.commandName,
  args: run.args,
  kind: run.kind,
  status: "completed",
  origin: run.origin,
  db: db as any,
});
console.log("SPAWNED:", ok);
db.close();
process.exit(0);
