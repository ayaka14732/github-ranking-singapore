#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BRANCH = "ranking-data";
const FILE_NAME = "contributions.json";

function usage() {
  return `Usage: node scripts/data-branch.mjs <pull|push> <path>

Synchronize the per-year contribution data file with the "${BRANCH}" branch.
The branch holds a single ${FILE_NAME} file and is created on the first push.

Commands:
  pull    Write ${BRANCH}:${FILE_NAME} to <path>; does nothing if the branch
          does not exist yet
  push    Commit <path> as ${FILE_NAME} on ${BRANCH} and push it to origin
`;
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options });
}

function gitOptional(args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

function remoteTip() {
  const output = git(["ls-remote", "origin", `refs/heads/${BRANCH}`]).trim();
  return output ? output.split(/\s+/)[0] : null;
}

async function pull(path) {
  if (!remoteTip()) {
    process.stderr.write(`Branch ${BRANCH} does not exist yet; starting with empty data.\n`);
    return;
  }
  git(["fetch", "origin", `refs/heads/${BRANCH}`]);
  const content = execFileSync("git", ["show", `FETCH_HEAD:${FILE_NAME}`]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  process.stderr.write(`Restored ${path} from ${BRANCH}.\n`);
}

async function push(path) {
  await readFile(path); // fail early if the file does not exist
  const blob = git(["hash-object", "-w", path]).trim();

  const tip = remoteTip();
  const parentArgs = [];
  if (tip) {
    git(["fetch", "origin", `refs/heads/${BRANCH}`]);
    if (gitOptional(["rev-parse", "--verify", `FETCH_HEAD:${FILE_NAME}`]) === blob) {
      process.stderr.write(`${BRANCH} is already up to date.\n`);
      return;
    }
    parentArgs.push("-p", tip);
  }

  const tree = git(["mktree"], {
    input: `100644 blob ${blob}\t${FILE_NAME}\n`,
  }).trim();

  const env = { ...process.env };
  if (!gitOptional(["config", "user.name"])) {
    env.GIT_AUTHOR_NAME = "github-actions[bot]";
    env.GIT_AUTHOR_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
    env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
    env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  }

  const date = new Date().toISOString().slice(0, 10);
  const commit = git(
    ["commit-tree", tree, ...parentArgs, "-m", `Update contribution data (${date})`],
    { env },
  ).trim();

  try {
    git(["push", "origin", `${commit}:refs/heads/${BRANCH}`], { stdio: "inherit" });
  } catch {
    throw new Error(
      `Failed to push ${BRANCH}. Another run may have pushed first; ` +
        "run the pull command and try again.",
    );
  }
  process.stderr.write(`Pushed ${path} to ${BRANCH}.\n`);
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command === "--help") {
    process.stdout.write(usage());
    return;
  }
  if (!["pull", "push"].includes(command) || !path) {
    process.stderr.write(usage());
    process.exitCode = 1;
    return;
  }
  if (command === "pull") await pull(path);
  else await push(path);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
