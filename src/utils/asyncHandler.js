/**
 * asyncHandler - wrap async route handlers.
 *
 * WHY IT EXISTS
 *   Async route handlers must forward rejections to Express error handling.
 *   Express 5 forwards rejected promises automatically, but this wrapper is
 *   kept so the codebase works on Express 4 semantics too and to make the
 *   intent explicit.
 *
 * RESPONSIBILITY
 *   Return a middleware that awaits the handler and catches any rejection
 *   into `next(err)`, so the global error middleware formats it.
 *
 * HOW TO EXTEND
 *   Nothing to change. Apply it to every async controller method.
 */

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
