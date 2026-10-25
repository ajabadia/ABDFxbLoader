import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  ASSOCIATION_AUDIT_FILENAME,
  AssociationAuditEntry,
  AssociationAuditFilter,
  AssociationAuditSnapshot,
  DEFAULT_AUDIT_LIMIT,
} from './association-audit.types';

export interface AssociationAuditAppendInput
  extends Omit<AssociationAuditEntry, 'ts'> {}

function parseAuditLine(line: string): AssociationAuditEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AssociationAuditEntry>;
    if (typeof parsed.ts !== 'string' || typeof parsed.kind !== 'string') {
      return null;
    }
    return parsed as AssociationAuditEntry;
  } catch {
    // Línea corrupta: se salta y se sigue (tolerancia de lectura).
    return null;
  }
}

@Injectable()
export class AssociationAuditService {
  private readonly logger = new Logger(AssociationAuditService.name);

  auditPath(libraryRoot: string): string {
    return path.join(libraryRoot, ASSOCIATION_AUDIT_FILENAME);
  }

  /**
   * Apila un evento en `<libraryRoot>/fxbLoader.audit.jsonl` con fsync.
   * No bloqueante: un fallo degrada a `false` con aviso en el Logger y no
   * interrumpe la operación de dominio que lo originó.
   */
  async append(libraryRoot: string, input: AssociationAuditAppendInput): Promise<boolean> {
    const auditPath = this.auditPath(libraryRoot);
    try {
      const entry: AssociationAuditEntry = {
        ts: new Date().toISOString(),
        kind: input.kind,
        ...(input.plugin !== undefined ? { plugin: input.plugin } : {}),
        ...(input.libraryRoot !== undefined ? { libraryRoot: input.libraryRoot } : {}),
        ...(input.field !== undefined ? { field: input.field } : {}),
        ...(input.previousValue !== undefined ? { previousValue: input.previousValue } : {}),
        ...(input.newValue !== undefined ? { newValue: input.newValue } : {}),
        ...(input.packageSource !== undefined ? { packageSource: input.packageSource } : {}),
        ...(input.collisionPolicy !== undefined
          ? { collisionPolicy: input.collisionPolicy }
          : {}),
        ...(input.collisionNames !== undefined ? { collisionNames: input.collisionNames } : {}),
        ...(input.repairedBanks !== undefined ? { repairedBanks: input.repairedBanks } : {}),
      };
      const line = JSON.stringify(entry) + '\n';
      await fs.mkdir(libraryRoot, { recursive: true });
      const handle = await fs.open(auditPath, 'a');
      try {
        await handle.write(Buffer.from(line, 'utf8'));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `No se pudo escribir en la auditoría de ${libraryRoot}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async readRaw(auditPath: string): Promise<{
    lines: AssociationAuditEntry[];
    size: number;
    exists: boolean;
  }> {
    let raw = '';
    let size = 0;
    let exists = true;
    try {
      const stat = await fs.stat(auditPath);
      size = stat.size;
      raw = await fs.readFile(auditPath, 'utf8');
    } catch {
      exists = false;
    }

    const lines: AssociationAuditEntry[] = [];
    if (exists) {
      for (const line of raw.split('\n')) {
        const parsed = parseAuditLine(line);
        if (parsed !== null) lines.push(parsed);
      }
    }
    return { lines, size, exists };
  }

  /**
   * Snapshot calculado del almacén con filtros opcionales. Los `entries`
   * del response son los últimos `limit` (por defecto 200) que pasan los
   * filtros, en orden cronológico ascendente.
   */
  async read(
    libraryRoot: string,
    filter: AssociationAuditFilter = {},
  ): Promise<AssociationAuditSnapshot> {
    const auditPath = this.auditPath(libraryRoot);
    const { lines, size, exists } = await this.readRaw(auditPath);

    const filtered = lines.filter((entry) => {
      if (filter.plugin !== undefined && entry.plugin !== filter.plugin) return false;
      if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
      if (filter.from !== undefined && entry.ts < filter.from) return false;
      if (filter.to !== undefined && entry.ts > filter.to) return false;
      return true;
    });

    const limit =
      typeof filter.limit === 'number' && Number.isInteger(filter.limit) && filter.limit > 0
        ? filter.limit
        : DEFAULT_AUDIT_LIMIT;

    return {
      auditPath,
      exists,
      size,
      total: filtered.length,
      entries: filtered.slice(-limit),
    };
  }
}
