import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { AnalysisCheckpoint, AnalysisProgress } from '../domain/ruleAnalysis';
import type { RuleAnalysis, RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation, RunCheckOptions } from '../services/ruleCheckService';
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
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
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

  it('keeps a checkpoint on cancel, resumes from it, and clears it on success or edits', async () => {
    const checkpoint: AnalysisCheckpoint = { path: [1, 0, 0], checkedCases: 4, coveredCases: 3, seenRuleIds: ['r1'], visibleRuleIds: ['r1'], processedMatchSets: [], overlaps: [], uncoveredExamples: [], truncated: false, done: false };
    const progress: AnalysisProgress = { checkedCases: 4, totalCases: 60, plannedCases: 60, percent: 6, truncated: false, currentValues: { 'cart-total': 100 } };

    class PausingChecker {
      lastOptions?: RunCheckOptions;
      autoResolve = false;
      private rejectPending?: (reason: Error) => void;

      run(project: RuleProject, options?: RunCheckOptions): CheckOperation {
        this.lastOptions = options;
        options?.onProgress?.(progress);
        const promise = new Promise<RuleAnalysis>((resolve, reject) => {
          this.rejectPending = reject;
          if (this.autoResolve) resolve(analyzeRules(project));
        });
        return {
          promise,
          cancel: () => {
            options?.onCheckpoint?.(checkpoint);
            this.rejectPending?.(new DOMException('规则检查已取消', 'AbortError'));
          },
        };
      }
    }

    const checker = new PausingChecker();
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), checker);
    await workspace.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('checking');
    expect(workspace.getSnapshot().checkProgress?.percent).toBe(6);

    workspace.cancelCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('cancelled');
    expect(workspace.getSnapshot().checkCheckpoint).toEqual(checkpoint);
    expect(workspace.getSnapshot().checkProgress?.checkedCases).toBe(4);

    void workspace.runCheck({ resume: true });
    expect(workspace.getSnapshot().checkStatus).toBe('checking');
    expect(checker.lastOptions?.resumeFrom).toEqual(checkpoint);

    checker.autoResolve = true;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().checkCheckpoint).toBeNull();
    expect(workspace.getSnapshot().checkProgress).toBeNull();
    workspace.dispose();
  });
});
