#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const PAGE_PATH = "site/index.html";
const RANKING_PATH = "site/ranking.json";

const numberFormatter = new Intl.NumberFormat("en-SG");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderRow(user) {
  const login = escapeHtml(user.login);
  const profileUrl = `https://github.com/${encodeURIComponent(user.login)}`;
  return (
    "<tr>" +
    `<td class="rank-cell" data-label="Rank">${numberFormatter.format(user.rank)}</td>` +
    `<td class="developer-cell" data-label="Developer">` +
    `<a href="${profileUrl}" target="_blank" rel="noopener" ` +
    `aria-label="${login} on GitHub (opens in a new tab)">${login}</a></td>` +
    `<td class="contributions-cell" data-label="Public contributions">` +
    `${numberFormatter.format(user.contributions)}</td>` +
    "</tr>"
  );
}

function replaceOnce(page, needle, replacement, description) {
  const found =
    typeof needle === "string" ? page.includes(needle) : needle.test(page);
  if (!found) {
    throw new Error(
      `Cannot render the static page: ${description} was not found in ${PAGE_PATH}`,
    );
  }
  return page.replace(needle, replacement);
}

async function main() {
  const ranking = JSON.parse(await readFile(RANKING_PATH, "utf8"));
  if (!Array.isArray(ranking) || !ranking.length) {
    throw new Error(`${RANKING_PATH} does not contain a non-empty ranking array`);
  }

  let page = await readFile(PAGE_PATH, "utf8");

  const developerCount = numberFormatter.format(ranking.length);
  const totalContributions = ranking.reduce((total, user) => total + user.contributions, 0);

  page = replaceOnce(
    page,
    '<strong id="developer-count">&mdash;</strong>',
    `<strong id="developer-count">${developerCount}</strong>`,
    "the developer count placeholder",
  );
  page = replaceOnce(
    page,
    '<strong id="contribution-count">&mdash;</strong>',
    `<strong id="contribution-count">${numberFormatter.format(totalContributions)}</strong>`,
    "the contribution count placeholder",
  );
  page = replaceOnce(
    page,
    ">Loading ranking&hellip;</p>",
    `>${developerCount} of ${developerCount} developers</p>`,
    "the result status placeholder",
  );
  page = replaceOnce(
    page,
    /<tbody id="ranking-rows">[\s\S]*?<\/tbody>/,
    `<tbody id="ranking-rows">${ranking.map(renderRow).join("")}</tbody>`,
    "the ranking table body",
  );

  await writeFile(PAGE_PATH, page, "utf8");
  process.stderr.write(`Rendered ${ranking.length} developers into ${PAGE_PATH}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
