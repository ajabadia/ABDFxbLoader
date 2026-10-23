/**
 * Tope de rutas por petición de importación de bancos.
 *
 * Vive aquí, junto al contrato que comparten servidor y vista, y no en el
 * servicio: el navegador trocea la lista con este número para no pasarse, y no
 * puede importar `library.service` sin arrastrar `fs` y el resto de Node. El
 * servidor lo usa para rechazar una petición que lo supere, así que los dos
 * lados no pueden discrepar.
 */
export const MAX_BANKS_PER_REQUEST = 50;
