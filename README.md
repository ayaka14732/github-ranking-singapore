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

Other output formats:

```sh
node scripts/update-ranking.mjs --format csv --output ranking.csv
node scripts/update-ranking.mjs --format markdown --output ranking.md
```

If an update is interrupted, a checkpoint is saved. Running the update again on the same day resumes from that checkpoint, which is automatically deleted after a successful run.

## Automated updates

GitHub Actions rebuilds and deploys the website on every push to `main` and every Monday at 02:00 Singapore Time. It uses the repository's `GITHUB_TOKEN` by default. If you encounter API permission or rate-limit issues, create a `RANKING_TOKEN` repository secret.

In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. Ranking data is deployed directly to GitHub Pages and is never committed to the repository.
