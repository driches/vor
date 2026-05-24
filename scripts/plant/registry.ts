import type { PlantTemplate } from './types.js';
import { awsAccessKeyTemplate } from './aws-access-key.js';
import { sqlInjectionTemplate } from './sql-injection.js';
import { vulnDepNpmTemplate } from './vuln-dep-npm.js';

const TEMPLATES: ReadonlyArray<PlantTemplate> = [
  awsAccessKeyTemplate,
  sqlInjectionTemplate,
  vulnDepNpmTemplate,
];

const BY_TYPE = new Map<string, PlantTemplate>(
  TEMPLATES.map((t) => [t.type, t]),
);

export function getTemplate(type: string): PlantTemplate {
  const t = BY_TYPE.get(type);
  if (t) return t;
  const available = Array.from(BY_TYPE.keys()).sort().join(', ');
  throw new Error(
    `Unknown plant type "${type}". Available: ${available}`,
  );
}

export function listTemplateTypes(): string[] {
  return Array.from(BY_TYPE.keys());
}
