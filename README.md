# Dependabot Sitrep

A local Node.js dashboard for Dependabot alerts across the repositories visible to your GitHub CLI credentials. Group by organization, find vulnerable repositories, inspect alerts, and find gaps in Dependabot coverage.

## Run

Install [Node.js 22 or newer](https://nodejs.org/) and the [GitHub CLI](https://cli.github.com/), then sign in:

```sh
gh auth login
gh auth status
npm start
```

Open **http://127.0.0.1:4317**. There are no npm dependencies or build step. To explore fictional sample data without GitHub access:

```sh
npm run demo
```

Options:

```sh
npm start -- --port 4318
npm start -- --hostname github.example.com
npm test
```

`GH_HOST` and `PORT` can also set the GitHub hostname and local port. The app listens only on `127.0.0.1`. Stop it with Ctrl+C. It is intended for one user on their own machine.

## What the dashboard measures

- **Repository access:** all pages of GitHub's authenticated-user repository endpoint, including personal repositories, direct collaborations, and organization/team access.
- **Alerts enabled:** GitHub's explicit GraphQL `hasVulnerabilityAlertsEnabled` field. An API failure is shown as unknown, never assumed disabled.
- **Open alerts:** all pages of each readable repository's open Dependabot alerts, grouped by severity. Only a successful read can produce a zero count.
- **Coverage:** enabled repositories out of the stated set of repositories. Archived repositories remain separately identifiable.

Repository visibility depends on the **active gh account and its credentials**, including organization SSO authorization and token restrictions. The dashboard cannot discover access hidden from those credentials. Counts remain partial while scanning or when alert access is unavailable. A new scan uses the active account again; switching accounts clears the previous account's snapshot.

The scan uses batched metadata reads and sequential alert requests. Results and progress stay in memory until the server stops. Refresh explicitly to scan again. Rate limits pause the scan and show when another attempt is allowed.

## Enabling alerts

The per-repository **Enable alerts** action requires administrator access and an explicit confirmation naming the repository. The server rechecks identity and repository permissions before sending the request, then verifies the resulting setting.

GitHub's enable endpoint turns on **Dependabot alerts and the dependency graph**. It does not configure Dependabot version updates or security-update pull requests. Organization policies or token permissions can still prevent the action even when the account is a repository administrator.

Demo mode simulates the change and never modifies GitHub. Scans never change repository settings.

## Permissions and troubleshooting

`gh` keeps authentication credentials; the browser never receives a GitHub token. The app invokes fixed `gh api` operations without a shell. It does not install a GitHub App or ask for a separate token.

If authentication fails, run `gh auth login` in your terminal. If a classic/OAuth token lacks alert access, review its permissions and, when appropriate, run:

```sh
gh auth refresh --hostname github.com --scopes security_events
```

Private repository discovery needs appropriate repository access. Organization SSO may require authorizing the credentials for that organization. Fine-grained personal access tokens can be limited to a single resource owner and selected repositories. Alert access and repository access are separate permissions, so a repository may appear while its alert counts remain unavailable.

The local server checks the request host and origin and requires a process-specific request token for actions. Do not expose it through a public tunnel or reverse proxy. No repository or alert data is persisted by the app.

## Design and development

The initial mockup was commissioned through OpenDesign using Local Codex. The application preserves its local developer-tool direction and adds real GitHub CLI integration. `npm run demo` provides a repeatable sample-data preview.

The backend uses Node's built-in HTTP server, child processes, and test runner. Tests inject a fake GitHub client/CLI runner; they do not change repository settings.

References: [repository access API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user), [GraphQL repository fields](https://docs.github.com/en/graphql/reference/repos), [Dependabot alerts API](https://docs.github.com/en/rest/dependabot/alerts), [enable alerts API](https://docs.github.com/en/rest/repos/repos#enable-vulnerability-alerts), and [GitHub CLI API pagination](https://cli.github.com/manual/gh_api).
