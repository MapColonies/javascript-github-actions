# jira-pull-request-integration

Helps connecting pull requests to jira including comments on the pull request and title validation

## Usage

```yaml
uses: map-colonies/javascript-github-actions/actions/jira-pull-request-integration@v1
with:
  # Add your inputs here
```

## Inputs

<!-- Add your action inputs here -->

## Outputs

<!-- Add your action outputs here -->

## Example

```yaml
name: Example workflow
on: [push]
jobs:
  example:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: map-colonies/javascript-github-actions/actions/jira-pull-request-integration@v1
```
