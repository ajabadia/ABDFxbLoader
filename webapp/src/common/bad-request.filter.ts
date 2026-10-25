import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Los DTO de error documentan el cuerpo **exacto** del 400: solo `message`, o
 * `message` con `issues` cuando la validación acumula motivos. Nest, en cambio,
 * envuelve los `BadRequestException` creados con un mensaje de texto en
 * `{ statusCode, message, error }`, así que el cuerpo real no coincidía con el
 * contrato. Este filtro global deja la respuesta tal como está documentada.
 *
 * Solo toca el 400: el resto de códigos (404, 409, 422, 501...) siguen con el
 * comportamiento por defecto de Nest.
 */
@Catch(BadRequestException)
export class BadRequestFilter implements ExceptionFilter<BadRequestException> {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(HttpStatus.BAD_REQUEST).json(badRequestBody(exception));
  }
}

/** Cuerpo del 400: el payload lanzado, sin el sobre `statusCode`/`error`. */
export function badRequestBody(exception: BadRequestException): Record<string, unknown> {
  const payload = exception.getResponse();
  if (typeof payload === 'string') return { message: payload };

  // Un payload en objeto ya viene sin sobre; se copia igual para no exponer
  // claves internas y para normalizar un `message` en lista.
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'statusCode' || key === 'error') continue;
    body[key] = Array.isArray(value) && key === 'message' ? value.map(String).join('; ') : value;
  }
  if (typeof body['message'] !== 'string') body['message'] = exception.message;
  return body;
}
