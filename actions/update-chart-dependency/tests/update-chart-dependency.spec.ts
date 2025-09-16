import fs from 'fs';
import yaml from 'yaml';
import { describe, it, expect, vi, beforeEach, MockInstance } from 'vitest';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { run, getFileSha, updateFilesInBranch, updateChartYamlDependency, updateHelmfileReleaseVersion, getChartFilesWithDirs } from '../main.js';
import type { ActionInputs } from '../main.js';

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

  it('should generate the correct branch name for nested chart directories', async () => {
    // Simulate nested directory structure: nested/dir/chart/Chart.yaml
    const nestedDir = 'nested/dir/chart';
    const absFilePath = `${tempDir}/${nestedDir}/Chart.yaml`;
    // Mock directory reading to return the nested structure
    readDirSyncSpy.mockImplementation((dirPath: string) => {
      if (dirPath === tempDir) {
        return [makeDirent('nested')];
      }
      if (dirPath === `${tempDir}/nested`) {
        return [makeDirent('dir')];
      }
      if (dirPath === `${tempDir}/nested/dir`) {
        return [makeDirent('chart')];
      }
      if (dirPath === `${tempDir}/nested/dir/chart`) {
        return [];
      }
      return [];
    });
    existsSyncSpy.mockImplementation((filePath: fs.PathLike) => {
      return filePath === absFilePath;
    });
    readFileSyncSpy.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      if (filePath === absFilePath) {
        return yaml.stringify({ dependencies: [{ name: 'test-service', version: '0.0.1' }] });
      }
      return '';
    });
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({});
    const createBranch = vi.fn().mockResolvedValue({});
    const createPullRequest = vi.fn().mockResolvedValue({});
    mockGetOctokit = vi.fn(() => ({
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
          createRef: createBranch,
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
    // The branch name should be sanitized: update-helm-chart-test-service-1.2.3-<sanitizedFilePath>
    const sanitizedFilePath = `${nestedDir.split('/').join('-')}-Chart`;
    const expectedBranchName = `update-helm-chart-test-service-1.2.3-${sanitizedFilePath}`;
    expect(createBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: `refs/heads/${expectedBranchName}`,
      })
    );
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        head: expectedBranchName,
        title: `deps: update Helm dependency test-service in chart ${sanitizedFilePath}`,
        body: `Update Helm chart dependency \`test-service\` to version \`1.2.3\`.\n\n### Updated charts:\n- \`${sanitizedFilePath}\` (old version: \`0.0.1\`)`,
      })
    );
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
      // Use sanitized file path for chart name
      const chartLetter = i === 0 ? 'A' : 'B';
      const sanitizedFilePath = `chart${chartLetter}-Chart`;
      const expectedBody = `Update Helm chart dependency \`test-service\` to version \`1.2.3\`.\n\n### Updated charts:\n- \`${sanitizedFilePath}\` (old version: \`0.0.1\`)`;
      expect(prCall.body).toBe(expectedBody);
      expect(prCall.title).toBe(`deps: update Helm dependency test-service in chart ${sanitizedFilePath}`);
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
});
