import * as core from '@actions/core';
import * as github from '@actions/github';
/**
 * Main function that executes the GitHub action
 * @returns Promise<void>
 */
export async function run() {
    try {
        // Get the greeting input from action.yaml
        const greetingInput = core.getInput('greeting');
        const greeting = greetingInput || 'Hello';
        // Check if greeting is the forbidden value
        const isForbiddenGreeting = greeting === 'avi';
        if (isForbiddenGreeting) {
            core.setFailed('Action failed: greeting cannot be "avi"');
            return;
        }
        // Get the GitHub token from environment
        const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
        if (token === undefined || token === '') {
            core.setFailed('GitHub token is required');
            return;
        }
        // Create GitHub client
        const octokit = github.getOctokit(token);
        // Get context information
        const context = github.context;
        const { owner, repo } = context.repo;
        // Check if this is a pull request event
        const isPullRequest = context.eventName === 'pull_request';
        if (!isPullRequest) {
            core.warning('This action is designed to work with pull request events');
            return;
        }
        const prNumber = context.issue.number;
        // Create comment on the PR
        await octokit.rest.issues.createComment({
            owner,
            repo,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            issue_number: prNumber,
            body: greeting,
        });
        core.info(`Successfully commented on PR #${prNumber} with greeting: "${greeting}"`);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        core.setFailed(`Action failed with error: ${errorMessage}`);
    }
}
