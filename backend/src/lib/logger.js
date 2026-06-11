function log(level, scope, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  debug: (scope, message, meta) => log('debug', scope, message, meta),
  info: (scope, message, meta) => log('info', scope, message, meta),
  warn: (scope, message, meta) => log('warn', scope, message, meta),
  error: (scope, message, meta) => log('error', scope, message, meta),
};
