import { describe, expect, it } from 'vitest';
import { makePostSummaryTool } from './post-summary.js';
import { buildFakeDeps, callTool, getResultJson, makeFile } from './test-helpers.js';

describe('post_summary tool', () => {
  it('accepts a comment-assessment summary', async () => {
    const deps = buildFakeDeps();
    const tool = makePostSummaryTool(deps);
    const result = await callTool(tool, {
      strengths: ['Tests cover the new edge case clearly.'],
      assessment: 'comment',
      assessment_reasoning: 'A small observation but nothing blocking the merge.',
    });
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    expect(deps.aggregator.hasSummary()).toBe(true);
  });

  it('rejects second call', async () => {
    const deps = buildFakeDeps();
    const tool = makePostSummaryTool(deps);
    await callTool(tool, {
      strengths: ['Good naming throughout.'],
      assessment: 'comment',
      assessment_reasoning: 'Looks fine overall, no concerns.',
    });
    const second = await callTool(tool, {
      strengths: ['Second attempt strength here.'],
      assessment: 'approve',
      assessment_reasoning: 'Trying again, but this should fail.',
    });
    const json = getResultJson(second) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('only be called once');
  });

  it('rejects request_changes without critical/important', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostSummaryTool(deps);
    const result = await callTool(tool, {
      strengths: ['Concise commit messages explain the intent well.'],
      assessment: 'request_changes',
      assessment_reasoning: 'Want changes but only have minor findings.',
    });
    const json = getResultJson(result) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('request_changes');
  });

  it('accepts request_changes when critical was posted', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    deps.aggregator.addComment({
      severity: 'critical',
      file_path: 'src/foo.ts',
      line: 10,
      side: 'RIGHT',
      category: 'bug',
      title: 't',
      why_it_matters: 'why',
      confidence: 'high',
    });
    const tool = makePostSummaryTool(deps);
    const result = await callTool(tool, {
      strengths: ['The intent is clear from the PR description and commit history.'],
      assessment: 'request_changes',
      assessment_reasoning: 'Found a critical bug that needs to be fixed before merge.',
    });
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
  });
});
