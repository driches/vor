<script lang="ts">
  import type { RunFinding, RunSummary } from './api';

  let { run }: { run: RunSummary } = $props();

  const ORDER: RunFinding['severity'][] = ['critical', 'important', 'minor', 'nit'];

  const grouped = $derived(
    ORDER.map((sev) => ({ sev, items: run.findings.filter((f) => f.severity === sev) })).filter(
      (g) => g.items.length > 0,
    ),
  );
</script>

<div class="detail">
  <h2>
    {run.target === 'working-tree' ? 'Working tree' : `${run.base.ref} → ${run.head.ref}`}
  </h2>
  <p class="dim">
    {run.files} file(s) · +{run.additions}/−{run.deletions} · {run.turns} turn(s) ·
    ${run.cost_usd.toFixed(4)} · {run.ended}
  </p>

  {#if run.findings.length === 0}
    <p class="clean">No findings.</p>
  {:else}
    {#each grouped as group (group.sev)}
      <h3 class={`sev ${group.sev}`}>{group.sev} ({group.items.length})</h3>
      {#each group.items as f (f.file + ':' + f.line + ':' + f.title)}
        <article class={`finding ${f.severity}`}>
          <div class="finding-head">
            <span class="title">{f.title}</span>
            <span class="loc">{f.file}:{f.line}</span>
          </div>
          <p class="why">{f.why}</p>
          {#if f.suggestion}
            <pre class="suggestion">{f.suggestion}</pre>
          {/if}
        </article>
      {/each}
    {/each}
  {/if}
</div>
