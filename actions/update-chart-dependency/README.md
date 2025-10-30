# Update Helm Chart Dependencies GitHub Action

This GitHub Action updates the version of a specific dependency in the `Chart` and `helmfile` yaml files for one or more directories in a remote repository. For each it creates or updates a dedicated branch with the chart changes and opens or updates a pull request.

## Features

- Accepts a dependency service name and version as inputs.
- Finds all chart directories in a remote repository.
- Updates the version of the specified chart in all Chart.yaml and helmfile.yaml files where it is listed as a dependency.
- Creates or updates a dedicated branch for each change and opens or updates a PR with a summary of the update details.
- Uses only Node.js built-in modules and the official GitHub Actions toolkit.

## Inputs

| Name           | Description                                                      | Required | Default  |
| -------------- | ---------------------------------------------------------------- | -------- | -------- |
| `chart-name`   | Name of the dependency to update in Chart / helmfile yaml files. | true     |          |
| `version`      | New version to set for the dependency.                           | true     |          |
| `github-token` | GitHub token for authentication.                                 | true     |          |
| `target-repo`  | Target repository to open the PRs in (format: owner/repo).       | true     |          |
| `branch`       | Branch to base the PRs on (e.g. `master`).                       | false    | `master` |

## Usage

```yaml
- name: Update Helm Chart Dependencies
  uses: map-colonies/update-chart-dependency@v1
  with:
    chart-name: 'my-dependency'
    version: '1.2.3'
    github-token: ${{ secrets.GITHUB_TOKEN }}
    target-repo: 'owner/repo'
    branch: 'master'
```

## Notes

- The action updates only the version of the specified dependency in each chart's `Chart` and `helmfile` yaml files.
- The action opens or updates a dedicated branch and PR for each updated chart.
- If no charts require updating, no PR will be opened.

## License

MIT
