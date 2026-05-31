import type { PlantTemplate } from './types.js';
import { awsAccessKeyTemplate } from './aws-access-key.js';
import { sqlInjectionTemplate } from './sql-injection.js';
import { vulnDepNpmTemplate } from './vuln-dep-npm.js';
import { githubPatTemplate } from './github-pat.js';
import { pemPrivateKeyTemplate } from './pem-private-key.js';
import { pathTraversalTemplate } from './path-traversal.js';
import { evalUserInputTemplate } from './eval-user-input.js';
import { vulnDepPypiTemplate } from './vuln-dep-pypi.js';
import { nPlusOneQueryTemplate } from './n-plus-one-query.js';
import { offByOneLoopTemplate } from './off-by-one-loop.js';
import { missingNullCheckTemplate } from './missing-null-check.js';
import { syncInAsyncLoopTemplate } from './sync-in-async-loop.js';

const TEMPLATES: ReadonlyArray<PlantTemplate> = [
  awsAccessKeyTemplate,
  sqlInjectionTemplate,
  vulnDepNpmTemplate,
  githubPatTemplate,
  pemPrivateKeyTemplate,
  pathTraversalTemplate,
  evalUserInputTemplate,
  vulnDepPypiTemplate,
  nPlusOneQueryTemplate,
  offByOneLoopTemplate,
  missingNullCheckTemplate,
  syncInAsyncLoopTemplate,
];

const BY_TYPE = new Map<string, PlantTemplate>(TEMPLATES.map((t) => [t.type, t]));

export function getTemplate(type: string): PlantTemplate {
  const t = BY_TYPE.get(type);
  if (t) return t;
  const available = Array.from(BY_TYPE.keys()).sort().join(', ');
  throw new Error(`Unknown plant type "${type}". Available: ${available}`);
}

export function listTemplateTypes(): string[] {
  return Array.from(BY_TYPE.keys());
}
