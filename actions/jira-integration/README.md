# 🔗 Jira Integration Action

Keep your PRs connected to Jira issues! This action validates that your pull request titles contain proper Jira issue references, adds helpful comments with clickable links, and provides smart bypass options for automated PRs.

## ✨ What it does

- 🎯 **Smart PR title validation** - Ensures every PR references a valid Jira issue
- 📝 **Flexible pattern matching** - Customizable regex patterns for different Jira setups
- 💬 **Automated linking** - Posts comments with direct links to Jira issues
- 🚀 **Smart bypasses** - Skip validation for bots, specific users, or labeled PRs
- ⚡ **Zero configuration** - Works perfectly with MapColonies defaults

## 🚀 Quick Start

```yaml
name: Jira Integration
on:
  pull_request:
    types: [opened, edited]

permissions:
  statuses: write
  pull-requests: write

jobs:
  jira-validation:
    runs-on: ubuntu-latest
    steps:
      - uses: mapcolonies/javascript-github-actions/actions/jira-integration@v1
```

## 📥 Inputs

| Input                | Description                                                   | Required | Default                              |
| -------------------- | ------------------------------------------------------------- | -------- | ------------------------------------ |
| `github-token`       | GitHub token for API access                                   | ❌       | `${{ github.token }}`                |
| `jira-base-url`      | Base URL for Jira instance                                    | ❌       | `https://mapcolonies.atlassian.net`  |
| `jira-issue-pattern` | Regex pattern for Jira issue IDs                              | ❌       | `MAPCO-[0-9]+`                       |
| `bypass-labels`      | Comma-separated list of labels that bypass Jira validation    | ❌       | -                                    |
| `bypass-users`       | Comma-separated list of usernames that bypass Jira validation | ❌       | `dependabot[bot],mapcolonies-devops` |

## 📤 Outputs

This action sets commit status checks but doesn't expose direct outputs. The validation results are visible in your PR's status checks.

## 🔐 Required Permissions

This action needs the following permissions in your workflow:

```yaml
permissions:
  statuses: write # To set commit status checks
  pull-requests: write # To comment on PRs
  contents: read # To read PR details
```

## 🎯 Examples

### Basic setup (uses defaults)

```yaml
- uses: mapcolonies/javascript-github-actions/actions/jira-integration@v1
```

### With custom settings

```yaml
- uses: mapcolonies/javascript-github-actions/actions/jira-integration@v1
  with:
    jira-base-url: 'https://your-company.atlassian.net'
    jira-issue-pattern: 'PROJ-[0-9]+'
    bypass-users: 'dependabot[bot],renovate[bot]'
    bypass-labels: 'skip-jira,hotfix'
```

### Skip validation for specific scenarios

```yaml
- uses: mapcolonies/javascript-github-actions/actions/jira-integration@v1
  with:
    bypass-labels: 'documentation,dependencies'
    bypass-users: 'dependabot[bot],renovate[bot],github-actions[bot]'
```

## 💡 Pro Tips

- **PR Title Format**: Combine conventional commits with Jira references like `feat: implement user authentication (MAPCO-456)`
- **Bot Management**: Add bot accounts to `bypass-users` to skip validation for automated PRs
- **Label Bypasses**: Use `bypass-labels` for PRs that don't need Jira references (docs, dependencies, etc.)
- **Status Checks**: Results appear in your PR's status checks section for easy monitoring
