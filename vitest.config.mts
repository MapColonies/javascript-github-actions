import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, ViteUserConfig } from 'vitest/config';

const reporters: Exclude<ViteUserConfig['test'], undefined>['reporters'] = ['default', 'html'];

const isGitHubActions = process.env.GITHUB_ACTIONS;
if (isGitHubActions) {
  reporters.push('github-actions');
}

/**
 * Discovers actions with test folders and creates project configurations
 * @returns Array of project configurations for actions with tests
 */
const discoverActionProjects = (): Array<{ test: { name: string; include: string[]; environment: string } }> => {
  const actionsDir = path.join(process.cwd(), 'actions');
  const projects: Array<{ test: { name: string; include: string[]; environment: string } }> = [];

  const actionsExist = existsSync(actionsDir);
  if (!actionsExist) {
    return projects;
  }

  const actionFolders = readdirSync(actionsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  for (const actionName of actionFolders) {
    const actionTestsPath = path.join(actionsDir, actionName, 'tests');
    const hasTestFolder = existsSync(actionTestsPath);

    if (hasTestFolder) {
      projects.push({
        test: {
          name: `action-${actionName}`,
          include: [`actions/${actionName}/tests/**/*.spec.ts`],
          environment: 'node',
        },
      });
    }
  }

  return projects;
};

export default defineConfig({
  test: {
    projects: [...discoverActionProjects()],
    reporters,
    coverage: {
      enabled: true,
      provider: 'v8',

      reporter: ['text', 'html', 'json', 'json-summary'],
      include: ['actions/**/*.ts'],
      exclude: ['**/vendor/**', 'node_modules/**', '**/index.ts'],
      reportOnFailure: true,
      thresholds: {
        global: {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
