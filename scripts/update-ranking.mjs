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
// GitHub stops evaluating a GraphQL query after roughly ten seconds. Fields it
// did not finish fail with the first pattern; a request that took too long can
// also fail as a whole, matching the second.
const QUERY_TOO_EXPENSIVE_PATTERN =
  /Resource limits for this query exceeded|Something went wrong while executing your query/i;
const RETRYABLE_ERROR_PATTERN = new RegExp(
  `${QUERY_TOO_EXPENSIVE_PATTERN.source}|HTTP 5\\d\\d|timed out|socket hang up|ECONNRESET`,
  "i",
);
const CONTRIBUTION_BATCH_SIZE = 10;
const ITEM_RETRY_DELAY_MS = 5_000;
// Give up when this many requests in a row fail without resolving any field,
// so that a GitHub outage fails the run quickly instead of hitting the job
// timeout (which would also skip publishing the progress made so far).
const MAX_STALLED_REQUESTS = 20;
const DAY_MS = 24 * 60 * 60_000;
// Historical years are re-checked for the users checked longest ago, a few per
// run, so that every user is re-checked roughly every HISTORY_REFRESH_DAYS.
const HISTORY_REFRESH_DAYS = 180;
const HISTORY_REFRESH_USERS_PER_RUN = 40;
// Refuse to publish a ranking that silently lost a noticeable share of users.
const MAX_OMITTED_FRACTION = 0.05;

function usage() {
  return `Usage: node scripts/update-ranking.mjs [--limit <number>]

Build an all-time ranking for GitHub users whose profile location matches
Singapore, and write ${OUTPUT_PATH}. The score is public
contribution-calendar activity, summed by year.

Per-year contribution totals are cached in ${DATA_PATH}. Historical years
rarely change, so later runs only query the current year, newly discovered
users, and the history of up to ${HISTORY_REFRESH_USERS_PER_RUN} users not re-checked in
${HISTORY_REFRESH_DAYS} days. An interrupted run resumes from the cached years. The
current year's total is stored as well and used when it cannot be refreshed.

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

function isRetryableResponse(response, messages, retryServerErrors) {
  return (
    response.statusCode === 429 ||
    (response.statusCode === 403 && /secondary rate limit/i.test(messages || "")) ||
    (Boolean(messages) && Number(response.headers["x-ratelimit-remaining"]) === 0) ||
    (retryServerErrors && response.statusCode >= 500 && response.statusCode <= 503) ||
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

// Batched queries disable retryServerErrors, so that they are split instead.
async function requestGraphQL(
  token,
  query,
  variables,
  { retryServerErrors = true, attempt = 1 } = {},
) {
  const retry = () =>
    requestGraphQL(token, query, variables, { retryServerErrors, attempt: attempt + 1 });
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

          const messages = payload
            ? payload.errors?.map((error) => error.message).join("; ") || payload.message
            : responseBody;
          const retryable =
            isRetryableResponse(response, messages, retryServerErrors) ||
            (!payload && response.statusCode >= 200 && response.statusCode < 300);

          if (retryable && attempt < MAX_REQUEST_ATTEMPTS) {
            pauseBeforeRetry(response, messages, attempt);
            try {
              resolve(await retry());
            } catch (error) {
              reject(error);
            }
            return;
          }

          if (!payload) {
            reject(
              new Error(
                `GitHub returned HTTP ${response.statusCode} with an empty or non-JSON response`,
              ),
            );
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub returned HTTP ${response.statusCode}: ${messages || responseBody}`));
            return;
          }
          if (messages) {
            // Keep the partial result: GitHub reports errors per field, and the
            // fields that did resolve are still usable.
            const error = new Error(`GitHub GraphQL error: ${messages}`);
            error.data = payload.data;
            error.errors = payload.errors;
            reject(error);
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

// Query items as aliased fields, one GraphQL request per batch. GitHub reports
// fields it ran out of time for individually, so resolved fields are kept and
// only the rest are queried again, in smaller batches. An item that still
// fails on its own is retried once, then split with `splitItem` if the failure
// was its cost, and otherwise handed to `onFailure`, so one difficult account
// never aborts the whole run. `load` returns whether every item resolved.
async function queryInBatches(
  token,
  batches,
  { buildField, onResult, onFailure, splitItem = () => null, afterBatch },
) {
  let stalledRequests = 0;

  async function load(batch, retried = false) {
    const fields = batch.map((item, index) => `q${index}: ${buildField(item)}`).join("\n");
    let data;
    let errors = [];
    try {
      data = await requestGraphQL(token, `query { ${fields} }`, {}, { retryServerErrors: false });
    } catch (error) {
      if (!error.data && !RETRYABLE_ERROR_PATTERN.test(error.message)) throw error;
      data = error.data ?? {};
      errors = error.errors ?? [{ message: error.message }];
    }

    // Every queried field below `user` is non-null, so any error inside an
    // alias nulls the whole alias.
    const queryError = errors.find((error) => !error.path);
    const failed = [];
    let resolved = true;
    const fail = (item, reason) => {
      onFailure(item, reason);
      resolved = false;
    };
    batch.forEach((item, index) => {
      const result = data[`q${index}`];
      const error = errors.find((error) => error.path?.[0] === `q${index}`) ?? queryError;
      if (result != null) {
        onResult(item, result);
      } else if (!error || error.type === "NOT_FOUND") {
        fail(item, "GitHub user not found");
      } else if (RETRYABLE_ERROR_PATTERN.test(error.message)) {
        failed.push({ item, error });
      } else {
        fail(item, error.message);
      }
    });
    if (failed.length < batch.length) {
      stalledRequests = 0;
    } else if (++stalledRequests >= MAX_STALLED_REQUESTS) {
      throw new Error(
        `GitHub failed ${stalledRequests} requests in a row: ${failed[0].error.message}`,
      );
    }
    if (!failed.length) return resolved;

    const items = failed.map(({ item }) => item);
    if (items.length < batch.length) {
      return (await load(items)) && resolved;
    }
    if (items.length > 1) {
      const middle = Math.ceil(items.length / 2);
      const first = await load(items.slice(0, middle));
      return (await load(items.slice(middle))) && first;
    }
    if (!retried) {
      await delay(ITEM_RETRY_DELAY_MS);
      return load(items, true);
    }
    // Parts are queried one at a time, since together they cost as much as the
    // whole, and not retried. The first part that fails dooms the item, so the
    // remaining parts are skipped.
    const [{ item, error }] = failed;
    const parts = QUERY_TOO_EXPENSIVE_PATTERN.test(error.message) && splitItem(item);
    if (!parts) {
      fail(item, error.message);
      return false;
    }
    for (const part of parts) {
      if (!(await load([part], true))) return false;
    }
    return true;
  }

  for (const batch of batches) {
    await load(batch);
    await afterBatch(batch);
  }
}

async function addContributionYears(token, users) {
  let completed = 0;

  await queryInBatches(token, chunks(users, 30), {
    buildField: (user) =>
      `user(login: ${JSON.stringify(user.login)}) { contributionsCollection { contributionYears } }`,
    onResult: (user, result) => {
      const years = result.contributionsCollection.contributionYears;
      user.years = [...new Set(years)].sort((left, right) => left - right);
    },
    onFailure: (user, reason) => {
      process.stderr.write(`\nWarning: could not load active years for ${user.login}: ${reason}\n`);
    },
    afterBatch: (batch) => {
      completed += batch.length;
      process.stderr.write(`Loaded active years: ${completed}/${users.length}\r`);
    },
  });
  process.stderr.write("\n");
}

function yearRange(year, currentYear, now) {
  return {
    from: new Date(Date.UTC(year, 0, 1)),
    to: year === currentYear ? now : new Date(Date.UTC(year + 1, 0, 1) - 1_000),
  };
}

// Split a contribution range in half at a UTC day boundary, so that a burst of
// activity too expensive to count in one go (thousands of contributions in a
// single week exist) is counted piece by piece, down to a week or less. This
// is a last resort: GitHub buckets contributions by day in the account's time
// zone, so the parts can add up to a total that differs by a few.
function splitRange(unit) {
  const days = Math.floor((unit.to - unit.from) / DAY_MS);
  if (days <= 7) return null;
  const middle = new Date(unit.from.getTime() + Math.floor(days / 2) * DAY_MS);
  unit.slot.remaining += 1;
  return [
    { slot: unit.slot, from: unit.from, to: new Date(middle - 1_000) },
    { slot: unit.slot, from: middle, to: unit.to },
  ];
}

function contributionField(unit) {
  const from = JSON.stringify(unit.from.toISOString());
  const to = JSON.stringify(unit.to.toISOString());
  return `user(login: ${JSON.stringify(unit.slot.user.login)}) {
    c: contributionsCollection(from: ${from}, to: ${to}) {
      contributionCalendar { totalContributions }
      restrictedContributionsCount
    }
  }`;
}

// Returns null when a year is neither cached nor freshly loaded. A stored
// current-year count also stands in for that year once it is over, until the
// final count has been loaded.
function sumContributions(years, entry, currentYear) {
  let total = 0;
  for (const year of years) {
    const value =
      (year !== currentYear ? entry?.years[year] : null) ??
      (entry?.current?.year === year ? entry.current.contributions : null);
    if (value == null) return null;
    total += value;
  }
  return total;
}

// Historical counts still drift now and then (for example when a repository
// is deleted), so each run also re-queries the whole history of the users
// whose history was checked longest ago. Users without a check date, such as
// those cached before check dates were recorded, come first.
function selectHistoryRefresh(users, store, currentYear, now) {
  const staleBefore = new Date(now - HISTORY_REFRESH_DAYS * DAY_MS).toISOString().slice(0, 10);
  const checkedAt = (user) => store.users[user.login.toLowerCase()]?.checkedAt ?? "";
  return new Set(
    users
      .filter(
        (user) =>
          store.users[user.login.toLowerCase()] &&
          user.years.some((year) => year < currentYear) &&
          checkedAt(user) < staleBefore,
      )
      .sort((left, right) => checkedAt(left).localeCompare(checkedAt(right)))
      .slice(0, HISTORY_REFRESH_USERS_PER_RUN),
  );
}

async function addAllTimeCounts(token, users, store, saveData) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const today = now.toISOString().slice(0, 10);
  // Users whose active years could not be loaded are left out of the ranking.
  users = users.filter((user) => user.years);
  for (const user of users) user.years = user.years.filter((year) => year <= currentYear);
  const refreshUsers = selectHistoryRefresh(users, store, currentYear, now);
  if (refreshUsers.size) {
    process.stderr.write(`Re-checking historical years for ${refreshUsers.size} users.\n`);
  }

  const units = [];
  for (const user of users) {
    const entry = store.users[user.login.toLowerCase()];
    const cachedYears = entry?.years ?? {};
    // A user's history counts as checked once every historical year has been
    // loaded in this run, which is the case for new users as well.
    user.historyCheck = !entry || refreshUsers.has(user);
    user.historyPending = 0;
    for (const year of user.years) {
      if (year !== currentYear) {
        if (cachedYears[year] != null && !user.historyCheck) continue;
        user.historyPending += 1;
      }
      const slot = { user, year, total: 0, remaining: 1 };
      units.push({ slot, ...yearRange(year, currentYear, now) });
    }
  }

  let completed = 0;

  await queryInBatches(token, chunks(units, CONTRIBUTION_BATCH_SIZE), {
    buildField: contributionField,
    onResult: (unit, result) => {
      const { slot } = unit;
      const collection = result.c;
      slot.total += Math.max(
        0,
        collection.contributionCalendar.totalContributions -
          collection.restrictedContributionsCount,
      );
      // A failed part never decrements `remaining`, so zero means all succeeded.
      slot.remaining -= 1;
      if (slot.remaining) return;

      const { user } = slot;
      const entry = (store.users[user.login.toLowerCase()] ??= { years: {} });
      if (slot.year === currentYear) {
        entry.current = { year: currentYear, contributions: slot.total };
      } else {
        entry.years[slot.year] = slot.total;
        user.historyPending -= 1;
        if (user.historyCheck && !user.historyPending) entry.checkedAt = today;
      }
    },
    onFailure: (unit, reason) => {
      process.stderr.write(
        `\nWarning: could not load ${unit.slot.year} contributions for ` +
          `${unit.slot.user.login}: ${reason}\n`,
      );
    },
    splitItem: splitRange,
    afterBatch: async (batch) => {
      completed += batch.length;
      process.stderr.write(`Loaded contributions: ${completed}/${units.length}\r`);
      await saveData();
    },
  });
  process.stderr.write("\n");

  for (const user of users) {
    const entry = store.users[user.login.toLowerCase()];
    user.contributions = sumContributions(user.years, entry, currentYear);
  }
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

  const ranked = users.filter((user) => user.contributions != null);
  const omitted = users.filter((user) => user.contributions == null);
  if (omitted.length) {
    process.stderr.write(
      `Warning: leaving out ${omitted.length} users with incomplete data: ` +
        `${omitted.map((user) => user.login).join(", ")}\n`,
    );
  }
  if (omitted.length > users.length * MAX_OMITTED_FRACTION) {
    throw new Error(
      `Too many users (${omitted.length}/${users.length}) have incomplete data; ` +
        "the ranking was not written. Cached progress is kept for the next run.",
    );
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(sortRanking(ranked), null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote ${OUTPUT_PATH}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
