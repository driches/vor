/**
 * Minimal "starter pistol" user prompt. All discipline lives in the system prompt.
 */

export function buildUserPrompt(input: {
  owner: string;
  repo: string;
  pull_number: number;
}): string {
  return [
    `Review pull request #${input.pull_number} in ${input.owner}/${input.repo}.`,
    '',
    'Start by calling get_pr_metadata, then read_repo_context_file, then list_changed_files.',
    'Work through the changes and post each finding via post_inline_comment. End with post_summary.',
  ].join('\n');
}
