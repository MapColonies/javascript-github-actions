# JavaScript Github Actions

This repository contains a collection of JavaScript-based GitHub Actions that can be used in your workflows. Each action is designed to perform a specific task and can be easily integrated into your CI/CD pipelines.

## Actions

- [jira-integration](./actions/jira-integration) - Helps connecting pull requests to jira including comments on the pull request and title validation

- [update-chart-dependency](./actions/update-chart-dependency) - Update remote chat dependencies with a new service version

## Development

### Creating New Actions

To create a new action, run the interactive script:

```bash
npm run create-action
```

The script will:

- Prompt for action name (lowercase, kebab-case)
- Prompt for action description
- Create action directory under `./actions/`
- Copy template files and replace placeholders
- Generate action README with usage examples
- Update release configuration files
- Add entry to this README
