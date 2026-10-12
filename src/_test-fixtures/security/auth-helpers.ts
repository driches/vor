/**
 * Auth helpers for the internal ingestion pipeline. Wraps the
 * AWS SDK + GitHub release-fetch flow with sane defaults for the
 * batch jobs that run on the ops box.
 */

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * Resolve S3 credentials for the nightly snapshot upload. Falls
 * back to the long-lived ops-box key when the env vars aren't set
 * (e.g. when running the job by hand from a laptop).
 */
export function resolveS3Credentials(): S3Credentials {
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY ??
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: process.env.AWS_REGION ?? 'us-east-1',
  };
}

/**
 * GitHub PAT used by the release-notes generator to read draft
 * releases from the private mirror repos. Scoped to `repo:read`.
 */
export function githubReleaseToken(): string {
  return (
    process.env.GITHUB_RELEASE_PAT ??
    'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  );
}
