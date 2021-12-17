import type {
  ConnectAttemptInitializedEvent,
  ConnectHeartbeatFailureEvent,
  ConnectHeartbeatSucceededEvent,
  ConnectResolveSrvErrorEvent,
  ConnectResolveSrvSucceededEvent,
  ConnectMissingOptionalDependencyEvent,
  ConnectLogEmitter
} from './types';

interface MongoLogWriter {
  info(c: string, id: unknown, ctx: string, msg: string, attr?: any): void;
  warn(c: string, id: unknown, ctx: string, msg: string, attr?: any): void;
  error(c: string, id: unknown, ctx: string, msg: string, attr?: any): void;
  mongoLogId(id: number): unknown;
}

export function hookLogger(
  emitter: ConnectLogEmitter,
  log: MongoLogWriter,
  contextPrefix: string,
  redactURICredentials: (uri: string) => string): void {
  const { mongoLogId } = log;
  emitter.on('devtools-connect:connect-attempt-initialized', function(ev: ConnectAttemptInitializedEvent) {
    log.info('DEVTOOLS-CONNECT', mongoLogId(1_000_000_042), `${contextPrefix}-connect`, 'Initiating connection attempt', {
      ...ev,
      uri: redactURICredentials(ev.uri)
    });
  });

  emitter.on('devtools-connect:connect-heartbeat-failure', function(ev: ConnectHeartbeatFailureEvent) {
    log.warn('DEVTOOLS-CONNECT', mongoLogId(1_000_000_034), `${contextPrefix}-connect`, 'Server heartbeat failure', {
      ...ev,
      failure: ev.failure?.message
    });
  });

  emitter.on('devtools-connect:connect-heartbeat-succeeded', function(ev: ConnectHeartbeatSucceededEvent) {
    log.info('DEVTOOLS-CONNECT', mongoLogId(1_000_000_035), `${contextPrefix}-connect`, 'Server heartbeat succeeded', ev);
  });

  emitter.on('devtools-connect:connect-fail-early', function() {
    log.warn('DEVTOOLS-CONNECT', mongoLogId(1_000_000_036), `${contextPrefix}-connect`, 'Aborting connection attempt as irrecoverable');
  });

  emitter.on('devtools-connect:connect-attempt-finished', function() {
    log.info('DEVTOOLS-CONNECT', mongoLogId(1_000_000_037), `${contextPrefix}-connect`, 'Connection attempt finished');
  });

  emitter.on('devtools-connect:resolve-srv-error', function(ev: ConnectResolveSrvErrorEvent) {
    log.error('DEVTOOLS-CONNECT', mongoLogId(1_000_000_038), `${contextPrefix}-connect`, 'Resolving SRV record failed', {
      from: redactURICredentials(ev.from),
      error: ev.error?.message,
      duringLoad: ev.duringLoad
    });
  });

  emitter.on('devtools-connect:resolve-srv-succeeded', function(ev: ConnectResolveSrvSucceededEvent) {
    log.info('DEVTOOLS-CONNECT', mongoLogId(1_000_000_039), `${contextPrefix}-connect`, 'Resolving SRV record succeeded', {
      from: redactURICredentials(ev.from),
      to: redactURICredentials(ev.to)
    });
  });

  emitter.on('devtools-connect:missing-optional-dependency', function(ev: ConnectMissingOptionalDependencyEvent) {
    log.error('DEVTOOLS-CONNECT', mongoLogId(1_000_000_041), `${contextPrefix}-deps`, 'Missing optional dependency', {
      name: ev.name,
      error: ev?.error.message
    });
  });
}
