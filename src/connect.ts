import type { ConnectLogEmitter } from './index';
import { isFastFailureConnectionError } from './fast-failure-connect';
import type {
  MongoClient,
  MongoClientOptions,
  ServerHeartbeatFailedEvent,
  ServerHeartbeatSucceededEvent,
  TopologyDescription
} from 'mongodb';
import type { ConnectDnsResolutionDetail } from './types';
import { systemCertsAsync, Options as SystemCAOptions } from 'system-ca';

export class MongoAutoencryptionUnavailable extends Error {
  constructor() {
    super('Automatic encryption is only available with Atlas and MongoDB Enterprise');
  }
}

/**
 * Takes an unconnected MongoClient and connects it, but fails fast for certain
 * errors.
 */
async function connectWithFailFast(uri: string, client: MongoClient, logger: ConnectLogEmitter): Promise<void> {
  const failedConnections = new Map<string, Error>();
  let failEarlyClosePromise: Promise<void> | null = null;
  logger.emit('devtools-connect:connect-attempt-initialized', {
    uri,
    driver: client.options.metadata.driver,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    devtoolsConnectVersion: require('../package.json').version,
    host: client.options.srvHost ?? client.options.hosts.join(',')
  });

  const heartbeatFailureListener = ({ failure, connectionId }: ServerHeartbeatFailedEvent) => {
    const topologyDescription: TopologyDescription | undefined = (client as any).topology?.description;
    const servers = topologyDescription?.servers;
    const isFailFast = isFastFailureConnectionError(failure);
    const isKnownServer = !!servers?.has(connectionId);
    logger.emit('devtools-connect:connect-heartbeat-failure', {
      connectionId,
      failure,
      isFailFast,
      isKnownServer
    });
    if (!isKnownServer) {
      return;
    }

    if (isFailFast && servers) {
      failedConnections.set(connectionId, failure);
      if ([...servers.keys()].every(server => failedConnections.has(server))) {
        logger.emit('devtools-connect:connect-fail-early');
        // Setting this variable indicates that we are failing early.
        failEarlyClosePromise = client.close();
      }
    }
  };

  const heartbeatSucceededListener = ({ connectionId }: ServerHeartbeatSucceededEvent) => {
    logger.emit('devtools-connect:connect-heartbeat-succeeded', { connectionId });
    failedConnections.delete(connectionId);
  };

  client.addListener('serverHeartbeatFailed', heartbeatFailureListener);
  client.addListener('serverHeartbeatSucceeded', heartbeatSucceededListener);
  try {
    await client.connect();
  } catch (err: unknown) {
    if (failEarlyClosePromise !== null) {
      await failEarlyClosePromise;
      throw failedConnections.values().next().value; // Just use the first failure.
    }
    throw err;
  } finally {
    client.removeListener('serverHeartbeatFailed', heartbeatFailureListener);
    client.removeListener('serverHeartbeatSucceeded', heartbeatSucceededListener);
    logger.emit('devtools-connect:connect-attempt-finished');
  }
}

let resolveDnsHelpers: {
  resolve: typeof import('resolve-mongodb-srv'),
  osDns: typeof import('os-dns-native')
} | undefined;

async function resolveMongodbSrv(uri: string, logger: ConnectLogEmitter): Promise<string> {
  const resolutionDetails: ConnectDnsResolutionDetail[] = [];
  if (uri.startsWith('mongodb+srv://')) {
    try {
      resolveDnsHelpers ??= {
        resolve: require('resolve-mongodb-srv'),
        osDns: require('os-dns-native')
      };
    } catch (error: any) {
      logger.emit('devtools-connect:resolve-srv-error', {
        from: '', error, duringLoad: true, resolutionDetails
      });
    }
    if (resolveDnsHelpers !== undefined) {
      try {
        const {
          wasNativelyLookedUp,
          withNodeFallback: { resolveSrv, resolveTxt }
        } = resolveDnsHelpers.osDns;
        const resolved = await resolveDnsHelpers.resolve(uri, {
          dns: {
            resolveSrv(hostname: string, cb: Parameters<typeof resolveSrv>[1]) {
              resolveSrv(hostname, (...args: Parameters<Parameters<typeof resolveSrv>[1]>) => {
                resolutionDetails.push({
                  query: 'SRV', hostname, error: args[0]?.message, wasNativelyLookedUp: wasNativelyLookedUp(args[1])
                });
                // eslint-disable-next-line node/no-callback-literal
                cb(...args);
              });
            },
            resolveTxt(hostname: string, cb: Parameters<typeof resolveTxt>[1]) {
              resolveTxt(hostname, (...args: Parameters<Parameters<typeof resolveTxt>[1]>) => {
                resolutionDetails.push({
                  query: 'TXT', hostname, error: args[0]?.message, wasNativelyLookedUp: wasNativelyLookedUp(args[1])
                });
                // eslint-disable-next-line node/no-callback-literal
                cb(...args);
              });
            }
          }
        });
        logger.emit('devtools-connect:resolve-srv-succeeded', { from: uri, to: resolved, resolutionDetails });
        return resolved;
      } catch (error: any) {
        logger.emit('devtools-connect:resolve-srv-error', { from: uri, error, duringLoad: false, resolutionDetails });
        throw error;
      }
    }
  }
  return uri;
}

function detectAndLogMissingOptionalDependencies(logger: ConnectLogEmitter) {
  // These need to be literal require('string') calls for bundling purposes.
  try {
    require('saslprep');
  } catch (error: any) {
    logger.emit('devtools-connect:missing-optional-dependency', { name: 'saslprep', error });
  }
  try {
    require('mongodb-client-encryption');
  } catch (error: any) {
    logger.emit('devtools-connect:missing-optional-dependency', { name: 'mongodb-client-encryption', error });
  }
  try {
    require('os-dns-native');
  } catch (error: any) {
    logger.emit('devtools-connect:missing-optional-dependency', { name: 'os-dns-native', error });
  }
  try {
    require('resolve-mongodb-srv');
  } catch (error: any) {
    logger.emit('devtools-connect:missing-optional-dependency', { name: 'resolve-mongodb-srv', error });
  }
  try {
    require('kerberos');
  } catch (error: any) {
    logger.emit('devtools-connect:missing-optional-dependency', { name: 'kerberos', error });
  }
}

export interface DevtoolsConnectOptions extends MongoClientOptions {
  useSystemCA?: boolean;
}

/**
 * Connect a MongoClient. If AutoEncryption is requested, first connect without the encryption options and verify that
 * the connection is to an enterprise cluster. If not, then error, otherwise close the connection and reconnect with the
 * options the user initially specified. Provide the client class as an additional argument in order to test.
 */
export async function connectMongoClient(
  uri: string,
  clientOptions: DevtoolsConnectOptions,
  logger: ConnectLogEmitter,
  MongoClientClass: typeof MongoClient): Promise<MongoClient> {
  detectAndLogMissingOptionalDependencies(logger);
  if (clientOptions.useSystemCA) {
    const systemCAOpts: SystemCAOptions = { includeNodeCertificates: true };
    const ca = await systemCertsAsync(systemCAOpts);
    logger.emit('devtools-connect:used-system-ca', {
      caCount: ca.length,
      asyncFallbackError: systemCAOpts.asyncFallbackError
    });
    clientOptions = {
      ...clientOptions,
      ca
    };
  }
  if (clientOptions.autoEncryption !== undefined &&
    !clientOptions.autoEncryption.bypassAutoEncryption) {
    // connect first without autoEncryption and serverApi options.
    const optionsWithoutFLE = { ...clientOptions };
    delete optionsWithoutFLE.autoEncryption;
    delete optionsWithoutFLE.serverApi;
    const client = new MongoClientClass(uri, optionsWithoutFLE);
    await connectWithFailFast(uri, client, logger);
    const buildInfo = await client.db('admin').admin().command({ buildInfo: 1 });
    await client.close();
    if (
      !(buildInfo.modules?.includes('enterprise')) &&
      !(buildInfo.gitVersion?.match(/enterprise/))
    ) {
      throw new MongoAutoencryptionUnavailable();
    }
  }
  uri = await resolveMongodbSrv(uri, logger);
  const client = new MongoClientClass(uri, clientOptions);
  await connectWithFailFast(uri, client, logger);
  return client;
}
