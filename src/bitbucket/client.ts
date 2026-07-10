import { BitbucketApiError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { retry } from '../util/retry.js';

export interface BitbucketClientOptions {
  workspace: string;
  repoSlug: string;
  email: string;
  apiToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface BitbucketUser {
  display_name?: string;
  nickname?: string;
  account_id?: string;
  uuid?: string;
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description?: string;
  summary?: { raw?: string };
  author?: BitbucketUser;
  source?: {
    branch?: { name?: string };
    commit?: { hash?: string };
  };
  destination?: {
    branch?: { name?: string };
    commit?: { hash?: string };
  };
  draft?: boolean;
  links?: {
    html?: { href?: string };
  };
}

export interface BitbucketDiffStat {
  status?: string;
  lines_added?: number;
  lines_removed?: number;
  old?: { path?: string; type?: string };
  new?: { path?: string; type?: string };
}

export interface BitbucketComment {
  id: number;
  content?: { raw?: string };
  inline?: {
    path?: string;
    from?: number | null;
    to?: number | null;
    start_from?: number | null;
    start_to?: number | null;
  };
  user?: BitbucketUser;
  deleted?: boolean;
  pending?: boolean;
  resolution?: { type?: string } | null;
  parent?: { id?: number };
}

export interface CreateCommentInput {
  body: string;
  inline?: {
    path: string;
    line: number;
    side: 'RIGHT' | 'LEFT';
    startLine?: number;
  };
}

interface Paginated<T> {
  values?: T[];
  next?: string;
}

export class BitbucketClient {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;

  constructor(private readonly opts: BitbucketClientOptions) {
    const parsedBaseUrl = parseBaseUrl(opts.apiBaseUrl ?? 'https://api.bitbucket.org/2.0');
    this.baseUrl = parsedBaseUrl.toString().replace(/\/+$/, '');
    this.baseOrigin = parsedBaseUrl.origin;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.authHeader = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`, 'utf-8').toString(
      'base64',
    )}`;
  }

  get repoPath(): string {
    return `/repositories/${encodeURIComponent(this.opts.workspace)}/${encodeURIComponent(
      this.opts.repoSlug,
    )}`;
  }

  async getPullRequest(prId: number): Promise<BitbucketPullRequest> {
    return this.requestJson<BitbucketPullRequest>(`${this.repoPath}/pullrequests/${prId}`);
  }

  async getPullRequestDiff(prId: number): Promise<string> {
    return this.requestText(`${this.repoPath}/pullrequests/${prId}/diff`, 'text/plain');
  }

  async listDiffStat(prId: number): Promise<BitbucketDiffStat[]> {
    return this.paginate<BitbucketDiffStat>(`${this.repoPath}/pullrequests/${prId}/diffstat`);
  }

  async readSource(ref: string, path: string): Promise<Buffer | null> {
    try {
      return await this.requestBuffer(
        `${this.repoPath}/src/${encodeURIComponent(ref)}/${encodePath(path)}`,
      );
    } catch (err) {
      if (err instanceof BitbucketApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listComments(prId: number): Promise<BitbucketComment[]> {
    return this.paginate<BitbucketComment>(`${this.repoPath}/pullrequests/${prId}/comments`);
  }

  async createComment(prId: number, input: CreateCommentInput): Promise<BitbucketComment> {
    const inline =
      input.inline === undefined
        ? undefined
        : {
            path: input.inline.path,
            ...(input.inline.side === 'RIGHT'
              ? {
                  to: input.inline.line,
                  ...(input.inline.startLine !== undefined
                    ? { start_to: input.inline.startLine }
                    : {}),
                }
              : {
                  from: input.inline.line,
                  ...(input.inline.startLine !== undefined
                    ? { start_from: input.inline.startLine }
                    : {}),
                }),
          };
    return this.requestJson<BitbucketComment>(`${this.repoPath}/pullrequests/${prId}/comments`, {
      method: 'POST',
      body: {
        content: { raw: input.body },
        ...(inline !== undefined ? { inline } : {}),
      },
    });
  }

  async resolveComment(prId: number, commentId: number): Promise<void> {
    await this.requestJson<unknown>(
      `${this.repoPath}/pullrequests/${prId}/comments/${commentId}/resolve`,
      { method: 'POST' },
    );
  }

  async approve(prId: number): Promise<void> {
    await this.requestJson<unknown>(`${this.repoPath}/pullrequests/${prId}/approve`, {
      method: 'POST',
    });
  }

  async unapprove(prId: number): Promise<void> {
    await this.requestJson<unknown>(`${this.repoPath}/pullrequests/${prId}/approve`, {
      method: 'DELETE',
    });
  }

  async requestChanges(prId: number): Promise<void> {
    await this.requestJson<unknown>(`${this.repoPath}/pullrequests/${prId}/request-changes`, {
      method: 'POST',
    });
  }

  async removeChangeRequest(prId: number): Promise<void> {
    await this.requestJson<unknown>(`${this.repoPath}/pullrequests/${prId}/request-changes`, {
      method: 'DELETE',
    });
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let next: string | undefined = `${path}${path.includes('?') ? '&' : '?'}pagelen=100`;
    while (next !== undefined) {
      const page: Paginated<T> = await this.requestJson<Paginated<T>>(next);
      values.push(...(page.values ?? []));
      next = page.next;
    }
    return values;
  }

  private async requestJson<T>(
    pathOrUrl: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.request(pathOrUrl, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async requestText(pathOrUrl: string, accept: string): Promise<string> {
    const res = await this.request(pathOrUrl, { accept });
    return res.text();
  }

  private async requestBuffer(pathOrUrl: string): Promise<Buffer> {
    const res = await this.request(pathOrUrl, { accept: 'application/octet-stream' });
    return Buffer.from(await res.arrayBuffer());
  }

  private async request(
    pathOrUrl: string,
    opts: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    const url = this.resolveUrl(pathOrUrl);
    const method = opts.method ?? 'GET';
    return retry(
      async () => {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            Accept: opts.accept ?? 'application/json',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
        if (!res.ok) {
          const detail = await safeResponseText(res);
          throw new BitbucketApiError(
            `Bitbucket ${method} ${url} failed with status ${res.status}${detail ? `: ${detail}` : ''}`,
            res.status,
          );
        }
        return res;
      },
      {
        retries: 3,
        shouldRetry: (err) => shouldRetryRequest(err, method),
        onRetry: (err, attempt, delayMs) => {
          void logger.warn(
            `Retrying Bitbucket ${method} ${url} after ${(err as Error).message} ` +
              `(attempt ${attempt + 1}, ${delayMs}ms)`,
          );
        },
      },
    );
  }

  private resolveUrl(pathOrUrl: string): string {
    let url: URL;
    try {
      url = /^https?:\/\//i.test(pathOrUrl)
        ? new URL(pathOrUrl)
        : new URL(`${this.baseUrl}${pathOrUrl}`);
    } catch (err) {
      throw new BitbucketApiError(`Invalid Bitbucket API URL: ${pathOrUrl}`, undefined, {
        cause: err,
      });
    }
    if (url.origin !== this.baseOrigin) {
      throw new BitbucketApiError(
        `Refusing to send Bitbucket credentials to pagination origin ${url.origin}`,
      );
    }
    return url.toString();
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    throw new BitbucketApiError(`Invalid Bitbucket API base URL: ${value}`, undefined, {
      cause: err,
    });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BitbucketApiError(`Invalid Bitbucket API base URL: ${value}`);
  }
  return url;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function shouldRetryRequest(err: unknown, method: string): boolean {
  if (err instanceof TypeError) return method === 'GET';
  if (!(err instanceof BitbucketApiError)) return false;
  if (err.status === 429) return true;
  return (
    method === 'GET' && (err.status === 408 || (err.status !== undefined && err.status >= 500))
  );
}

async function safeResponseText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    // Error responses can have already-consumed or streaming bodies; the HTTP
    // status still carries enough context for callers.
    return '';
  }
}
