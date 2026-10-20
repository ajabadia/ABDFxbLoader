import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Códigos que Windows devuelve al intentar abrir un directorio para fsync. */
const DIRECTORY_SYNC_ERRORS = new Set(['EPERM', 'EACCES', 'EISDIR', 'EBADF', 'ENOTSUP']);

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !DIRECTORY_SYNC_ERRORS.has(code)) throw error;
  }
}

function tempPathFor(target: string): string {
  const dir = path.dirname(target);
  const name = path.basename(target);
  return path.join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
}

async function replaceWithTemp(target: string, temp: string): Promise<void> {
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(target));
}

/** Escribe `data` en `target` con temp + fsync + rename. */
export async function writeFileAtomic(target: string, data: Buffer): Promise<void> {
  const temp = tempPathFor(target);
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await replaceWithTemp(target, temp);
}

/** Copia `source` a `target` con temp + fsync + rename. */
export async function copyFileAtomic(source: string, target: string): Promise<void> {
  const temp = tempPathFor(target);
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(await fs.readFile(source));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await replaceWithTemp(target, temp);
}
