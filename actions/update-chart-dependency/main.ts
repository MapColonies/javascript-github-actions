/**
 * @file Main entry for the Helm chart dependency update GitHub Action.
 * @description Updates Chart and helmfile yaml files for Helm charts and opens PRs.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'yaml';
import { getInput, setFailed, info, warning } from '@actions/core';
import { getOctokit, context as githubContext } from '@actions/github';

/**
 * Inputs for the action inputs
 */
interface ActionInputs {
  readonly serviceName: string;
  readonly version: string;
  readonly githubToken: string;
  readonly chartPrefix: string;
  readonly branch: string;
}

/**
 * @description Helm chart dependency object
 * @param filePath - path to file
 * @param dependencyName - name of the dependency / service to update
 * @param version - new version
 * @returns UpdateResult
 */
interface ChartDependency {
  [key: string]: unknown;
  name: string;
  version: string;
}

/**
 * Helm Chart structure
 */
interface ChartYaml {
  [key: string]: unknown;
  dependencies?: ChartDependency[];
}

/**
 * Result of file update
 */
interface UpdateResult {
  updated: boolean;
  oldVersion?: string;
  newVersion?: string;
  newContent?: string;
}

/**
 * @constant CHART_FILE_NAME - Chart filename
 */
const CHART_FILE_NAME = 'Chart' as const;
/**
 * @constant HELMFILE_NAME - helmfile filename
 */
const HELMFILE_NAME = 'helmfile' as const;
/**
 * @constant PR_TITLE_PREFIX - PR title prefix
 */
const PR_TITLE_PREFIX = 'deps: update Helm chart dependencies: ' as const;
/**
 * @constant DEFAULT_BASE_BRANCH - Default base branch for PR
 */
const DEFAULT_BASE_BRANCH = 'master' as const;

/**
 * @description Get action inputs from core
 * @returns ActionInputs
 */
function getInputs(): ActionInputs {
  const serviceName = getInput('service-name');
  const version = getInput('version');
  const githubToken = getInput('github-token');
  const chartPrefix = getInput('chart-prefix');
  const branch = getInput('branch') || DEFAULT_BASE_BRANCH;
  return { serviceName, version, githubToken, chartPrefix, branch };
}

/**
 * @description Find Chart and helmfile yaml files for the given chart directory
 * @param chartDir - chart directory name
 * @returns absolute paths to Chart and helmfile yaml files (if exist)
 */
function findChartFiles(workspace: string, chartDir: string): string[] {
  const files: string[] = [];

  [CHART_FILE_NAME, HELMFILE_NAME].forEach((name) => {
    ['yaml', 'yml'].forEach((ext) => {
      const file = path.join(workspace, chartDir, `${name}.${ext}`);
      if (fs.existsSync(file)) {
        files.push(file);
      }
    });
  });

  return files;
}

/**
 * @description Update dependency version for a given service in Chart yaml file
 * @param filePath - path to file
 * @param dependencyName - name of the dependency / service to update
 * @param version - new version
 * @returns UpdateResult
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
  if (Array.isArray(chart.dependencies)) {
    for (const dep of chart.dependencies) {
      if (typeof dep.name === 'string' && typeof dep.version === 'string' && dep.name === dependencyName && dep.version !== version) {
        oldVersion = dep.version;
        dep.version = version;
        updated = true;
      }
    }
  }
  if (!updated) {
    return { updated: false };
  }
  const newContent: string = yaml.stringify(chart);
  return { updated: true, oldVersion, newVersion: version, newContent };
}

/**
 * @description Update release version for a given service in helmfile yaml file
 * @param filePath - path to helmfile.yaml
 * @param releaseName - name of the release/service to update
 * @param version - new version
 * @returns UpdateResult
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
  return { updated: true, oldVersion, newVersion: version, newContent };
}

/**
 * @description Collect all chart / helmfile file paths
 * @param workspace - workspace directory
 * @param chartPrefix - chart directory prefix filter
 * @returns Array of { chartDir, absFilePath }
 */
function getChartFilesWithDirs(workspace: string, chartPrefix: string): { chartDir: string; absFilePath: string }[] {
  /**
   * @description Use Dirent objects for robust directory listing
   * @see https://nodejs.org/api/fs.html#fsreaddirsyncpath-options
   */
  const chartDirents = fs.readdirSync(workspace, { withFileTypes: true });
  const chartFilesWithDirs: { chartDir: string; absFilePath: string }[] = [];
  for (const dirent of chartDirents) {
    if (!dirent.isDirectory()) continue;
    const dir = typeof dirent.name === 'string' ? dirent.name : (dirent.name as Buffer).toString();
    const hasPrefix = chartPrefix === '' || dir.startsWith(chartPrefix);
    if (!hasPrefix) continue;
    const files = findChartFiles(workspace, dir);
    for (const absFilePath of files) {
      chartFilesWithDirs.push({ chartDir: dir, absFilePath });
    }
  }
  return chartFilesWithDirs;
}

/**
 * @description Get the SHA of a file in a branch
 * @param octokit - github client
 * @param owner - repo owner
 * @param repo - repo name
 * @param path - file path
 * @param branch - branch name
 * @returns SHA string or undefined
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
 * @description Create a new branch from base branch using GitHub API
 * @param octokit - github client
 * @param owner - repo owner
 * @param repo - repo name
 * @param baseBranch - base branch name
 * @param newBranch - new branch name
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
 * @description Update files in the new branch using GitHub API
 * @param octokit - github client
 * @param owner - repo owner
 * @param repo - repo name
 * @param branchName - branch name
 * @param fileUpdates - array of { path, content }
 */
async function updateFilesInBranch(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  dependency: string,
  version: string,
  fileUpdates: { path: string; content: string }[]
): Promise<void> {
  for (const { path: filePath, content } of fileUpdates) {
    const fileSha = await getFileSha(octokit, owner, repo, filePath, branchName);
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: `deps: update '${dependency}' to version ${version} in ${filePath}`,
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
  }
}

/**
 * @description Create a pull request using GitHub API
 * @param octokit - github client
 * @param owner - repo owner
 * @param repo - repo name
 * @param branchName - branch name
 * @param chartsUpdated - list of chart directories updated
 * @param dependencyName - dependency name
 * @param newVersion - new chart version
 * @param baseBranch - base branch name
 */
async function createPullRequest(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  chartsUpdated: string[],
  dependencyName: string,
  newVersion: string,
  baseBranch: string
): Promise<void> {
  await octokit.rest.pulls.create({
    owner,
    repo,
    title: `${PR_TITLE_PREFIX}${dependencyName}`,
    head: branchName,
    base: baseBranch,
    body: `Update Helm chart dependency '${dependencyName}' to version ${newVersion} in charts: ${chartsUpdated.join(', ')}.`,
  });
}

/**
 * @description Main action runner
 * @returns Promise<void>
 */
export async function run(): Promise<void> {
  try {
    const { serviceName, version, githubToken, chartPrefix, branch } = getInputs();

    const missingInputs = !serviceName || !version || !githubToken;
    if (missingInputs) {
      setFailed('Missing required inputs: service-name, version, github-token');
      return;
    }

    // Initialize GitHub API client and repo context
    const octokit = getOctokit(githubToken);
    const { owner, repo } = githubContext.repo;

    // Determine workspace directory (GitHub Actions or local)
    const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

    // Collect all chart/helmfile files to process, filtered by prefix if provided
    const chartFilesWithDirs = getChartFilesWithDirs(workspace, chartPrefix);

    if (chartFilesWithDirs.length === 0) {
      info(`No charts required updating for dependency '${serviceName}'. No PR will be opened.`);
      return;
    }

    const fileUpdates: { path: string; content: string }[] = [];
    const updatedCharts = new Set<string>();

    // Iterate over all chart / helmfile files and attempt to update dependency version
    for (const { chartDir, absFilePath } of chartFilesWithDirs) {
      try {
        const fileName = path.basename(absFilePath);
        const relFilePath = `${chartDir}/${fileName}`;
        let updateResult: UpdateResult;

        // Determine file type and call the appropriate update function
        if (fileName.includes(CHART_FILE_NAME)) {
          updateResult = updateChartYamlDependency(absFilePath, serviceName, version);
        } else if (fileName.includes(HELMFILE_NAME)) {
          updateResult = updateHelmfileReleaseVersion(absFilePath, serviceName, version);
        } else {
          continue;
        }

        const newContent = updateResult.newContent;
        // If the file was updated, stage it for commit and mark the chart as updated
        if (updateResult.updated && typeof newContent === 'string' && newContent.length > 0) {
          fileUpdates.push({ path: relFilePath, content: newContent });
          updatedCharts.add(chartDir);
        }
      } catch (chartError) {
        warning(`Failed to process chart '${chartDir}': ${chartError instanceof Error ? chartError.message : ''}`);
      }
    }

    if (updatedCharts.size === 0) {
      info(`No charts required updating for dependency '${serviceName}'. No PR will be opened.`);
      return;
    }

    // Compose PR branch name and label (include prefix if provided)
    const chartsLabel = chartPrefix ? `-${chartPrefix}*` : '';
    const branchName = `update-helm-chart${chartsLabel}-${serviceName}-${version}`;

    await createBranch(octokit, owner, repo, branch, branchName);
    await updateFilesInBranch(octokit, owner, repo, branchName, serviceName, version, fileUpdates);
    await createPullRequest(octokit, owner, repo, branchName, Array.from(updatedCharts), serviceName, version, branch);

    info(`Successfully created PR to update dependency '${serviceName}' to version ${version} in charts: ${Array.from(updatedCharts).join(', ')}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    setFailed(`Action failed with error: ${errorMessage}`);
  }
}

export { getFileSha, updateChartYamlDependency, updateHelmfileReleaseVersion, getChartFilesWithDirs };
