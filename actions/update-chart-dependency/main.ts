/**
 * @file Main entry for the Helm chart dependency update GitHub Action.
 * @description Updates Helm chart and helmfile YAML files for dependencies and opens PRs.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { getInput, setFailed, info, warning } from '@actions/core';
import { getOctokit } from '@actions/github';

/**
 * @typedef ActionInputs
 * @property {string} chartName - Name of the chart to update
 * @property {string} version - New version to set
 * @property {string} githubToken - GitHub token for authentication
 * @property {string} targetRepo - Target repository to open the PR in (format: owner/repo)
 * @property {string} targetChartPrefix - Prefix to filter chart directories
 * @property {string} branch - Base branch for the PR
 */
interface ActionInputs {
  readonly chartName: string;
  readonly version: string;
  readonly githubToken: string;
  readonly targetRepo: string;
  readonly branch: string;
}

/**
 * @typedef ChartDependency
 * @property {string} name - Dependency name
 * @property {string} version - Dependency version
 */
interface ChartDependency {
  [key: string]: unknown;
  name: string;
  version: string;
}

/**
 * @typedef ChartYaml
 * @property {ChartDependency[]} [dependencies] - List of chart dependencies
 */
interface ChartYaml {
  [key: string]: unknown;
  dependencies?: ChartDependency[];
}

/**
 * @typedef UpdateResult
 * @property {boolean} updated - Whether the file was updated
 * @property {string} [oldVersion] - Previous version
 * @property {string} [newContent] - Updated file content
 */
interface UpdateResult {
  updated: boolean;
  oldVersion?: string;
  newContent?: string;
}

/**
 * @typedef FileUpdate
 * @property {string} path - File path to update
 * @property {string} content - New file content
 * @property {string} [oldVersion] - Previous version (if available)
 * @returns {void}
 */
interface FileUpdate {
  path: string;
  content: string;
  oldVersion?: string;
}

/** @constant {string} CHART_FILE_NAME - Chart filename prefix */
const CHART_FILE_NAME = 'Chart' as const;
/** @constant {string} HELMFILE_NAME - Helmfile filename prefix */
const HELMFILE_NAME = 'helmfile' as const;
/** @constant {string} PR_TITLE_PREFIX - PR title prefix for pull requests */
const PR_TITLE_PREFIX = 'deps: update Helm dependencies: ' as const;
/** @constant {string} DEFAULT_BASE_BRANCH - Default base branch for PRs */
const DEFAULT_BASE_BRANCH = 'master' as const;

/**
 * @description Get action inputs from GitHub Actions runtime.
 * @returns {ActionInputs} Action inputs object
 */
function getInputs(): ActionInputs {
  const chartName = getInput('chart-name');
  const version = getInput('version');
  const githubToken = getInput('github-token');
  const targetRepo = getInput('target-repo');
  const branch = getInput('branch') || DEFAULT_BASE_BRANCH;
  return { chartName, version, githubToken, targetRepo, branch };
}

/**
 * Find Chart and helmfile YAML files for a given chart directory.
 * @param {string} workspace - Root workspace directory
 * @param {string} chartDir - Chart directory name
 * @returns {string[]} Absolute paths to Chart and helmfile YAML files (if they exist)
 */
function findChartFiles(workspace: string, chartDir: string): string[] {
  const files = [CHART_FILE_NAME, HELMFILE_NAME]
    .flatMap((name) => ['yaml', 'yml'].map((ext) => path.join(workspace, chartDir, `${name}.${ext}`)))
    .filter((file) => fs.existsSync(file));
  return files;
}

/**
 * Update dependency version for a given service in a Chart.yaml file.
 * @param {string} filePath - Path to Chart.yaml
 * @param {string} dependencyName - Dependency / service to update
 * @param {string} version - New version
 * @returns {UpdateResult} Update result object
 */
function updateChartYamlDependency(filePath: string, dependencyName: string, version: string): UpdateResult {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  let updated = false;
  let oldVersion: string | undefined;
  let chart: ChartYaml;

  try {
    chart = yaml.parse(fileContent) as ChartYaml;
  } catch {
    return { updated: false };
  }

  // If dependencies are not defined, there is nothing to update
  if (!Array.isArray(chart.dependencies) || chart.dependencies.length === 0) {
    return { updated: false };
  }

  for (const dep of chart.dependencies) {
    if (typeof dep.name === 'string' && typeof dep.version === 'string' && dep.name === dependencyName && dep.version !== version) {
      oldVersion = dep.version;
      dep.version = version;
      updated = true;
    }
  }
  if (!updated) {
    return { updated: false };
  }
  const newContent: string = yaml.stringify(chart);
  return { updated: true, oldVersion, newContent };
}

/**
 * Update release version for a given service in a helmfile.yaml file.
 * @param {string} filePath - Path to helmfile.yaml
 * @param {string} releaseName - Release / service to update
 * @param {string} version - New version
 * @returns {UpdateResult} Update result object
 */
function updateHelmfileReleaseVersion(filePath: string, releaseName: string, version: string): UpdateResult {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  let updated = false;
  let oldVersion: string | undefined;
  let helmfile: unknown;
  try {
    helmfile = yaml.parse(fileContent);
  } catch {
    return { updated: false };
  }
  if (typeof helmfile === 'object' && helmfile !== null && 'releases' in helmfile && Array.isArray((helmfile as { releases: unknown }).releases)) {
    for (const rel of (helmfile as { releases: unknown[] }).releases) {
      if (
        typeof rel === 'object' &&
        rel !== null &&
        'name' in rel &&
        typeof (rel as { name: unknown }).name === 'string' &&
        'version' in rel &&
        typeof (rel as { version: unknown }).version === 'string' &&
        (rel as { name: string }).name === releaseName &&
        (rel as { version: string }).version !== version
      ) {
        oldVersion = (rel as { version: string }).version;
        (rel as { version: string }).version = version;
        updated = true;
      }
    }
  }
  if (!updated) {
    return { updated: false };
  }
  const newContent: string = yaml.stringify(helmfile);
  return { updated: true, oldVersion, newContent };
}

/**
 * Collect all chart / helmfile file paths in the workspace, filtered by prefix.
 * @param {string} workspace - Workspace directory
 * @returns {{ chartDir: string; absFilePath: string }[]} Array of chart directory and file path objects
 */
function getChartFilesWithDirs(workspace: string): { chartDir: string; absFilePath: string }[] {
  /**
   * @description Use Dirent objects for robust directory listing
   * @see https://nodejs.org/api/fs.html#fsreaddirsyncpath-options
   */
  const chartDirents = fs.readdirSync(workspace, { withFileTypes: true });
  const chartFilesWithDirs: { chartDir: string; absFilePath: string }[] = [];
  for (const dirent of chartDirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const dir = typeof dirent.name === 'string' ? dirent.name : (dirent.name as Buffer).toString();
    const files = findChartFiles(workspace, dir);
    for (const absFilePath of files) {
      chartFilesWithDirs.push({ chartDir: dir, absFilePath });
    }

    const subDir = path.join(workspace, dir);
    const subChartFilesWithDirs = getChartFilesWithDirs(subDir).map((file) => ({
      chartDir: path.join(dir, file.chartDir),
      absFilePath: file.absFilePath,
    }));
    chartFilesWithDirs.push(...subChartFilesWithDirs);
  }
  return chartFilesWithDirs;
}

/**
 * Get the SHA of a file in a branch using the GitHub API.
 * @param {ReturnType<typeof getOctokit>} octokit - GitHub client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} path - File path
 * @param {string} branch - Branch name
 * @returns {Promise<string|undefined>} SHA string or undefined
 */
async function getFileSha(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    if ('sha' in data) {
      return data.sha;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a new branch from a base branch using the GitHub API.
 * @param {ReturnType<typeof getOctokit>} octokit - GitHub client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} baseBranch - Base branch name
 * @param {string} newBranch - New branch name
 * @returns {Promise<void>} Promise that resolves when branch is created
 */
async function createBranch(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  baseBranch: string,
  newBranch: string
): Promise<void> {
  // Get base branch ref
  const baseRef = `heads/${baseBranch}`;
  const { data: baseBranchData } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: baseRef,
  });
  const baseSha = baseBranchData.object.sha;
  // Create new branch ref
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${newBranch}`,
    sha: baseSha,
  });
}

/**
 * Update files in the new branch using the GitHub API.
 * @param {ReturnType<typeof getOctokit>} octokit - GitHub client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Branch name
 * @param {string} dependency - Dependency name
 * @param {string} newVersion - New version
 * @param {{ path: string; content: string }[]} fileUpdates - Array of file updates
 * @returns {Promise<void>} Promise that resolves when files are updated
 */
async function updateFilesInBranch(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  dependency: string,
  newVersion: string,
  fileUpdates: FileUpdate[]
): Promise<void> {
  for (const { path: filePath, content, oldVersion } of fileUpdates) {
    try {
      const fileSha = await getFileSha(octokit, owner, repo, filePath, branchName);
      const hasOldVersion = typeof oldVersion === 'string' && oldVersion.length > 0;
      const versionMsg = hasOldVersion ? `from version ${oldVersion} to ${newVersion}` : `to version ${newVersion}`;
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        message: `deps: update '${dependency}' ${versionMsg} in ${filePath}`,
        content: Buffer.from(content).toString('base64'),
        branch: branchName,
        sha: fileSha,
        committer: {
          name: 'github-actions[bot]',
          email: 'github-actions[bot]@users.noreply.github.com',
        },
        author: {
          name: 'github-actions[bot]',
          email: 'github-actions[bot]@users.noreply.github.com',
        },
      });
    } catch (err) {
      warning(`Failed to update file '${filePath}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Create a pull request using the GitHub API.
 * @param {ReturnType<typeof getOctokit>} octokit - GitHub client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Branch name
 * @param {string} dependencyName - Dependency name
 * @param {string} newVersion - New chart version
 * @param {string} baseBranch - Base branch name
 * @param {FileUpdate[]} fileUpdates - List of updated charts and their old versions
 * @returns {Promise<void>} Promise that resolves when PR is created
 */
async function createPullRequest(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  dependencyName: string,
  newVersion: string,
  baseBranch: string,
  fileUpdates: FileUpdate[]
): Promise<void> {
  /**
   * @description Compose a markdown list of updated charts and their old versions
   */

  const chartList = fileUpdates
    .map(({ path, oldVersion }) => {
      // Extract chart directory from path (format: chartDir/filename)
      const chart = path.split('/')[0];
      const oldVer = typeof oldVersion === 'string' && oldVersion.length > 0 ? ` (old version: ${oldVersion})` : '';
      return `- \`${chart}\`${oldVer}`;
    })
    .join('\n');

  const body = [`Update Helm chart dependency '\`${dependencyName}\`' to version \`${newVersion}\`.`, '', '### Updated charts:', chartList].join(
    '\n'
  );

  await octokit.rest.pulls.create({
    owner,
    repo,
    title: `${PR_TITLE_PREFIX}${dependencyName}`,
    head: branchName,
    base: baseBranch,
    body,
  });
}

/**
 * Main action runner for the update-chart-dependency GitHub Action.
 * @returns {Promise<void>} Promise that resolves when action completes
 */
async function run(): Promise<void> {
  try {
    const { chartName, version, githubToken, targetRepo, branch } = getInputs();

    const missingInputs = !chartName || !version || !githubToken || !targetRepo;
    if (missingInputs) {
      setFailed('Missing required inputs: chart-name, version, github-token, target-repo');
      return;
    }

    // Initialize GitHub API client
    const octokit = getOctokit(githubToken);

    // Parse targetRepo (format: owner/repo)
    const [owner, repo] = targetRepo.split('/');
    const isOwnerMissing = typeof owner !== 'string' || owner.trim() === '';
    const isRepoMissing = typeof repo !== 'string' || repo.trim() === '';
    if (isOwnerMissing || isRepoMissing) {
      setFailed('Invalid target-repo input. Must be in format owner/repo, both must be non-empty');
      return;
    }

    // Determine workspace directory (GitHub Actions or local)
    const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

    // Collect all chart/helmfile files to process
    const chartFilesWithDirs = getChartFilesWithDirs(workspace);

    if (chartFilesWithDirs.length === 0) {
      info(`No charts required updating for dependency '${chartName}'. No PR will be opened.`);
      return;
    }

    const fileUpdates: FileUpdate[] = [];
    const updatedCharts = new Set<string>();

    // Iterate over all chart / helmfile files and attempt to update dependency version
    for (const { chartDir, absFilePath } of chartFilesWithDirs) {
      try {
        const fileName = path.basename(absFilePath);
        const relFilePath = `${chartDir}/${fileName}`;
        let updateResult: UpdateResult;

        // Determine file type and call the appropriate update function
        if (fileName.includes(CHART_FILE_NAME)) {
          updateResult = updateChartYamlDependency(absFilePath, chartName, version);
        } else if (fileName.includes(HELMFILE_NAME)) {
          updateResult = updateHelmfileReleaseVersion(absFilePath, chartName, version);
        } else {
          continue;
        }

        const newContent = updateResult.newContent;
        // If the file was updated, stage it for commit and mark the chart as updated
        if (updateResult.updated && typeof newContent === 'string' && newContent.length > 0) {
          fileUpdates.push({ path: relFilePath, content: newContent, oldVersion: updateResult.oldVersion });
          updatedCharts.add(chartDir);
        }
      } catch (chartError) {
        warning(`Failed to process chart '${chartDir}': ${chartError instanceof Error ? chartError.message : ''}`);
      }
    }

    if (updatedCharts.size === 0) {
      info(`No charts required updating for dependency '${chartName}'. No PR will be opened.`);
      return;
    }

    // Open a PR for each updated chart directory separately
    for (const chartDir of updatedCharts) {
      // Filter fileUpdates for this chartDir
      const chartFileUpdates = fileUpdates.filter((fu) => fu.path.startsWith(`${chartDir}/`));
      if (chartFileUpdates.length === 0) {
        warning(`No file updates found for chart directory '${chartDir}', skipping PR.`);
        continue;
      }
      const branchName = `update-helm-chart-${chartName}-${version}-${chartDir}`;

      await createBranch(octokit, owner, repo, branch, branchName);
      await updateFilesInBranch(octokit, owner, repo, branchName, chartName, version, chartFileUpdates);
      await createPullRequest(octokit, owner, repo, branchName, chartName, version, branch, chartFileUpdates);
      info(`Successfully created PR to update dependency '${chartName}' to version ${version} in chart: ${chartDir}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    setFailed(`Action failed with error: ${errorMessage}`);
  }
}

export {
  run,
  getInputs,
  findChartFiles,
  updateChartYamlDependency,
  updateHelmfileReleaseVersion,
  getChartFilesWithDirs,
  getFileSha,
  createBranch,
  updateFilesInBranch,
  createPullRequest,
};

export type { ActionInputs };
