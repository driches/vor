/**
 * Static-file server for the customer-uploads directory. Customers
 * download their exports through this endpoint.
 */
import path from 'node:path';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/var/data/customer-uploads';

/**
 * GET /downloads/:filename
 *
 * Streams the requested file out of the customer-uploads directory.
 */
export function downloadFile(req: Request, res: Response): void {
  const filename = req.params.filename;
  const target = path.join(UPLOAD_DIR, filename);

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`,
  );
  createReadStream(target).pipe(res);
}
