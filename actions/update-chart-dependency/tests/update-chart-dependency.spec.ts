import fs from 'fs';
import yaml from 'yaml';
import { describe, it, expect, vi, beforeEach, MockInstance } from 'vitest';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  run,
  getFileSha,
  updateFilesInBranch,
  updateChartYamlDependency,
  updateHelmfileReleaseVersion,
  getChartFilesWithDirs,
  getVersionFromChartYaml,
  getVersionFromHelmfileYaml,
  shouldUpdateBranch,
  getExistingVersionInBranch,
  downloadRepoDir,
  createBranch,
  createPullRequest,
} from '../main.js';
import type { ActionInputs } from '../main.js';
// Helper type for octokit mock
interface MockOctokit {
  rest: Record<string, Record<string, unknown>>;
}

vi.mock('@actions/core');
vi.mock('@actions/github');
vi.mock('fs');

function makeDirent(name: string, isDir = true): fs.Dirent<Buffer> {
  return {
    name: Buffer.from(name),
    parentPath: '',
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

/**
 * @description Helper to mock getInput
 */
const createMockGetInput = (inputs: Partial<ActionInputs> = {}) => {
  return (name: string): string => {
    switch (name) {
      case 'chart-name':
        return inputs.chartName ?? 'test-service';
      case 'version':
        return inputs.version ?? '1.2.3';
      case 'github-token':
        return inputs.githubToken ?? 'ghp_testtoken';
      case 'target-repo':
        return inputs.targetRepo ?? 'test-owner/test-repo';
      case 'branch':
        return inputs.branch ?? 'master';
      default:
        return '';
    }
  };
};

/**
 * @description Setup GitHub context
 */
const setupGitHubContext = () => {
  Object.defineProperty(github, 'context', {
    value: {
      repo: { owner: 'test-owner', repo: 'test-repo' },
    },
    configurable: true,
  });
};

describe('update-chart-dependency Action', () => {
  let mockGetInput: ReturnType<typeof vi.fn>;
  let mockSetFailed: ReturnType<typeof vi.fn>;
  let mockInfo: ReturnType<typeof vi.fn>;
  let mockWarning: ReturnType<typeof vi.fn>;
  let mockGetOctokit: ReturnType<typeof vi.fn>;
  let readFileSyncSpy: MockInstance;
  let readDirSyncSpy: MockInstance;
  let existsSyncSpy: MockInstance;
  let tempDir: string;
  let yamlContent: string;

  /**
   * @description Helper to mock readDirSync for flat chart directories
   * @param {string[]} chartDirs - List of chart directory names
   */
  function mockFlatChartDirs(chartDirs: string[]): void {
    readDirSyncSpy.mockImplementation((dirPath: string) => {
      if (dirPath === tempDir) {
        return chartDirs.map((name) => makeDirent(name));
      }
      // No subdirectories
      return [];
    });
  }

  /**
   * @description Helper to mock existsSync for flat chart directories
   * @param {string[]} chartDirs - List of chart directory names
   * @param {string[]} fileNames - List of file names to exist in each chart directory
   */
  function mockFlatChartExists(chartDirs: string[], fileNames: string[]): void {
    existsSyncSpy.mockImplementation((filePath: fs.PathLike) => {
      if (typeof filePath === 'string') {
        return chartDirs.some((dir) => fileNames.some((file) => filePath === `${tempDir}/${dir}/${file}`));
      }
      return false;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInput = vi.fn(createMockGetInput());
    mockSetFailed = vi.fn();
    mockInfo = vi.fn();
    mockWarning = vi.fn();
    mockGetOctokit = vi.fn(() => ({
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
          createRef: vi.fn().mockResolvedValue({}),
        },
        repos: {
          getContent: vi.fn().mockResolvedValue({ data: { sha: 'file-sha' } }),
          createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
        },
        pulls: {
          create: vi.fn().mockResolvedValue({}),
        },
      },
    }));

    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    readDirSyncSpy = vi.spyOn(fs, 'readdirSync');
    existsSyncSpy = vi.spyOn(fs, 'existsSync');

    // Simulate temp directory for the downloaded repo
    tempDir = '/tmp/chart-repo-test';

    const chartObj = {
      apiVersion: 'v2',
      name: 'chart',
      version: '1.0.0',
      dependencies: [
        {
          name: 'test-service',
          version: '0.0.1',
          repository: 'https://example.com/charts',
        },
      ],
    };
    yamlContent = yaml.stringify(chartObj);

    vi.spyOn(fs, 'mkdtempSync').mockReturnValue(tempDir);
    vi.stubGlobal('fs', fs);
    (core.getInput as unknown) = mockGetInput;
    (core.setFailed as unknown) = mockSetFailed;
    (core.info as unknown) = mockInfo;
    (core.warning as unknown) = mockWarning;
    (github.getOctokit as unknown) = mockGetOctokit;
    setupGitHubContext();
  });

  describe('updateChartYamlDependency', () => {
    it('should update dependency version in Chart.yaml', () => {
      // Valid Chart.yaml with test-service at version 0.0.1
      const chartObj = {
        dependencies: [{ name: 'test-service', version: '0.0.1' }],
      };
      const yamlContent = yaml.stringify(chartObj);
      readFileSyncSpy.mockReturnValue(yamlContent);
      const result = updateChartYamlDependency('/fake/path/Chart.yaml', 'test-service', '1.2.3');
      expect(result.updated).toBe(true);
      expect(result.oldVersion).toBe('0.0.1');
      expect(result.newContent).toContain('version: 1.2.3');
    });

    it('should not update if dependency version matches', () => {
      const chartObj = {
        dependencies: [{ name: 'test-service', version: '1.2.3' }],
      };
      const yamlContent = yaml.stringify(chartObj);
      readFileSyncSpy.mockReturnValue(yamlContent);
      const result = updateChartYamlDependency('/fake/path/Chart.yaml', 'test-service', '1.2.3');
      expect(result.updated).toBe(false);
    });

    it('should return updated: false for invalid YAML', () => {
      readFileSyncSpy.mockReturnValue('invalid: : yaml');
      const result = updateChartYamlDependency('/fake/path/Chart.yaml', 'test-service', '1.2.3');
      expect(result.updated).toBe(false);
    });

    it('should return updated: false if dependencies are not defined', () => {
      // Chart.yaml with no dependencies key
      const chartObj = { apiVersion: 'v2', name: 'chart', version: '1.0.0' };
      readFileSyncSpy.mockReturnValue(yaml.stringify(chartObj));
      const result = updateChartYamlDependency('/fake/path/Chart.yaml', 'test-service', '1.2.3');
      expect(result.updated).toBe(false);
    });

    it('should return updated: false if dependencies is an empty array', () => {
      // Chart.yaml with empty dependencies
      const chartObj = { apiVersion: 'v2', name: 'chart', version: '1.0.0', dependencies: [] };
      readFileSyncSpy.mockReturnValue(yaml.stringify(chartObj));
      const result = updateChartYamlDependency('/fake/path/Chart.yaml', 'test-service', '1.2.3');
      expect(result.updated).toBe(false);
    });
  });

  describe('updateHelmfileReleaseVersion', () => {
    it('should update release version in helmfile.yaml', () => {
      const helmfileObj = {
        releases: [{ name: 'test-service', version: '0.0.1', chart: 'repo/chart' }],
      };
      const yamlContent = yaml.stringify(helmfileObj);
      readFileSyncSpy.mockReturnValue(yamlContent);
      const result = updateHelmfileReleaseVersion('/fake/path/helmfile.yaml', 'test-service', '2.0.0');
      expect(result.updated).toBe(true);
      expect(result.oldVersion).toBe('0.0.1');
      expect(result.newContent).toContain('version: 2.0.0');
    });

    it('should not update if release version matches', () => {
      const helmfileObj = {
        releases: [{ name: 'test-service', version: '2.0.0' }],
      };
      const yamlContent = yaml.stringify(helmfileObj);
      readFileSyncSpy.mockReturnValue(yamlContent);
      const result = updateHelmfileReleaseVersion('/fake/path/helmfile.yaml', 'test-service', '2.0.0');
      expect(result.updated).toBe(false);
    });

    it('should return updated: false for invalid YAML', () => {
      readFileSyncSpy.mockReturnValue('bad: : yaml');
      const result = updateHelmfileReleaseVersion('/fake/path/helmfile.yaml', 'test-service', '2.0.0');
      expect(result.updated).toBe(false);
    });
  });

  it('should create branch and PR for nested chart directories when branch does not exist', async () => {
    const tempDir = '/tmp';
    const nestedDir = 'nested/dir/chart';
    const absFilePath = `${tempDir}/${nestedDir}/Chart.yaml`;
    const sanitizedFilePath = `${nestedDir.split('/').join('-')}-Chart`;
    const expectedBranchName = `update-helm-chart-test-service-1.2.3-${sanitizedFilePath}`;
    // Mock directory reading to return the nested structure
    vi.spyOn(fs, 'readdirSync').mockImplementation((dirPath: fs.PathLike) => {
      const dirStr = Buffer.isBuffer(dirPath) ? dirPath.toString() : dirPath;
      if (dirStr === tempDir) return [makeDirent('nested')];
      if (dirStr === `${tempDir}/nested`) return [makeDirent('dir')];
      if (dirStr === `${tempDir}/nested/dir`) return [makeDirent('chart')];
      if (dirStr === `${tempDir}/nested/dir/chart`) return [];
      return [];
    });
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath: fs.PathLike) => filePath === absFilePath);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      // Chart.yaml has old version, so update/PR should be triggered
      if (filePath === absFilePath) {
        return yaml.stringify({ dependencies: [{ name: 'test-service', version: '0.0.1' }] });
      }
      return '';
    });
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({});
    const createBranch = vi.fn().mockResolvedValue({});
    const createPullRequest = vi.fn().mockResolvedValue({});
    // getRef throws for the expected branch name (branch does not exist)
    const getRefMock = vi.fn(({ ref }: { ref: string }) => {
      // throw new Error('Branch not found');
      if (ref === `heads/${expectedBranchName}`) throw new Error('Branch not found');
      return { data: { object: { sha: 'base-sha' } } };
    });
    mockGetOctokit = vi.fn(() => ({
      rest: {
        git: { getRef: getRefMock, createRef: createBranch },
        repos: { getContent: vi.fn().mockResolvedValue({ data: { sha: 'file-sha' } }), createOrUpdateFileContents },
        pulls: { create: createPullRequest },
      },
    }));
    (github.getOctokit as unknown) = mockGetOctokit;
    vi.spyOn(fs, 'mkdtempSync').mockReturnValue(tempDir);
    await run();

    // Assert: Branch and PR should be created for nested chart
    const unsanitizedFilePath = `${nestedDir}/Chart`;
    expect(createBranch).toHaveBeenCalledWith(expect.objectContaining({ ref: `refs/heads/${expectedBranchName}` }));
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        head: expectedBranchName,
        title: `deps: update Helm dependency test-service in chart ${unsanitizedFilePath}`,
        body: `Update Helm chart dependency \`test-service\` to version \`1.2.3\`.\n\n### Updated charts:\n- \`${unsanitizedFilePath}\` (old version: \`0.0.1\`)`,
      })
    );
  });

  it('should not create branch or PR for nested chart directories when branch already exists', async () => {
    const tempDir = '/tmp';
    const nestedDir = 'nested/dir/chart';
    const absFilePath = `${tempDir}/${nestedDir}/Chart.yaml`;
    // const sanitizedFilePath = `${nestedDir.split('/').join('-')}-Chart`;
    // const expectedBranchName = `update-helm-chart-test-service-1.2.3-${sanitizedFilePath}`;

    vi.spyOn(fs, 'readdirSync').mockImplementation((dirPath: fs.PathLike) => {
      const dirStr = Buffer.isBuffer(dirPath) ? dirPath.toString() : dirPath;
      if (dirStr === tempDir) return [makeDirent('nested')];
      if (dirStr === `${tempDir}/nested`) return [makeDirent('dir')];
      if (dirStr === `${tempDir}/nested/dir`) return [makeDirent('chart')];
      if (dirStr === `${tempDir}/nested/dir/chart`) return [];
      return [];
    });
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath: fs.PathLike) => filePath === absFilePath);
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      // Chart.yaml already has the requested version, so no update/PR should be created
      if (filePath === absFilePath) {
        return yaml.stringify({ dependencies: [{ name: 'test-service', version: '1.2.3' }] });
      }
      return '';
    });

    const createOrUpdateFileContents = vi.fn().mockResolvedValue({});
    const createBranch = vi.fn().mockResolvedValue({});
    const createPullRequest = vi.fn().mockResolvedValue({});
    // getRef resolves for the expected branch name
    const getRefMock = vi.fn(() => {
      return { data: { object: { sha: 'base-sha' } } };
    });
    mockGetOctokit = vi.fn(() => ({
      rest: {
        git: { getRef: getRefMock, createRef: createBranch },
        repos: { getContent: vi.fn().mockResolvedValue({ data: { sha: 'file-sha' } }), createOrUpdateFileContents },
        pulls: { create: createPullRequest },
      },
    }));
    (github.getOctokit as unknown) = mockGetOctokit;
    vi.spyOn(fs, 'mkdtempSync').mockReturnValue(tempDir);

    await run();

    // Assert: Branch and PR should NOT be created for nested chart
    expect(createBranch).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it('should fail if required inputs are missing', async () => {
    mockGetInput = vi.fn(createMockGetInput({ chartName: '', version: '', githubToken: '', targetRepo: '' }));
    (core.getInput as unknown) = mockGetInput;
    await run();
    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Invalid action inputs:'));
  });

  it('should fail if target-repo is not in owner/repo format (missing slash)', async () => {
    mockGetInput = vi.fn(createMockGetInput({ targetRepo: 'invalidrepo' }));
    (core.getInput as unknown) = mockGetInput;
    await run();
    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Invalid action inputs:'));
  });

  it('should fail if target-repo is empty owner', async () => {
    mockGetInput = vi.fn(createMockGetInput({ targetRepo: '/repo' }));
    (core.getInput as unknown) = mockGetInput;
    await run();
    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Invalid action inputs:'));
  });

  it('should fail if target-repo is empty repo', async () => {
    mockGetInput = vi.fn(createMockGetInput({ targetRepo: 'owner/' }));
    (core.getInput as unknown) = mockGetInput;
    await run();
    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Invalid action inputs:'));
  });

  it('should not open PR if no charts require updating', async () => {
    mockFlatChartDirs(['chart']);
    mockFlatChartExists(['chart'], ['Chart.yaml']);
    readFileSyncSpy.mockReturnValue('dependencies:\n  - name: test-service\n    version: 1.2.3');
    await run();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('No charts required updating'));
  });

  it('should emit info message when no charts are found in the repo', async () => {
    // Simulate no chart directories found
    readDirSyncSpy.mockReturnValue([]);
    existsSyncSpy.mockReturnValue(false);
    await run();
    expect(mockInfo).toHaveBeenCalledWith('No charts found in test-owner/test-repo.');
  });

  it('should execute without error if getFileSha returns undefined', async () => {
    // Arrange
    const octokit = {
      rest: {
        repos: {
          getContent: vi.fn().mockResolvedValue({ data: {} }), // No sha property
          createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
        },
      },
    } as unknown as Parameters<typeof updateFilesInBranch>[0];
    const owner = 'test-owner';
    const repo = 'test-repo';
    const branchName = 'test-branch';
    const dependency = 'test-dep';
    const newVersion = '2.0.0';
    const fileUpdates = [{ path: 'chartA/Chart.yaml', content: 'content', oldVersion: '1.0.0' }];
    await updateFilesInBranch(octokit, owner, repo, branchName, dependency, newVersion, fileUpdates);
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('should create a PR for each updated chart directory', async () => {
    mockFlatChartDirs(['chartA', 'chartB']);
    mockFlatChartExists(['chartA', 'chartB'], ['Chart.yaml']);
    readFileSyncSpy.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      if (typeof filePath === 'string' && filePath.endsWith('Chart.yaml')) {
        return yamlContent;
      }
      return '';
    });
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({});
    const createPullRequest = vi.fn().mockResolvedValue({});
    mockGetOctokit = vi.fn(() => ({
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
          createRef: vi.fn().mockResolvedValue({}),
        },
        repos: {
          getContent: vi.fn().mockResolvedValue({ data: { sha: 'file-sha' } }),
          createOrUpdateFileContents,
        },
        pulls: {
          create: createPullRequest,
        },
      },
    }));
    (github.getOctokit as unknown) = mockGetOctokit;
    await run();
    expect(mockGetOctokit).toHaveBeenCalledWith('ghp_testtoken');
    // Should create PR for each chart directory
    expect(createPullRequest).toHaveBeenCalledTimes(2);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining("Successfully created PR to update dependency 'test-service' to version 1.2.3 in chart 'chartA'")
    );
  });

  it('should warn if chart processing fails', async () => {
    mockFlatChartDirs(['chart']);
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockImplementation(() => {
      throw new Error('read error');
    });
    await run();
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Failed to process chart'));
  });

  it('should return undefined from getFileSha on error', async () => {
    const octokit = {
      rest: {
        repos: {
          getContent: vi.fn().mockRejectedValue(new Error('fail')),
        },
      },
    } as unknown as Parameters<typeof getFileSha>[0];
    const sha = await getFileSha(octokit, 'owner', 'repo', 'path', 'branch');
    expect(sha).toBeUndefined();
  });

  it('should call setFailed in run catch block', async () => {
    mockGetInput = vi.fn(() => {
      throw new Error('forced error');
    });
    (core.getInput as unknown) = mockGetInput;
    await run();
    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('forced error'));
  });

  it('should return chart and helmfile paths for matching directories', () => {
    mockFlatChartDirs(['chart']);
    existsSyncSpy.mockImplementation((filePath: fs.PathLike) => {
      if (typeof filePath === 'string') {
        // Simulate all four file types exist
        return (
          filePath.endsWith('Chart.yaml') || filePath.endsWith('Chart.yml') || filePath.endsWith('helmfile.yaml') || filePath.endsWith('helmfile.yml')
        );
      }
      return false;
    });
    const result = getChartFilesWithDirs(tempDir);
    expect(result).toEqual([
      { chartDir: 'chart', absFilePath: `${tempDir}/chart/Chart.yaml` },
      { chartDir: 'chart', absFilePath: `${tempDir}/chart/Chart.yml` },
      { chartDir: 'chart', absFilePath: `${tempDir}/chart/helmfile.yaml` },
      { chartDir: 'chart', absFilePath: `${tempDir}/chart/helmfile.yml` },
    ]);
  });

  it('should return empty array if no directories match', () => {
    readDirSyncSpy.mockReturnValue([]);
    const result = getChartFilesWithDirs(tempDir);
    expect(result).toEqual([]);
  });

  it('should skip non-directories', () => {
    const mockDirent = makeDirent('file.txt', false);
    readDirSyncSpy.mockReturnValue([mockDirent]);
    const result = getChartFilesWithDirs(tempDir);
    expect(result).toEqual([]);
  });

  it('should include old and new version in commit message for each chart PR', async () => {
    mockFlatChartDirs(['chartA', 'chartB']);
    mockFlatChartExists(['chartA', 'chartB'], ['Chart.yaml']);
    readFileSyncSpy.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      if (typeof filePath === 'string' && filePath.endsWith('Chart.yaml')) {
        return yamlContent;
      }
      return '';
    });
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({});
    const createPullRequest = vi.fn().mockResolvedValue({});
    mockGetOctokit = vi.fn(() => ({
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
          createRef: vi.fn().mockResolvedValue({}),
        },
        repos: {
          getContent: vi.fn().mockResolvedValue({ data: { sha: 'file-sha' } }),
          createOrUpdateFileContents,
        },
        pulls: {
          create: createPullRequest,
        },
      },
    }));
    (github.getOctokit as unknown) = mockGetOctokit;
    await run();
    // Should include old and new version in commit message for each chart
    expect(createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('deps: update `test-service` from version 0.0.1 to 1.2.3 in `chartA/Chart.yaml`') as unknown as string,
      })
    );
  });

  it('should include old version in PR body for each updated chart', async () => {
    mockFlatChartDirs(['chartA', 'chartB']);
    mockFlatChartExists(['chartA', 'chartB'], ['Chart.yaml']);
    readFileSyncSpy.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      if (typeof filePath === 'string' && filePath.endsWith('Chart.yaml')) {
        return yamlContent;
      }
      return '';
    });
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({});
    const createPullRequest = vi.fn().mockResolvedValue({});
    mockGetOctokit = vi.fn(() => ({
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
          createRef: vi.fn().mockResolvedValue({}),
        },
        repos: {
          getContent: vi.fn().mockResolvedValue({ data: { sha: 'file-sha' } }),
          createOrUpdateFileContents,
        },
        pulls: {
          create: createPullRequest,
        },
      },
    }));
    (github.getOctokit as unknown) = mockGetOctokit;
    await run();
    // The PR body should include the old version and only a single chart per PR
    expect(createPullRequest).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const prCall = createPullRequest.mock.calls[i]?.[0] as { body: string; title: string };
      expect(prCall).toBeDefined();
      const chartLetter = i === 0 ? 'A' : 'B';
      const filePath = `chart${chartLetter}/Chart`;
      const expectedBody = `Update Helm chart dependency \`test-service\` to version \`1.2.3\`.\n\n### Updated charts:\n- \`${filePath}\` (old version: \`0.0.1\`)`;
      expect(prCall.body).toBe(expectedBody);
      expect(prCall.title).toBe(`deps: update Helm dependency test-service in chart ${filePath}`);
    }
  });

  it('should return chart and helmfile paths for nested directories recursively', () => {
    // Simulate nested directory structure
    const mockDirentChart = makeDirent('chart');
    const mockDirentNested = makeDirent('nested');
    const mockDirentSubchart = makeDirent('subchart');
    readDirSyncSpy.mockImplementation((dirPath: string) => {
      if (dirPath === tempDir) {
        return [mockDirentChart, mockDirentNested];
      }
      if (dirPath === `${tempDir}/nested`) {
        return [mockDirentSubchart];
      }
      // subchart contains files
      if (dirPath === `${tempDir}/nested/subchart`) {
        return [];
      }
      // chart contains files
      if (dirPath === `${tempDir}/chart`) {
        return [];
      }
      return [];
    });
    existsSyncSpy.mockImplementation((filePath: fs.PathLike) => {
      if (typeof filePath === 'string') {
        return (
          filePath === `${tempDir}/chart/Chart.yaml` ||
          filePath === `${tempDir}/chart/helmfile.yaml` ||
          filePath === `${tempDir}/nested/subchart/Chart.yaml` ||
          filePath === `${tempDir}/nested/subchart/helmfile.yaml`
        );
      }
      return false;
    });
    const result = getChartFilesWithDirs(tempDir);
    expect(result).toEqual([
      { chartDir: 'chart', absFilePath: `${tempDir}/chart/Chart.yaml` },
      { chartDir: 'chart', absFilePath: `${tempDir}/chart/helmfile.yaml` },
      { chartDir: 'nested/subchart', absFilePath: `${tempDir}/nested/subchart/Chart.yaml` },
      { chartDir: 'nested/subchart', absFilePath: `${tempDir}/nested/subchart/helmfile.yaml` },
    ]);
  });

  describe('getVersionFromChartYaml', () => {
    it('should extract the correct version for a matching dependency', () => {
      const chartObj = {
        dependencies: [
          { name: 'test-service', version: '1.2.3' },
          { name: 'other', version: '0.0.1' },
        ],
      };
      const yamlContent = yaml.stringify(chartObj);
      expect(getVersionFromChartYaml(yamlContent, 'test-service')).toBe('1.2.3');
      expect(getVersionFromChartYaml(yamlContent, 'other')).toBe('0.0.1');
    });

    it('should return undefined if dependency is not found', () => {
      const chartObj = {
        dependencies: [{ name: 'test-service', version: '1.2.3' }],
      };
      const yamlContent = yaml.stringify(chartObj);
      expect(getVersionFromChartYaml(yamlContent, 'missing')).toBeUndefined();
    });

    it('should return undefined for invalid YAML', () => {
      expect(getVersionFromChartYaml('bad: : yaml', 'test-service')).toBeUndefined();
    });
  });

  describe('getVersionFromHelmfileYaml', () => {
    it('should extract the correct version for a matching release', () => {
      const helmfileObj = {
        releases: [
          { name: 'test-service', version: '2.0.0' },
          { name: 'other', version: '0.0.1' },
        ],
      };
      const yamlContent = yaml.stringify(helmfileObj);
      expect(getVersionFromHelmfileYaml(yamlContent, 'test-service')).toBe('2.0.0');
      expect(getVersionFromHelmfileYaml(yamlContent, 'other')).toBe('0.0.1');
    });

    it('should return undefined if release is not found', () => {
      const helmfileObj = {
        releases: [{ name: 'test-service', version: '2.0.0' }],
      };
      const yamlContent = yaml.stringify(helmfileObj);
      expect(getVersionFromHelmfileYaml(yamlContent, 'missing')).toBeUndefined();
    });

    it('should return undefined for invalid YAML', () => {
      expect(getVersionFromHelmfileYaml('bad: : yaml', 'test-service')).toBeUndefined();
    });
  });

  describe('Direct unit tests for helpers and error handling', () => {
    it('shouldUpdateBranch: returns true if existingVersion is undefined', () => {
      expect(shouldUpdateBranch('1.2.3')).toBe(true);
    });
    it('shouldUpdateBranch: returns true if newVersion > existingVersion', () => {
      expect(shouldUpdateBranch('2.0.0', '1.2.3')).toBe(true);
    });
    it('shouldUpdateBranch: returns false if newVersion <= existingVersion', () => {
      expect(shouldUpdateBranch('1.2.3', '1.2.3')).toBe(false);
      expect(shouldUpdateBranch('1.2.2', '1.2.3')).toBe(false);
    });

    it('getExistingVersionInBranch: extracts version from Chart.yaml in branch', async () => {
      const octokit: MockOctokit = {
        rest: {
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: {
                content: Buffer.from(yaml.stringify({ dependencies: [{ name: 'test-service', version: '1.2.3' }] })).toString('base64'),
              },
            }),
          },
        },
      };
      const version = await getExistingVersionInBranch(
        octokit as unknown as ReturnType<typeof github.getOctokit>,
        'owner',
        'repo',
        'chart/Chart.yaml',
        'branch',
        'Chart.yaml',
        'test-service'
      );
      expect(version).toBe('1.2.3');
    });
    it('getExistingVersionInBranch: returns undefined if file not found', async () => {
      const octokit: MockOctokit = {
        rest: {
          repos: {
            getContent: vi.fn().mockRejectedValue(new Error('not found')),
          },
        },
      };
      const version = await getExistingVersionInBranch(
        octokit as unknown as ReturnType<typeof github.getOctokit>,
        'owner',
        'repo',
        'chart/Chart.yaml',
        'branch',
        'Chart.yaml',
        'test-service'
      );
      expect(version).toBeUndefined();
    });

    it('downloadRepoDir: handles non-array data from getContent', async () => {
      const octokit: MockOctokit = {
        rest: {
          repos: {
            getContent: vi.fn().mockResolvedValue({ data: {} }),
          },
        },
      };
      await expect(
        downloadRepoDir(octokit as unknown as ReturnType<typeof github.getOctokit>, 'owner', 'repo', 'branch', '', '/tmp')
      ).resolves.toBeUndefined();
    });

    it('createBranch: throws if getRef fails', async () => {
      const octokit: MockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockRejectedValue(new Error('fail')), // Simulate error
            createRef: vi.fn(),
          },
        },
      };
      await expect(createBranch(octokit as unknown as ReturnType<typeof github.getOctokit>, 'owner', 'repo', 'base', 'new')).rejects.toThrow('fail');
    });
    it('createBranch: throws if createRef fails', async () => {
      const octokit: MockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'sha' } } }),
            createRef: vi.fn().mockRejectedValue(new Error('fail-create')),
          },
        },
      };
      await expect(createBranch(octokit as unknown as ReturnType<typeof github.getOctokit>, 'owner', 'repo', 'base', 'new')).rejects.toThrow(
        'fail-create'
      );
    });

    it('updateFilesInBranch: warns if createOrUpdateFileContents fails', async () => {
      const octokit: MockOctokit = {
        rest: {
          repos: {
            createOrUpdateFileContents: vi.fn().mockRejectedValue(new Error('fail-update')),
            getContent: vi.fn().mockResolvedValue({ data: { sha: 'sha' } }),
          },
        },
      };
      const warnSpy = vi.spyOn(core, 'warning');
      await updateFilesInBranch(octokit as unknown as ReturnType<typeof github.getOctokit>, 'owner', 'repo', 'branch', 'dep', '1.2.3', [
        { path: 'chart/Chart.yaml', content: 'content', oldVersion: '1.0.0' },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to update file'));
      warnSpy.mockRestore();
    });

    it('createPullRequest: throws if PR creation fails', async () => {
      const octokit: MockOctokit = {
        rest: {
          pulls: {
            create: vi.fn().mockRejectedValue(new Error('fail-pr')),
          },
        },
      };
      await expect(
        createPullRequest(octokit as unknown as ReturnType<typeof github.getOctokit>, 'owner', 'repo', 'branch', 'dep', '1.2.3', 'base', {
          path: 'chart/Chart.yaml',
          content: 'content',
          oldVersion: '1.0.0',
        })
      ).rejects.toThrow('fail-pr');
    });
  });
});
