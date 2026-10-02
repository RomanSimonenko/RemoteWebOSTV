import type { FastifyRequest } from 'fastify';

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Registered routes use router identity: aliases must never change their policy. */
export function httpPolicy(request: FastifyRequest) {
  const route = request.is404 ? undefined : request.routeOptions.url;
  if (route) {
    const api = isApiPath(route);
    const authAttempt = request.method === 'POST' && (route === '/api/setup' || route === '/api/auth/login');
    const publicRead = ['GET', 'HEAD'].includes(request.method) && (route === '/api/health' || route === '/api/setup/status');
    return { api, requiresSession: api && !authAttempt && !publicRead, authAttempt, spaNavigation: false };
  }

  // Only unmatched paths need decoding, solely to choose JSON 404 versus SPA.
  // Malformed escapes fail closed and never become HTML navigation.
  let path: string;
  try {
    path = decodeURIComponent(request.url.split('?', 1)[0] ?? '');
  } catch {
    return { api: true, requiresSession: false, authAttempt: false, spaNavigation: false };
  }
  const api = isApiPath(path);
  return {
    api, requiresSession: false, authAttempt: false,
    spaNavigation: !api && !path.includes('.') && request.method === 'GET' && Boolean(request.headers.accept?.includes('text/html')),
  };
}
