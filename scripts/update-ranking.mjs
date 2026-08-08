#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import { dirname } from "node:path";

const API_URL = "https://api.github.com/graphql";
const SEARCH_QUERY = "location:singapore sort:followers-desc";
const SEARCH_RESULT_LIMIT = 1_000;
const OUTPUT_PATH = "site/ranking.json";
const DATA_PATH = "data/contributions.json";
const MAX_REQUEST_ATTEMPTS = 7;
const MIN_REQUEST_INTERVAL_MS = 1_100;
const MIN_RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 5 * 60_000;

function usage() {
  return `Usage: node scripts/update-ranking.mjs [--limit <number>]

Build an all-time ranking for GitHub users whose profile location matches
Singapore, and write ${OUTPUT_PATH}. The score is public
contribution-calendar activity, summed by year.

Per-year contribution totals are cached in ${DATA_PATH}. Historical years
never change, so later runs only query the current year and newly discovered
users, and an interrupted run resumes from the cached years.

Options:
  --limit <number>  Only inspect the first N search results (for testing)
  --help            Show this help

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
  const options = { limit: SEARCH_RESULT_LIMIT };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--limit") {
      options.limit = parsePositiveInteger(argv[++index], "--limit");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.limit > SEARCH_RESULT_LIMIT) {
    throw new Error(`--limit cannot exceed GitHub Search's ${SEARCH_RESULT_LIMIT}-result limit`);
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
    // Recheck after sleeping because another in-flight request may extend the
    // shared cooldown when it receives a secondary-rate-limit response.
    while (nextRequestAt > Date.now()) {
      await delay(nextRequestAt - Date.now());
    }
    nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  });
  requestQueue = slot.catch(() => {});
  return slot;
}

function pauseAllRequests(milliseconds) {
  nextRequestAt = Math.max(nextRequestAt, Date.now() + milliseconds);
}

function retryDelay(response, messages, attempt) {
  const retryAfterSeconds = Number(response.headers["retry-after"]);
  const retryAfter = Number.isFinite(retryAfterSeconds)
    ? retryAfterSeconds * 1_000
    : 0;
  const remaining = Number(response.headers["x-ratelimit-remaining"]);
  const resetSeconds = Number(response.headers["x-ratelimit-reset"]);
  const resetDelay =
    remaining === 0 && Number.isFinite(resetSeconds)
      ? Math.max(0, resetSeconds * 1_000 - Date.now()) + 1_000
      : 0;
  const rateLimited =
    response.statusCode === 429 ||
    response.statusCode === 403 ||
    /rate limit|submitted too quickly/i.test(messages || "");

  if (rateLimited) {
    const exponentialDelay = Math.min(
      MIN_RATE_LIMIT_DELAY_MS * 2 ** (attempt - 1),
      MAX_RATE_LIMIT_DELAY_MS,
    );
    return Math.max(retryAfter, resetDelay, exponentialDelay);
  }
  return Math.max(retryAfter, 1_000 * 2 ** (attempt - 1));
}

function isRetryableResponse(response, messages) {
  return (
    response.statusCode === 429 ||
    (response.statusCode === 403 && /secondary rate limit/i.test(messages || "")) ||
    (Boolean(messages) && Number(response.headers["x-ratelimit-remaining"]) === 0) ||
    (response.statusCode >= 500 && response.statusCode <= 503) ||
    /rate limit|submitted too quickly|temporarily unavailable/i.test(messages || "")
  );
}

function pauseBeforeRetry(response, messages, attempt) {
  const wait = retryDelay(response, messages, attempt);
  pauseAllRequests(wait);
  process.stderr.write(
    `GitHub request will be retried; pausing all requests for ${Math.ceil(wait / 1_000)}s ` +
      `(retry ${attempt}/${MAX_REQUEST_ATTEMPTS - 1}).\n`,
  );
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
            const retryable =
              isRetryableResponse(response, responseBody) ||
              (response.statusCode >= 200 && response.statusCode < 300);
            if (retryable && attempt < MAX_REQUEST_ATTEMPTS) {
              pauseBeforeRetry(response, responseBody, attempt);
              try {
                resolve(await requestGraphQL(token, query, variables, attempt + 1));
              } catch (error) {
                reject(error);
              }
            } else {
              reject(
                new Error(
                  `GitHub returned HTTP ${response.statusCode} with an empty or non-JSON response`,
                ),
              );
            }
            return;
          }

          const messages =
            payload?.errors?.map((error) => error.message).join("; ") || payload?.message;
          const retryable = isRetryableResponse(response, messages);

          if (retryable && attempt < MAX_REQUEST_ATTEMPTS) {
            pauseBeforeRetry(response, messages, attempt);
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

async function addContributionYears(token, users) {
  const batches = chunks(users, 30);
  let completed = 0;

  for (const batch of batches) {
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
  }
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

function sumContributions(user, currentYear, fresh) {
  let total = 0;
  for (const year of user.years) {
    if (year > currentYear) continue;
    const value =
      year === currentYear ? fresh[year] : (user.cachedYears[year] ?? fresh[year]);
    total += value ?? 0;
  }
  return total;
}

async function addAllTimeCounts(token, users, store, saveData) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();

  // Historical years never change, so only the current year and years missing
  // from the persistent store are queried again.
  for (const user of users) {
    user.cachedYears = store.users[user.login.toLowerCase()]?.years ?? {};
    user.pendingYears = user.years.filter(
      (year) =>
        year <= currentYear &&
        (year === currentYear || user.cachedYears[year] == null),
    );
    if (!user.pendingYears.length) {
      user.contributions = sumContributions(user, currentYear, {});
    }
  }

  const pendingUsers = users.filter((user) => user.pendingYears.length);
  // Start with a compact batch and split it automatically if GitHub assigns
  // more resource cost to a group of particularly active accounts.
  const batches = chunksByWeight(pendingUsers, 40, (user) => user.pendingYears.length);
  let completed = users.length - pendingUsers.length;

  async function loadBatch(batch) {
    const fields = batch
      .map((user, index) => {
        const years = user.pendingYears
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
        /Resource limits for this query exceeded|HTTP 50[24]/i.test(error.message) &&
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

      const fresh = {};
      for (const year of user.pendingYears) {
        const yearResult = result[`y${year}`];
        if (!yearResult) continue;
        const total = yearResult.contributionCalendar.totalContributions;
        const privateContributions = yearResult.restrictedContributionsCount;
        fresh[year] = Math.max(0, total - privateContributions);
      }

      const entry = (store.users[user.login.toLowerCase()] ??= { years: {} });
      for (const year of user.pendingYears) {
        if (year !== currentYear && fresh[year] != null) {
          entry.years[year] = fresh[year];
          user.cachedYears[year] = fresh[year];
        }
      }

      user.contributions = sumContributions(user, currentYear, fresh);
    });

    completed += batch.length;
    process.stderr.write(`Loaded contributions: ${completed}/${users.length}\r`);
    await saveData();
  }

  for (const batch of batches) {
    await loadBatch(batch);
  }
  process.stderr.write("\n");
}

async function readDataFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, users: {} };
    throw error;
  }

  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    throw new Error(`Data file ${path} is not valid JSON; fix or delete it`);
  }
  if (store?.version !== 1 || !store.users || typeof store.users !== "object") {
    throw new Error(`Data file ${path} has an unsupported format; fix or delete it`);
  }
  return store;
}

function createDataWriter(path, store) {
  const temporaryPath = `${path}.tmp`;
  let queue = Promise.resolve();

  return function saveData() {
    const snapshot = `${JSON.stringify(store)}\n`;
    queue = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true });
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
    .map((user, index) => ({
      rank: index + 1,
      login: user.login,
      contributions: user.contributions,
    }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const token = getToken();
  const store = await readDataFile(DATA_PATH);
  const saveData = createDataWriter(DATA_PATH, store);

  process.stderr.write("Searching for GitHub users in Singapore...\n");
  const users = await searchSingaporeUsers(token, options.limit);
  if (!users.length) throw new Error("No Singapore users were returned by GitHub Search");
  process.stderr.write(`Found ${users.length} users.\n`);

  await addContributionYears(token, users);
  await addAllTimeCounts(token, users, store, saveData);
  await saveData();

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(sortRanking(users), null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote ${OUTPUT_PATH}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
