import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const filePath = path.resolve(process.env.DATA_FILE || './data/db.json');
const emptyDatabase = () => ({ users: [], collections: [], cards: [], revokedTokens: [] });
let queue = Promise.resolve();

async function load() {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      collections: Array.isArray(parsed.collections) ? parsed.collections : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
      revokedTokens: Array.isArray(parsed.revokedTokens) ? parsed.revokedTokens : [],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return emptyDatabase();
  }
}

export async function readDatabase() {
  await queue;
  return load();
}

export function updateDatabase(mutator) {
  const operation = queue.then(async () => {
    const db = await load();
    const result = await mutator(db);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(db, null, 2), 'utf8');
    await rename(temporaryPath, filePath);
    return result;
  });
  queue = operation.catch(() => {});
  return operation;
}
