import { describe, expect, it } from 'vitest';
import {
  AnalysisRunner,
  MAX_CASES,
  analyzeRules,
  computeProjectSignature,
  type AnalysisCheckpoint,
} from '../domain/ruleAnalysis';
import type { BusinessRule, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

function gte(fieldId: string, value: number): BusinessRule['conditions'] {
  return { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId, operator: 'gte', value }] };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const noopYield = (): Promise<void> => Promise.resolve();
const fixedClock: () => number = (() => {
  let time = 0;
  return () => {
    time += 1;
    return time;
  };
})();

async function exhaust(runner: AnalysisRunner): Promise<void> {
  while (!runner.isDone) {
    const processed = await runner.runChunk();
    if (processed === 0) throw new Error('执行器没有推进，疑似死循环');
  }
}

const demoRules = (): BusinessRule[] => [
  makeRule('base', gte('amount', 500), 10, 'standard'),
  makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
  makeRule('conflict', gte('amount', 700), 20, 'different'),
  makeRule('hidden', gte('amount', 750), 5, 'hidden'),
  makeRule('impossible', gte('amount', 1001), 50, 'out of range'),
  makeRule('no-overlap', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 250 }] }, 1, 'separate'),
];

describe('AnalysisRunner 分块执行与续算', () => {
  it('分块跑完的结果与同步 analyzeRules 完全一致', async () => {
    for (const chunkLeaves of [1, 3, 7, 13, 100, 1000]) {
      const subject = project(demoRules());
      const runner = new AnalysisRunner(subject, null, { chunkLeaves, chunkBudgetMs: Number.POSITIVE_INFINITY, now: fixedClock, yieldFn: noopYield });
      await exhaust(runner);
      expect(runner.result()).toEqual(analyzeRules(subject));
    }
  });

  it('在任意偏移中断后凭检查点续算，覆盖/重叠/不可达/遮蔽/例证与一次跑完逐项相同', async () => {
    const subject = project(demoRules());
    const baseline = analyzeRules(subject);

    for (const pauseAt of [1, 2, 7, 13, 25, 27]) {
      const first = new AnalysisRunner(subject, null, { chunkLeaves: pauseAt, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
      await exhaustUntil(first, pauseAt);
      expect(first.isDone).toBe(false);
      const snapshot: AnalysisCheckpoint = first.checkpoint();
      expect(snapshot.offset).toBe(pauseAt);

      // 序列化/反序列化一次，模拟检查点经过 IndexedDB/结构化克隆的真实路径。
      const restored: AnalysisCheckpoint = structuredClone(snapshot);
      const second = new AnalysisRunner(subject, restored, { chunkLeaves: 5, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
      expect(second.isResumed).toBe(true);
      await exhaust(second);
      expect(second.result()).toEqual(baseline);
    }
  });

  it('支持多次连续中断续算，每次续算都从上次偏移继续且最终结论不变', async () => {
    const subject = project(demoRules());
    const baseline = analyzeRules(subject);
    expect(baseline.checkedCases).toBe(60);
    // 60 = 10 × 6：分别在 10/20/30/40/50 处中断，最后一段跑完。
    const stops: number[] = [];
    let runner = new AnalysisRunner(subject, null, { chunkLeaves: 10, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
    let snapshot: AnalysisCheckpoint | null = null;
    for (let round = 0; round < 6; round += 1) {
      await runner.runChunk();
      if (runner.isDone) break;
      snapshot = runner.checkpoint();
      stops.push(snapshot.offset);
      expect(snapshot.offset).toBe((round + 1) * 10);
      runner = new AnalysisRunner(subject, snapshot, { chunkLeaves: 10, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
      expect(runner.isResumed).toBe(true);
    }
    expect(stops).toEqual([10, 20, 30, 40, 50]);
    expect(runner.isDone).toBe(true);
    expect(runner.result()).toEqual(baseline);
  });

  it('项目内容变化后旧检查点因签名不匹配而失效，自动从头重算', () => {
    const subject = project(demoRules());
    const first = new AnalysisRunner(subject, null, { chunkLeaves: 20, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
    void first.runChunk();
    const snapshot = first.checkpoint();

    const changed: RuleProject = {
      ...subject,
      rules: subject.rules.map((rule) => rule.id === 'base' ? { ...rule, priority: 99 } : rule),
    };
    expect(computeProjectSignature(changed)).not.toBe(computeProjectSignature(subject));

    const runner = new AnalysisRunner(changed, snapshot, { chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
    expect(runner.isResumed).toBe(false);
    expect(runner.getProgress().processed).toBe(0);
  });

  it('标题、更新时间与版本记录变化不使检查点失效', () => {
    const subject = project(demoRules());
    const signature = computeProjectSignature(subject);
    const republished: RuleProject = {
      ...subject,
      title: '改了个名字',
      updatedAt: subject.updatedAt + 9999,
      versions: [{ id: 'v1', name: '快照', savedAt: 1, frozen: false, fields: subject.fields, rules: subject.rules, sampleInputs: {} }],
    };
    expect(computeProjectSignature(republished)).toBe(signature);
  });

  it('进度信息单调推进并准确描述当前维度，续算时从已有偏移起步', async () => {
    const subject = project(demoRules());
    const runner = new AnalysisRunner(subject, null, { chunkLeaves: 5, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
    const seen: number[] = [];
    while (!runner.isDone) {
      await runner.runChunk();
      const progress = runner.getProgress();
      seen.push(progress.processed);
      expect(progress.total).toBe(60);
      expect(progress.percent).toBeGreaterThanOrEqual(0);
      expect(progress.percent).toBeLessThanOrEqual(100);
      expect(progress.stageLabel).toBe('金额');
      expect(progress.stageTotal).toBe(15);
      expect(progress.stageSegment).toBeGreaterThanOrEqual(1);
      expect(progress.stageSegment).toBeLessThanOrEqual(15);
    }
    expect(seen).toEqual([...new Set(seen)]);
    expect(seen.at(-1)).toBe(60);
    expect(runner.getProgress().percent).toBe(100);

    const snapshot = runner.checkpoint();
    const resumed = new AnalysisRunner(subject, snapshot, { yieldFn: noopYield });
    expect(resumed.isResumed).toBe(true);
    expect(resumed.isDone).toBe(true);
    expect(resumed.result()).toEqual(analyzeRules(subject));
  });

  it('大空间截断时，分块执行的截断结论与同步入口完全一致', async () => {
    const booleanFields: RuleField[] = Array.from({ length: 18 }, (_value, index) => ({
      id: `b${index}`, name: `布尔${index}`, type: 'boolean' as const,
    }));
    const rules = [makeRule('even', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'b0', operator: 'isTrue', value: true }] }, 10, 'yes')];
    const subject = project(rules, booleanFields);
    expect(2 ** booleanFields.length).toBeGreaterThan(MAX_CASES);

    const baseline = analyzeRules(subject);
    expect(baseline.truncated).toBe(true);
    expect(baseline.checkedCases).toBe(MAX_CASES);

    const runner = new AnalysisRunner(subject, null, { chunkLeaves: 1024, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
    await exhaust(runner);
    expect(runner.result()).toEqual(baseline);

    // 在截断边界之前中断并续算，最终截断结论仍须与一次跑完一致。
    const interrupted = new AnalysisRunner(subject, null, { chunkLeaves: 50_000, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
    await interrupted.runChunk();
    expect(interrupted.isDone).toBe(false);
    const snapshot = interrupted.checkpoint();
    expect(snapshot.offset).toBe(50_000);
    const continued = new AnalysisRunner(subject, structuredClone(snapshot), { chunkLeaves: 1234, chunkBudgetMs: Number.POSITIVE_INFINITY, yieldFn: noopYield });
    expect(continued.isResumed).toBe(true);
    await exhaust(continued);
    expect(continued.result()).toEqual(baseline);

    // 从恰好截断的快照恢复应立即完成。
    const finished = new AnalysisRunner(subject, structuredClone(runner.checkpoint()), { yieldFn: noopYield });
    expect(finished.isDone).toBe(true);
    expect(finished.result()).toEqual(baseline);
  });

  it('无字段项目可以一次跑完并给出 100% 进度', () => {
    const subject = project(demoRules(), []);
    const baseline = analyzeRules(subject);
    expect(baseline.checkedCases).toBe(1);
    const runner = new AnalysisRunner(subject, null, { yieldFn: noopYield });
    runner.runSynchronously();
    expect(runner.isDone).toBe(true);
    expect(runner.getProgress().percent).toBe(100);
    expect(runner.result()).toEqual(baseline);
  });

  it('字段没有合法候选值（空枚举）时空间为空，立即完成且不产出叶子', () => {
    const emptyEnum: RuleField = { id: 'empty', name: '空枚举', type: 'enum', enumValues: [] };
    const subject = project(demoRules(), [emptyEnum]);
    const baseline = analyzeRules(subject);
    expect(baseline.checkedCases).toBe(0);
    expect(baseline.unreachableRuleIds).toHaveLength(demoRules().length);

    const first = new AnalysisRunner(subject, null, { chunkLeaves: 10, yieldFn: noopYield });
    expect(first.isDone).toBe(true);
    const snapshot = first.checkpoint();
    expect(snapshot.offset).toBe(0);
    expect(snapshot.totalCases).toBe(0);
    const resumed = new AnalysisRunner(subject, structuredClone(snapshot), { yieldFn: noopYield });
    expect(resumed.isResumed).toBe(true);
    expect(resumed.isDone).toBe(true);
    expect(resumed.result()).toEqual(baseline);
    expect(resumed.getProgress().percent).toBe(100);
  });
});

async function exhaustUntil(runner: AnalysisRunner, targetOffset: number): Promise<void> {
  while (!runner.isDone && runner.getProgress().processed < targetOffset) {
    await runner.runChunk();
  }
}
