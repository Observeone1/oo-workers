import { logger } from '../utils/logger.ts';
import { putObject } from './object-storage.ts';

export async function drainTarEntry(
  entry: AsyncIterable<Buffer> & NodeJS.ReadableStream,
): Promise<void> {
  for await (const _chunk of entry) {
    // discard
  }
}

export async function readTarEntryBuffer(
  entry: AsyncIterable<Buffer> & NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of entry) chunks.push(c);
  return Buffer.concat(chunks);
}

export async function uploadTarArtifact(
  name: string,
  entry: AsyncIterable<Buffer> & NodeJS.ReadableStream,
  guessContentType: (key: string) => string,
): Promise<'uploaded' | 'failed' | 'skipped-unsafe'> {
  if (!name.startsWith('artifacts/')) return 'skipped-unsafe';
  const key = name.slice('artifacts/'.length);
  if (!key || key.startsWith('/') || key.split('/').includes('..')) {
    logger.warn(`restore: skipped artifact with unsafe key ${JSON.stringify(name)}`);
    await drainTarEntry(entry);
    return 'skipped-unsafe';
  }
  const body = await readTarEntryBuffer(entry);
  try {
    await putObject(key, body, guessContentType(key));
    return 'uploaded';
  } catch (err) {
    logger.warn(
      `restore: artifact upload failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'failed';
  }
}
