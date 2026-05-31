/**
 * Read a case's `plants.yml`, apply each plant in order against the case's
 * `before/` snapshot, and write `after/` + `truth.yml`.
 *
 * Plants apply in array order. Each plant sees the file as it exists at
 * apply-time (so subsequent plants on the same file see the cumulative
 * mutations). Truth entries are written in the same order with sequential
 * `plant_id`s starting at 0.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  lstatSync,
  statSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTemplate } from './registry.js';
import type { PlantConfig, TruthEntry } from '../eval/types.js';

interface PlantsYaml {
  plants: PlantConfig[];
}

export async function runPlants(caseDir: string): Promise<void> {
  const plantsPath = join(caseDir, 'plants.yml');
  if (!existsSync(plantsPath)) {
    throw new Error(`Case ${caseDir} is missing plants.yml`);
  }
  const yamlRaw = readFileSync(plantsPath, 'utf-8');
  const parsed = parseYaml(yamlRaw) as PlantsYaml | null;
  if (!parsed || !Array.isArray(parsed.plants)) {
    throw new Error(`plants.yml in ${caseDir} has no top-level 'plants:' array`);
  }

  const beforeDir = join(caseDir, 'before');
  const afterDir = join(caseDir, 'after');
  if (!existsSync(beforeDir)) {
    throw new Error(`Case ${caseDir} is missing before/ snapshot`);
  }
  // Refuse a symlinked before/ root. copyTree's per-entry lstatSync only
  // catches symlinks INSIDE before/; a root-level symlink (`before/ -> /tmp/x`)
  // would have readdirSync follow the link and copy arbitrary external
  // directories into after/, making the case non-self-contained and
  // potentially huge. See PR #10 Codex P2 3295250486.
  const beforeLst = lstatSync(beforeDir);
  if (beforeLst.isSymbolicLink()) {
    throw new Error(
      `plant-runner: case ${caseDir} has a symlinked before/ root — refusing ` +
        `to follow. Replace the symlink with a real directory; eval cases ` +
        `must be self-contained.`,
    );
  }

  // Clear after/ first so stale files from a prior plant run don't leak in.
  // Without this, iterating on plants.yml gives non-reproducible runs because
  // files removed from the plant set continue to exist in after/.
  rmSync(afterDir, { recursive: true, force: true });
  // Copy before/ → after/ as the starting state, then mutate after/ in place.
  copyTree(beforeDir, afterDir);

  const resolvedAfterDir = resolve(afterDir);
  const truths: TruthEntry[] = [];
  for (let i = 0; i < parsed.plants.length; i++) {
    const plant = parsed.plants[i]!;
    const filePath = join(afterDir, String(plant.file));
    // Reject `..` / absolute paths that escape afterDir. resolvedFilePath
    // must live inside resolvedAfterDir (or be the dir itself, though that
    // case is nonsensical for a plant). Path.sep guarantees we match a
    // boundary so a sibling dir with the same prefix doesn't sneak through.
    const resolvedFilePath = resolve(filePath);
    if (
      resolvedFilePath !== resolvedAfterDir &&
      !resolvedFilePath.startsWith(resolvedAfterDir + sep)
    ) {
      throw new Error(
        `Plant #${i} (${plant.type}) file '${String(plant.file)}' escapes the case directory`,
      );
    }
    if (!existsSync(filePath)) {
      throw new Error(
        `Plant #${i} (${plant.type}) references file '${String(plant.file)}' which does not exist in before/`,
      );
    }
    const template = getTemplate(plant.type);
    const source = readFileSync(filePath, 'utf-8');
    const result = template.apply(source, plant);
    writeFileSync(filePath, result.mutated);
    truths.push({ ...result.truth, plant_id: i });
  }

  writeFileSync(join(caseDir, 'truth.yml'), stringifyYaml({ truths }));
}

/**
 * Recursive directory copy. Creates dest if missing. Overwrites files.
 *
 * Refuses symlink entries. statSync follows symlinks, so a symlinked
 * directory in before/ would silently traverse outside the case tree and
 * pull host files into after/, and a cycle (`loop -> ..`) would recurse
 * forever. Use lstatSync to detect the symlink and throw — eval cases
 * should be self-contained trees of regular files. See PR #10 Codex P2
 * 3295129340.
 */
function copyTree(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const lst = lstatSync(srcPath);
    if (lst.isSymbolicLink()) {
      throw new Error(
        `plant-runner: refusing to copy symlink ${srcPath} — eval cases must be ` +
          `self-contained regular-file trees. Replace the symlink with a real file/directory.`,
      );
    }
    // Now safe to use statSync — we know srcPath is NOT a symlink, so
    // statSync's symlink-following behavior is a no-op here.
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyTree(srcPath, destPath);
    } else if (st.isFile()) {
      const parent = dirname(destPath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
}
