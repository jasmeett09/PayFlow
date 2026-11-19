import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { ApiError } from '../utils/api-error.js';

const bodyErrors: Record<string, { status: number; code: string; message: string }> = {
  'entity.parse.failed': { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON' },
  'entity.too.large': { status: 413, code: 'BODY_TOO_LARGE', message: 'The request body is too large' },
  'charset.unsupported': { status: 415, code: 'UNSUPPORTED_CHARSET', message: 'The request charset is unsupported' },
  'encoding.unsupported': { status: 415, code: 'UNSUPPORTED_ENCODING', message: 'The request encoding is unsupported' },
};

export function handleErrors(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ApiError) {
      if (error.status === 401 && error.code === 'UNAUTHORIZED') res.set('WWW-Authenticate', 'Bearer');
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }

    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request contains invalid fields',
          details: error.issues.map(issue => ({ field: issue.path.join('.'), code: issue.code })),
        },
      });
      return;
    }

    if (error && typeof error === 'object' && 'type' in error && typeof error.type === 'string'
      && Object.hasOwn(bodyErrors, error.type)) {
      const { status, code, message } = bodyErrors[error.type];
      res.status(status).json({ error: { code, message } });
      return;
    }

    logger.error({
      requestId: res.get('X-Request-Id'),
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }, 'Unhandled API error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  };
}
