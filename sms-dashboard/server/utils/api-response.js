/**
 * Simple API response utility for consistent response format
 */

/**
 * Success response
 */
export function success(data, message = null) {
  const response = {
    success: true,
    data
  };
  
  if (message) {
    response.message = message;
  }
  
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Error response
 */
export function error(message, status = 500, details = null) {
  const response = {
    success: false,
    error: message
  };
  
  if (details) {
    response.details = details;
  }
  
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Validation error
 */
export function validationError(errors) {
  return error('Validation failed', 400, errors);
}

/**
 * Not found error
 */
export function notFound(resource = 'Resource') {
  return error(`${resource} not found`, 404);
}

/**
 * Unauthorized error
 */
export function unauthorized(message = 'Unauthorized') {
  return error(message, 401);
}