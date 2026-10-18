import express from 'express';

import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
): express.Router {
  const router = express.Router();

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      const status = result.success ? 200 : 'disabled' in result ? 403 : 500;
      response.status(status).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
