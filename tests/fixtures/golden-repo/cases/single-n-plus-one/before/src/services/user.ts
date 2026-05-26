import { db } from '../db/client.js';

interface User {
  id: string;
  row?: unknown;
}

export async function enrichUsers(items: User[]): Promise<User[]> {
  // enrichment goes here
  return items;
}
