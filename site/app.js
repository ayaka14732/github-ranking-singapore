const developerCount = document.querySelector("#developer-count");
const contributionCount = document.querySelector("#contribution-count");
const rankingRows = document.querySelector("#ranking-rows");
const resultStatus = document.querySelector("#result-status");
const searchInput = document.querySelector("#search");

const numberFormatter = new Intl.NumberFormat("en-SG");
let ranking = [];

function createCell(className, text) {
  const cell = document.createElement("td");
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function renderRanking(users) {
  const fragment = document.createDocumentFragment();

  if (!users.length) {
    const row = document.createElement("tr");
    const cell = createCell("empty", "No developers match your search.");
    cell.colSpan = 3;
    row.append(cell);
    fragment.append(row);
  }

  for (const user of users) {
    const row = document.createElement("tr");

    const rankCell = createCell("rank-cell", numberFormatter.format(user.rank));
    rankCell.dataset.label = "Rank";

    const developerCell = document.createElement("td");
    developerCell.className = "developer-cell";
    developerCell.dataset.label = "Developer";

    const profile = document.createElement("a");
    profile.href = `https://github.com/${encodeURIComponent(user.login)}`;
    profile.textContent = user.login;

    developerCell.append(profile);

    const contributionsCell = createCell(
      "contributions-cell",
      numberFormatter.format(user.contributions),
    );
    contributionsCell.dataset.label = "Public contributions";

    row.append(rankCell, developerCell, contributionsCell);
    fragment.append(row);
  }

  rankingRows.replaceChildren(fragment);
  resultStatus.textContent = `${numberFormatter.format(users.length)} of ${numberFormatter.format(
    ranking.length,
  )} developers`;
}

function isRankingEntry(value) {
  return (
    value &&
    Number.isInteger(value.rank) &&
    typeof value.login === "string" &&
    Number.isInteger(value.contributions)
  );
}

async function loadRanking() {
  try {
    const response = await fetch("./ranking.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`Ranking request failed with ${response.status}`);

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Ranking response is not an array");

    ranking = data.filter(isRankingEntry);
    if (!ranking.length) throw new Error("Ranking response contains no valid entries");

    developerCount.textContent = numberFormatter.format(ranking.length);
    contributionCount.textContent = numberFormatter.format(
      ranking.reduce((total, user) => total + user.contributions, 0),
    );
    searchInput.disabled = false;
    renderRanking(ranking);
  } catch (error) {
    console.error(error);
    rankingRows.replaceChildren();
    const row = document.createElement("tr");
    const cell = createCell(
      "error",
      "The ranking is unavailable right now. Please try again shortly.",
    );
    cell.colSpan = 3;
    row.append(cell);
    rankingRows.append(row);
    resultStatus.textContent = "Ranking data could not be loaded.";
  }
}

searchInput.disabled = true;
searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim().toLocaleLowerCase("en");
  const filtered = query
    ? ranking.filter((user) => user.login.toLocaleLowerCase("en").includes(query))
    : ranking;
  renderRanking(filtered);
});

loadRanking();
