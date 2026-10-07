import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules, type AnalysisProgress } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; }, onProgress: () => undefined };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; }, onProgress: () => undefined };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });
});

class ControllableChecker {
  last?: {
    resolve: (analysis: ReturnType<typeof analyzeRules>) => void;
    reject: (error: Error) => void;
    emit: (progress: AnalysisProgress) => void;
    cancel: () => void;
  };

  run(project: RuleProject): CheckOperation {
    const listeners = new Set<(progress: AnalysisProgress) => void>();
    const operation: CheckOperation = {
      promise: new Promise((resolve, reject) => {
        this.last = {
          resolve: () => resolve(analyzeRules(project)),
          reject,
          emit: (progress) => listeners.forEach((listener) => listener(progress)),
          cancel: () => reject(new DOMException('规则检查已取消', 'AbortError')),
        };
      }),
      cancel: () => this.last?.cancel(),
      onProgress: (listener) => { listeners.add(listener); },
    };
    return operation;
  }
}

const progressAt = (processed: number): AnalysisProgress => ({
  processed, total: 100, percent: processed, stageLabel: '金额', stageSegment: 1, stageTotal: 2,
  resumed: processed > 0, truncated: false,
});

describe('检查进度与取消', () => {
  beforeEach(() => vi.useFakeTimers());

  it('把 worker 进度写入状态，取消后保留续算提示且不展示旧进度', async () => {
    const checker = new ControllableChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();

    const check = workspace.runCheck();
    expect(checker.last).toBeTruthy();
    checker.last?.emit(progressAt(40));
    expect(workspace.getSnapshot().progress?.processed).toBe(40);
    expect(workspace.getSnapshot().notice).not.toContain('续');

    workspace.cancelCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('cancelled');
    expect(workspace.getSnapshot().progress).toBeNull();
    expect(workspace.getSnapshot().notice).toContain('40');
    expect(workspace.getSnapshot().notice).toContain('继续');

    await vi.advanceTimersByTimeAsync(0);
    await check.catch(() => undefined);
    workspace.dispose();
  });

  it('过期请求的进度回调不会覆盖当前状态', async () => {
    const checker = new ControllableChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();

    const first = workspace.runCheck();
    const stale = checker.last;
    workspace.cancelCheck();
    await first.catch(() => undefined);
    stale?.emit(progressAt(99));
    expect(workspace.getSnapshot().progress).toBeNull();
    workspace.dispose();
  });
});

