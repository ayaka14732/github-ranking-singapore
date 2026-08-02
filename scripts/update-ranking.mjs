#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import https from "node:https";

const API_URL = "https://api.github.com/graphql";
const SEARCH_QUERY = "location:singapore sort:followers-desc";
const SEARCH_RESULT_LIMIT = 1_000;

function usage() {
  return `Usage: node scripts/update-ranking.mjs [options]

Build an all-time ranking for GitHub users whose profile location matches
Singapore. The score is public contribution-calendar activity, summed by year.

Options:
  --format <markdown|csv|json>  Output format (default: markdown)
  --output <path>               Write to a file instead of stdout
  --limit <number>              Only inspect the first N search results
  --concurrency <number>        Concurrent GitHub requests (default: 2)
  --help                        Show this help

Authentication is read from GITHUB_TOKEN, CUSTOM_TOKEN, or “gh auth token”.
`;
}

function parsePositiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    format: "markdown",
    output: null,
    limit: SEARCH_RESULT_LIMIT,
    concurrency: 2,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--format") {
      options.format = argv[++index];
    } else if (argument === "--output") {
      options.output = argv[++index];
    } else if (argument === "--limit") {
      options.limit = parsePositiveInteger(argv[++index], "--limit");
    } else if (argument === "--concurrency") {
      options.concurrency = parsePositiveInteger(argv[++index], "--concurrency");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!new Set(["markdown", "csv", "json"]).has(options.format)) {
    throw new Error("--format must be markdown, csv, or json");
  }
  if (options.limit > SEARCH_RESULT_LIMIT) {
    throw new Error(`--limit cannot exceed GitHub Search's ${SEARCH_RESULT_LIMIT}-result limit`);
  }
  if (options.concurrency > 10) {
    throw new Error("--concurrency cannot exceed 10");
  }
  return options;
}

function getToken() {
  const environmentToken = process.env.GITHUB_TOKEN || process.env.CUSTOM_TOKEN;
  if (environmentToken && environmentToken.trim()) return environmentToken.trim();

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN/CUSTOM_TOKEN or run `gh auth login`.",
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let requestQueue = Promise.resolve();
let nextRequestAt = 0;

function waitForRequestSlot() {
  const slot = requestQueue.then(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await delay(wait);
    nextRequestAt = Date.now() + 1_100;
  });
  requestQueue = slot.catch(() => {});
  return slot;
}

async function requestGraphQL(token, query, variables, attempt = 1) {
  await waitForRequestSlot();
  const body = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const request = https.request(
      API_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
          "User-Agent": "github-ranking-singapore",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", async () => {
          let payload;
          try {
            payload = JSON.parse(responseBody);
          } catch {
            payload = null;
          }

          if (!payload) {
            if (attempt < 5) {
              await delay(1_000 * 2 ** (attempt - 1));
              try {
                resolve(await requestGraphQL(token, query, variables, attempt + 1));
              } catch (error) {
                reject(error);
              }
            } else {
              reject(new Error("GitHub returned an empty or non-JSON response"));
            }
            return;
          }

          const messages =
            payload?.errors?.map((error) => error.message).join("; ") || payload?.message;
          const retryable =
            response.statusCode === 429 ||
            (response.statusCode === 403 && /secondary rate limit/i.test(messages || "")) ||
            (response.statusCode >= 500 && response.statusCode <= 503) ||
            /secondary rate limit|submitted too quickly|temporarily unavailable/i.test(messages || "");

          if (retryable && attempt < 5) {
            const retryAfter = Number(response.headers["retry-after"] || 0) * 1_000;
            const secondaryLimitDelay = /secondary rate limit/i.test(messages || "")
              ? 30_000 * attempt
              : 1_000 * 2 ** (attempt - 1);
            await delay(Math.max(retryAfter, secondaryLimitDelay));
            try {
              resolve(await requestGraphQL(token, query, variables, attempt + 1));
            } catch (error) {
              reject(error);
            }
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub returned HTTP ${response.statusCode}: ${messages || responseBody}`));
            return;
          }
          if (messages) {
            reject(new Error(`GitHub GraphQL error: ${messages}`));
            return;
          }
          resolve(payload.data);
        });
      },
    );

    request.setTimeout(30_000, () => request.destroy(new Error("GitHub request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function chunks(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}

function chunksByWeight(array, maximumWeight, getWeight) {
  const result = [];
  let chunk = [];
  let weight = 0;

  for (const item of array) {
    const itemWeight = Math.max(1, getWeight(item));
    if (chunk.length && weight + itemWeight > maximumWeight) {
      result.push(chunk);
      chunk = [];
      weight = 0;
    }
    chunk.push(item);
    weight += itemWeight;
  }
  if (chunk.length) result.push(chunk);
  return result;
}

async function mapConcurrent(array, concurrency, worker) {
  const results = new Array(array.length);
  let nextIndex = 0;

  async function run() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= array.length) return;
      results[index] = await worker(array[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, array.length) }, () => run()),
  );
  return results;
}

async function searchSingaporeUsers(token, limit) {
  const query = `
    query($search: String!, $cursor: String) {
      search(type: USER, query: $search, first: 100, after: $cursor) {
        userCount
        pageInfo { endCursor hasNextPage }
        nodes {
          ... on User { login }
        }
      }
    }
  `;

  const users = [];
  const seen = new Set();
  let cursor = null;
  let totalMatches = 0;

  while (users.length < limit) {
    const data = await requestGraphQL(token, query, {
      search: SEARCH_QUERY,
      cursor,
    });
    totalMatches = data.search.userCount;

    for (const node of data.search.nodes) {
      if (!node?.login) continue;
      const key = node.login.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        users.push({ login: node.login });
      }
      if (users.length === limit) break;
    }

    if (!data.search.pageInfo.hasNextPage || users.length >= SEARCH_RESULT_LIMIT) break;
    cursor = data.search.pageInfo.endCursor;
  }

  if (totalMatches > SEARCH_RESULT_LIMIT && limit === SEARCH_RESULT_LIMIT) {
    process.stderr.write(
      `Warning: GitHub Search found ${totalMatches} matches but exposes at most ${SEARCH_RESULT_LIMIT}.\n`,
    );
  }
  return users;
}

async function addContributionYears(token, users, concurrency) {
  const batches = chunks(users, 30);
  let completed = 0;

  await mapConcurrent(batches, concurrency, async (batch) => {
    const fields = batch
      .map(
        (user, index) =>
          `u${index}: user(login: ${JSON.stringify(user.login)}) { ` +
          "contributionsCollection { contributionYears } }",
      )
      .join("\n");
    const data = await requestGraphQL(token, `query { ${fields} }`, {});

    batch.forEach((user, index) => {
      const years = data[`u${index}`]?.contributionsCollection?.contributionYears;
      if (!years) throw new Error(`GitHub user disappeared while querying: ${user.login}`);
      user.years = [...new Set(years)].sort((left, right) => left - right);
    });

    completed += batch.length;
    process.stderr.write(`Loaded active years: ${completed}/${users.length}\r`);
  });
  process.stderr.write("\n");
}

function contributionCollectionField(year, currentYear, now) {
  const from = `${year}-01-01T00:00:00Z`;
  const to =
    year === currentYear ? now.toISOString() : `${year}-12-31T23:59:59Z`;

  return `y${year}: contributionsCollection(from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}) {
    contributionCalendar { totalContributions }
    restrictedContributionsCount
  }`;
}

async function addAllTimeCounts(token, users, concurrency, onBatch = async () => {}) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  // Start with a compact batch and split it automatically if GitHub assigns
  // more resource cost to a group of particularly active accounts.
  const batches = chunksByWeight(users, 40, (user) => user.years.length);
  let completed = 0;

  async function loadBatch(batch) {
    const fields = batch
      .map((user, index) => {
        const years = user.years
          .filter((year) => year <= currentYear)
          .map((year) => contributionCollectionField(year, currentYear, now))
          .join("\n");
        return `u${index}: user(login: ${JSON.stringify(user.login)}) { ${years} }`;
      })
      .join("\n");
    let data;
    try {
      data = await requestGraphQL(token, `query { ${fields} }`, {});
    } catch (error) {
      if (
        /Resource limits for this query exceeded|HTTP 504/i.test(error.message) &&
        batch.length > 1
      ) {
        const middle = Math.ceil(batch.length / 2);
        await loadBatch(batch.slice(0, middle));
        await loadBatch(batch.slice(middle));
        return;
      }
      throw error;
    }

    batch.forEach((user, index) => {
      const result = data[`u${index}`];
      if (!result) throw new Error(`GitHub user disappeared while querying: ${user.login}`);

      user.contributions = 0;
      for (const year of user.years) {
        const yearResult = result[`y${year}`];
        if (!yearResult) continue;
        const total = yearResult.contributionCalendar.totalContributions;
        const privateContributions = yearResult.restrictedContributionsCount;
        user.contributions += Math.max(0, total - privateContributions);
      }
    });

    completed += batch.length;
    process.stderr.write(`Loaded contributions: ${completed}/${users.length}\r`);
    await onBatch(batch);
  }

  await mapConcurrent(batches, concurrency, loadBatch);
  process.stderr.write("\n");
}

async function readCheckpoint(path, date) {
  try {
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    if (checkpoint.version === 1 && checkpoint.date === date) return checkpoint;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return { version: 1, date, users: {} };
}

function createCheckpointWriter(path, checkpoint) {
  const temporaryPath = `${path}.tmp`;
  let queue = Promise.resolve();

  return function saveCheckpoint() {
    const snapshot = `${JSON.stringify(checkpoint)}\n`;
    queue = queue.then(async () => {
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, path);
    });
    return queue;
  };
}

function sortRanking(users) {
  return users
    .sort(
      (left, right) =>
        right.contributions - left.contributions ||
        left.login.localeCompare(right.login, "en", { sensitivity: "base" }),
    )
    .map((user, index) => ({ rank: index + 1, ...user }));
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|");
}

function escapeCsv(value) {
  const string = String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function formatRanking(ranking, format) {
  if (format === "json") {
    return `${JSON.stringify(
      ranking.map(({ rank, login, contributions }) => ({
        rank,
        login,
        contributions,
      })),
      null,
      2,
    )}\n`;
  }

  if (format === "csv") {
    const rows = ["rank,login,contributions"];
    for (const user of ranking) {
      rows.push(
        [user.rank, user.login, user.contributions].map(escapeCsv).join(","),
      );
    }
    return `${rows.join("\n")}\n`;
  }

  const rows = [
    "| # | User | Public contributions |",
    "|--:|:-----|--------------:|",
  ];
  for (const user of ranking) {
    rows.push(
      `| ${user.rank} | [${escapeMarkdown(user.login)}](https://github.com/${encodeURIComponent(
        user.login,
      )}) | ${user.contributions} |`,
    );
  }
  return `${rows.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const token = getToken();
  const checkpointPath = options.output
    ? `${options.output}.checkpoint.json`
    : ".singapore-ranking.checkpoint.json";
  const checkpointDate = new Date().toISOString().slice(0, 10);
  const checkpoint = await readCheckpoint(checkpointPath, checkpointDate);
  const saveCheckpoint = createCheckpointWriter(checkpointPath, checkpoint);

  process.stderr.write("Searching for GitHub users in Singapore...\n");
  const users = await searchSingaporeUsers(token, options.limit);
  if (!users.length) throw new Error("No Singapore users were returned by GitHub Search");
  process.stderr.write(`Found ${users.length} users.\n`);

  for (const user of users) {
    const saved = checkpoint.users[user.login.toLowerCase()];
    if (saved?.years) user.years = saved.years;
    if (Number.isInteger(saved?.contributions)) user.contributions = saved.contributions;
  }

  const usersMissingYears = users.filter((user) => !user.years);
  if (usersMissingYears.length) {
    await addContributionYears(token, usersMissingYears, options.concurrency);
    for (const user of usersMissingYears) {
      const key = user.login.toLowerCase();
      checkpoint.users[key] = { ...checkpoint.users[key], years: user.years };
    }
    await saveCheckpoint();
  } else {
    process.stderr.write(`Loaded active years from checkpoint: ${users.length}/${users.length}\n`);
  }

  const usersMissingContributions = users.filter(
    (user) => !Number.isInteger(user.contributions),
  );
  if (usersMissingContributions.length) {
    await addAllTimeCounts(
      token,
      usersMissingContributions,
      options.concurrency,
      async (completedUsers) => {
        for (const user of completedUsers) {
          const key = user.login.toLowerCase();
          checkpoint.users[key] = {
            ...checkpoint.users[key],
            years: user.years,
            contributions: user.contributions,
          };
        }
        await saveCheckpoint();
      },
    );
  } else {
    process.stderr.write(`Loaded contributions from checkpoint: ${users.length}/${users.length}\n`);
  }

  const output = formatRanking(sortRanking(users), options.format);
  if (options.output) {
    await writeFile(options.output, output, "utf8");
    process.stderr.write(`Wrote ${options.output}\n`);
  } else {
    process.stdout.write(output);
  }
  await unlink(checkpointPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
