<script lang="ts">
  import { onMount } from 'svelte';
  import { getRun, listRuns, review, type RunSummary } from './api';
  import RunDetail from './RunDetail.svelte';

  let runs = $state<RunSummary[]>([]);
  let selected = $state<RunSummary | null>(null);
  let loading = $state(true);
  let reviewing = $state(false);
  let error = $state<string | null>(null);
  let target = $state<'auto' | 'working-tree' | 'range'>('auto');

  async function refresh() {
    loading = true;
    error = null;
    try {
      runs = await listRuns();
      if (!selected && runs.length > 0) selected = runs[0];
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function open(id: string) {
    try {
      selected = await getRun(id);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function runReview() {
    reviewing = true;
    error = null;
    try {
      const record = await review({ target });
      selected = record;
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      reviewing = false;
    }
  }

  function findingCount(run: RunSummary): string {
    return run.findings.length === 0 ? 'clean' : `${run.findings.length} finding(s)`;
  }

  onMount(refresh);
</script>

<header>
  <h1>VOR</h1>
  <div class="controls">
    <select bind:value={target} disabled={reviewing}>
      <option value="auto">auto-detect</option>
      <option value="working-tree">working tree</option>
      <option value="range">branch range</option>
    </select>
    <button onclick={runReview} disabled={reviewing}>
      {reviewing ? 'Reviewing…' : 'Review now'}
    </button>
  </div>
</header>

{#if error}
  <p class="error">{error}</p>
{/if}

<main>
  <aside>
    <h2>Runs</h2>
    {#if loading}
      <p class="dim">Loading…</p>
    {:else if runs.length === 0}
      <p class="dim">No runs yet. Click “Review now”.</p>
    {:else}
      <ul>
        {#each runs as run (run.id)}
          <li>
            <button
              class="run"
              class:active={selected?.id === run.id}
              onclick={() => open(run.id)}
            >
              <span class="when">{new Date(run.timestamp).toLocaleString()}</span>
              <span class="meta">
                {run.target === 'working-tree' ? 'worktree' : `${run.base.ref}→${run.head.ref}`}
                · {findingCount(run)} · ${run.cost_usd.toFixed(4)}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <section>
    {#if selected}
      <RunDetail run={selected} />
    {:else}
      <p class="dim">Select a run, or start one.</p>
    {/if}
  </section>
</main>
