#!/usr/bin/env node
/**
 * CLI: golden:plant --case <id>
 *
 * Reads $GOLDEN_REPO_PATH (or --golden-repo flag) and a case id, runs the
 * plant pipeline for that case.
 */
import { runPlants } from './plant/plant-runner.js';
import { resolveCaseDir } from './plant/case-paths.js';

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const caseId = arg('--case');
  if (!caseId) {
    console.error('usage: golden:plant --case <id> [--golden-repo <path>]');
    process.exit(2);
  }
  const goldenRepo = arg('--golden-repo') ?? process.env.GOLDEN_REPO_PATH;
  if (!goldenRepo) {
    console.error('--golden-repo or GOLDEN_REPO_PATH is required');
    process.exit(2);
  }
  let caseDir: string;
  try {
    caseDir = resolveCaseDir(goldenRepo, caseId);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  await runPlants(caseDir);
  console.log(`Planted case ${caseId} → ${caseDir}/after, ${caseDir}/truth.yml`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
