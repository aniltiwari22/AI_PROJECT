const sessions = require('./sessions');

/**
 * Route protection.
 *
 * Before this, `auth/routes.js` issued a token and not one route ever checked
 * it — every endpoint was open. Anyone who could reach the port could read
 * conversations, upload files, run inference, and point the repository indexer
 * at any folder on the machine.
 */

const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH || '';

/** Paths reachable without a session. Everything else needs one. */
const PUBLIC_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/status'
]);

function bearerFrom(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // Streaming responses are read with fetch(), which can set headers — but an
  // EventSource or a plain <img> cannot, so a query token is accepted too.
  if (typeof req.query.token === 'string') return req.query.token;
  return '';
}

function requireAuth(req, res, next) {
  // The middleware is mounted at '/api', so req.path has that prefix stripped.
  // Matching on req.path alone would never hit PUBLIC_PATHS and would lock the
  // login route behind the very session it exists to create.
  const fullPath = (req.baseUrl || '') + req.path;
  if (PUBLIC_PATHS.has(fullPath)) return next();

  // Browsers send a credential-less preflight; rejecting it breaks CORS.
  if (req.method === 'OPTIONS') return next();

  const session = sessions.verify(bearerFrom(req));
  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'UNAUTHENTICATED'
    });
  }

  req.session = session;
  return next();
}

/**
 * Fail closed. With no password configured the server would otherwise start
 * wide open, which is exactly the state this change exists to end.
 */
function assertConfigured() {
  if (PASSWORD_HASH) return;

  console.error('');
  console.error('  AUTH_PASSWORD_HASH is not set — refusing to start.');
  console.error('');
  console.error('  Set a password first:');
  console.error('      node src/auth/setup.js');
  console.error('');
  console.error('  It prints a line to paste into .env. Nothing is stored in the clear.');
  console.error('');
  process.exit(1);
}

module.exports = { requireAuth, assertConfigured, bearerFrom, PASSWORD_HASH, PUBLIC_PATHS };
