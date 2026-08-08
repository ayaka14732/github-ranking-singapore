# GitHub Ranking Singapore

A ranking of open-source developers in Singapore by their public GitHub contributions.

[View the live ranking](https://ayaka14732.github.io/github-ranking-singapore/)

## Ranking methodology

- Only GitHub users whose profile location matches `Singapore` are included in the search.
- Contributions are counted across all available years in each account's GitHub contribution calendar.
- Scores include public commits, pull requests, issues, code reviews, and other contributions.
- Private contributions are excluded: `public contributions = totalContributions - restrictedContributionsCount`.
- Ties are broken by GitHub username.

GitHub Search returns at most the first 1,000 results, and profile locations are self-reported. As a result, this ranking cannot include every developer living in Singapore.

## Updating the ranking

You need Node.js 20 or later and a GitHub token:

```sh
export GITHUB_TOKEN=your_token
npm run update
python3 -m http.server 8000 --directory site
```

Open <http://localhost:8000> to preview the site. The generated `site/ranking.json` file is ignored by Git and is only included in the GitHub Pages deployment artifact.

If you have already run `gh auth login`, the script can read the token directly from `gh auth token`, so you do not need to set the environment variable. Do not use or commit browser cookies.

Per-year contribution totals are cached in `data/contributions.json`. Historical years never change, so later runs only query the current year and newly discovered users, and an interrupted run resumes from the cached years. The file is ignored by Git locally and synchronized with the dedicated `ranking-data` branch:

```sh
npm run data:pull   # download the data file from the ranking-data branch (optional)
npm run update      # build the ranking, updating the data file
npm run data:push   # commit the data file to the ranking-data branch and push it
```

The first full run queries every active year of every user and can take a long time. Run it locally once and push the data branch, so that automated updates only ever perform the cheap incremental refresh.

## Automated updates

GitHub Actions rebuilds and deploys the website on every push to `main` and every Monday at 02:00 Singapore Time. Each run downloads the per-year contribution data from the `ranking-data` branch, refreshes the current year (and any newly discovered users), and pushes the updated data back to that branch. The ranking is also rendered into static HTML by `scripts/render-page.mjs`, so the table is visible to search engines and to browsers without JavaScript. The workflow uses the repository's `GITHUB_TOKEN` by default. If you encounter API permission or rate-limit issues, create a `RANKING_TOKEN` repository secret.

Initialize the data branch locally before the first automated run (see above), so that the workflow never needs to re-query every historical year.

In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. Ranking data is deployed directly to GitHub Pages and is never committed to the repository.
