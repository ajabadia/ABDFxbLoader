import { describeError, isFxbApiError, type FxbApiError } from './api.js';

/** Detalles técnicos de un error para diagnóstico, sin exponer el stack completo. */
export interface ErrorDiagnostics {
  /** Marca de cuando se generó el diagnóstico (UTC, ISO). */
  timestamp: string;
  /** Id del cliente para correlación con logs del servidor. */
  clientId: string;
  /** Código HTTP o 0 para errores no HTTP. */
  status: number;
  /** Código de error del API si el servidor lo envió, o cadena faltante. */
  code: string | null;
  /** Idioma activo de la vista. */
  locale: string;
  /** Mensaje que vio el usuario (ya traducido). */
  userMessage: string;
  /** Texto crudo del servidor cuando no hay traducción aplicable. */
  rawMessage: string | null;
  /** Cuerpo serializado del error (sin stack completo). */
  body: string;
  /** Problemas detallados si los hay (issues del API). */
  issues: string[];
  /** Ruta opcional si el contexto la tiene. */
  route: string | null;
}

const LOCAL_CLIENT_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/** Extrae un diagnóstico limpio de un error, en el idioma de la vista. */
export function errorDiagnostics(error: unknown, meta?: { route?: string }): ErrorDiagnostics {
  const locale = typeof window !== 'undefined' && window.navigator?.language ? window.navigator.language : 'es';
  const route = meta?.route ?? null;
  if (isFxbApiError(error)) {
    const body = error.body;
    const status = error.status;
    const code = extractCode(body);
    const translated = messageFromBody(body);
    const message =
      translated !== null
        ? translated
        : (typeof error.message === 'string' ? error.message : describeError(error));
    const rawMessage = translated !== null ? null : (typeof error.message === 'string' ? error.message : null);
    const issues = extractIssues(body);
    return {
      timestamp: new Date().toISOString(),
      clientId: LOCAL_CLIENT_ID,
      status,
      code,
      locale,
      userMessage: message,
      rawMessage,
      body: safeString(body),
      issues,
      route,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    clientId: LOCAL_CLIENT_ID,
    status: 0,
    code: null,
    locale,
    userMessage: describeError(error),
    rawMessage: null,
    body: safeString(error),
    issues: [],
    route,
  };
}

function extractCode(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const candidate = (body as { code?: unknown }).code;
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return null;
}

function messageFromBody(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const candidate = (body as { message?: unknown }).message;
    if (typeof candidate === 'string' && candidate !== '') return candidate;
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === 'string')) {
      return candidate.join('; ');
    }
  }
  return null;
}

function extractIssues(body: unknown): string[] {
  if (typeof body === 'object' && body !== null && 'issues' in body) {
    const candidate = (body as { issues?: unknown }).issues;
    if (Array.isArray(candidate)) {
      return candidate
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 50);
    }
  }
  return [];
}

function safeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const DIAGNOSTIC_TEMPLATE = [
  '--- fxbLoader error diagnostic ---',
  'timestamp: {timestamp}',
  'clientId: {clientId}',
  'locale: {locale}',
  'status: {status}',
  'code: {code}',
  'route: {route}',
  '',
  'userMessage: {userMessage}',
  '',
  'rawMessage: {rawMessage}',
  'body: {body}',
  '',
  'issues:',
  '{issues}',
  '--- end ---',
].join('\n');

function padIssues(issues: string[]): string {
  if (issues.length === 0) return '(sin issues)';
  return issues.map((line) => `  - ${line}`).join('\n');
}

/** Formatea un diagnóstico como texto listo para copiar al portapapeles. */
export function formatErrorDiagnostics(d: ErrorDiagnostics): string {
  return DIAGNOSTIC_TEMPLATE
    .replace('{timestamp}', d.timestamp)
    .replace('{clientId}', d.clientId)
    .replace('{locale}', d.locale)
    .replace('{status}', String(d.status))
    .replace('{code}', d.code ?? '')
    .replace('{route}', d.route ?? '')
    .replace('{userMessage}', d.userMessage)
    .replace('{rawMessage}', d.rawMessage ?? '')
    .replace('{body}', d.body)
    .replace('{issues}', padIssues(d.issues));
}

/** Copia al portapapeles los detalles técnicos de un error, si está disponible.

 * Devuelve `{ copied, error }`: `copied` es true cuando el navegador aceptó
 * la escritura; de lo contrario el usuario puede usar el mensaje formateado
 * manualmente.
 */
export async function copyErrorDiagnostics(error: unknown, meta?: { route?: string }): Promise<{ copied: boolean; error?: unknown }> {
  const d = errorDiagnostics(error, meta);
  const text = formatErrorDiagnostics(d);
  if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
    return { copied: false };
  }
  try {
    await navigator.clipboard.writeText(text);
    return { copied: true };
  } catch (err) {
    return { copied: false, error: err };
  }
}
