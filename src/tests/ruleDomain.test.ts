import { describe, expect, it } from 'vitest';
import { evaluateSample } from '../domain/conditionEvaluator';
import { validateField, validateProject } from '../domain/fieldValidation';
import { analyzeRules, createAnalysisSession } from '../domain/ruleAnalysis';
import type { BusinessRule, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const amountAtLeast = (value: number): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value }] });

describe('field and project validation', () => {
  it('accepts inclusive boundary ranges and rejects reversed or empty definitions', () => {
    expect(validateField({ ...amount, min: 5, max: 5 })).toEqual([]);
    expect(validateField({ ...amount, min: 11, max: 10 }).map((issue) => issue.code)).toContain('number-range-order');
    expect(validateField({ id: 'tier', name: '等级', type: 'enum', enumValues: [] }).map((issue) => issue.code)).toContain('enum-values-required');
  });

  it('checks enum and boolean predicate types without depending on React', () => {
    const rules = [
      makeRule('gold', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' }] }),
      makeRule('active', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true }] }),
    ];
    expect(validateProject(project(rules))).toEqual([]);
    expect(evaluateSample(project(rules), { amount: 12, tier: 'gold', active: true }).matchedRules.map((rule) => rule.id)).toEqual(['gold', 'active']);
  });
});

describe('rule consistency analysis', () => {
  it('finds partial overlap, same-priority conflicts, lower-priority shadowing, unreachable rules, and gaps', () => {
    const rules = [
      makeRule('base', amountAtLeast(500), 10, 'standard'),
      makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
      makeRule('conflict', amountAtLeast(700), 20, 'different'),
      makeRule('hidden', amountAtLeast(750), 5, 'hidden'),
      makeRule('impossible', amountAtLeast(1001), 50, 'out of range'),
      makeRule('no-overlap', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 250 }] }, 1, 'separate'),
    ];
    const analysis = analyzeRules(project(rules));
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'partial' && overlap.ruleBId === 'conflict' && overlap.conflict)).toBe(true);
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'base' && overlap.ruleBId === 'no-overlap')).toBe(false);
    expect(analysis.unreachableRuleIds).toContain('impossible');
    expect(analysis.shadowedRuleIds).toContain('hidden');
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    expect(analysis.checkedCases).toBeGreaterThan(0);
  });

  it('evaluates OR groups and validates missing sample inputs precisely', () => {
    const rule = makeRule('either', { kind: 'group', operator: 'or', conditions: [
      { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' },
      { kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true },
    ] });
    const result = evaluateSample(project([rule]), { amount: 10, tier: 'basic', active: true });
    expect(result.valid).toBe(true);
    expect(result.winner?.id).toBe('either');
    const missing = evaluateSample(project([rule]), { amount: 10, tier: 'gold' });
    expect(missing.errors).toEqual(['请填写“启用”']);
  });
});

describe('resumable analysis sessions', () => {
  const rules = () => [
    makeRule('base', amountAtLeast(500), 10, 'standard'),
    makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
    makeRule('conflict', amountAtLeast(700), 20, 'different'),
    makeRule('hidden', amountAtLeast(750), 5, 'hidden'),
    makeRule('impossible', amountAtLeast(1001), 50, 'out of range'),
    makeRule('no-overlap', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 250 }] }, 1, 'separate'),
  ];

  it('resumes from any checkpoint and matches the one-shot result exactly', () => {
    const target = project(rules());
    const expected = analyzeRules(target);
    expect(expected.checkedCases).toBe(60);
    for (let stopAfter = 1; stopAfter <= 20; stopAfter += 1) {
      const first = createAnalysisSession(target);
      for (let count = 0; count < stopAfter && !first.step(0); count += 1) {
        // 每次只处理一个组合，模拟分片边界取消
      }
      const resumed = createAnalysisSession(target, first.checkpoint());
      while (!resumed.step(Number.POSITIVE_INFINITY)) {
        // 续算到结束
      }
      expect(resumed.result()).toEqual(expected);
    }
  });

  it('matches the one-shot result when resuming repeatedly at every case boundary', () => {
    const target = project(rules());
    const expected = analyzeRules(target);
    let session = createAnalysisSession(target);
    while (!session.done) {
      session.step(0);
      session = createAnalysisSession(target, session.checkpoint());
    }
    expect(session.result()).toEqual(expected);
  });

  it('reports monotone progress with consistent totals and current position', () => {
    const target = project(rules());
    const session = createAnalysisSession(target);
    let previousPercent = -1;
    while (!session.step(0)) {
      const progress = session.progress();
      expect(progress.percent).toBeGreaterThanOrEqual(previousPercent);
      expect(progress.totalCases).toBe(60);
      expect(progress.plannedCases).toBe(60);
      expect(Object.keys(progress.currentValues)).toEqual(['amount', 'tier', 'active']);
      previousPercent = progress.percent;
    }
    expect(session.progress().percent).toBe(100);
    expect(session.result()).toEqual(analyzeRules(target));
  });

  it('keeps truncated runs identical across a cancel and resume', () => {
    const wideA: RuleField = { id: 'wide-a', name: '宽字段A', type: 'number', min: 0, max: 400 };
    const wideB: RuleField = { id: 'wide-b', name: '宽字段B', type: 'number', min: 0, max: 400 };
    const dense = (fieldId: string): BusinessRule => makeRule(`dense-${fieldId}`, {
      kind: 'group', operator: 'or',
      conditions: Array.from({ length: 174 }, (_, index) => ({ kind: 'predicate' as const, fieldId, operator: 'eq' as const, value: index + 1 })),
    });
    const target = project([dense('wide-a'), dense('wide-b')], [wideA, wideB]);
    const expected = analyzeRules(target);
    expect(expected.truncated).toBe(true);
    expect(expected.checkedCases).toBe(120_000);

    const first = createAnalysisSession(target);
    while (first.progress().checkedCases < 50_000) {
      if (first.step(5)) break;
    }
    expect(first.done).toBe(false);
    const resumed = createAnalysisSession(target, first.checkpoint());
    while (!resumed.step(Number.POSITIVE_INFINITY)) {
      // 续算到结束
    }
    expect(resumed.result()).toEqual(expected);
  });
});
