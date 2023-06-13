import type { ConnectLogEmitter } from './index';
import { isFastFailureConnectionError } from './fast-failure-connect';
import type {
  MongoClient,
  MongoClientOptions,
  ServerHeartbeatFailedEvent,
  ServerHeartbeatSucceededEvent,
  TopologyDescription
} from 'mongodb';
import type { ConnectDnsResolutionDetail, ConnectEventArgs, ConnectEventMap } from './types';
import { systemCertsAsync, Options as SystemCAOptions } from 'system-ca';
import type { MongoDBOIDCPlugin, MongoDBOIDCPluginOptions } from '@mongodb-js/oidc-plugin';
import { createMongoDBOIDCPlugin } from '@mongodb-js/oidc-plugin';
import merge from 'lodash.merge';
import { oidcServerRequestHandler } from './oidc/handler';
import { StateShareClient, StateShareServer } from './ipc-rpc-state-share';
import ConnectionString, { CommaAndColonSeparatedRecord } from 'mongodb-connection-string-url';
import EventEmitter from 'events';

const isAtlas = (str: string) => str.match(/mongodb.net[:/]/i);

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
    } else if (isAtlas(uri)) {
      (err as Error).message =  'It looks like this is a MongoDB Atlas cluster. Please ensure that your IP whitelist allows connections from your network.';
    }
    throw err;
  } finally {
    client.removeListener('serverHeartbeatFailed', heartbeatFailureListener);
    client.removeListener('serverHeartbeatSucceeded', heartbeatSucceededListener);
    logger.emit('devtools-connect:connect-attempt-finished', {
      cryptSharedLibVersionInfo: (client?.autoEncrypter as any /* NODE-4285 */)?.cryptSharedLibVersionInfo
    });
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

// Wrapper for all state that a devtools application may want to share
// between MongoClient instances. Currently, this is only the OIDC state.
// There are two ways of sharing this state:
// - When re-used within the same process/address space, it can be passed
//   to `connectMongoClient()` as `parentState` directly.
// - When re-used across processes, an RPC server can be used over an IPC
//   channel by calling `.getStateShareServer()`, which returns a string
//   that can then be passed to `connectMongoClient()` as `parentHandle`
//   and which should be considered secret since it contains auth information
//   for that RPC server.
export class DevtoolsConnectionState {
  public oidcPlugin: MongoDBOIDCPlugin;
  public productName: string;

  private stateShareClient: StateShareClient | null = null;
  private stateShareServer: StateShareServer | null = null;

  constructor(options: Pick<DevtoolsConnectOptions, 'productDocsLink' | 'productName' | 'oidc' | 'parentHandle'>, logger: ConnectLogEmitter) {
    this.productName = options.productName;
    if (options.parentHandle) {
      this.stateShareClient = new StateShareClient(options.parentHandle);
      this.oidcPlugin = this.stateShareClient.oidcPlugin;
    } else {
      // Create a separate logger instance for the plugin and "copy" events over
      // to the main logger instance, so that when we attach listeners to the plugins,
      // they are only triggered for events from that specific plugin instance
      // (and not other OIDCPlugin instances that might be running on the same logger).
      const proxyingLogger = new EventEmitter();
      proxyingLogger.emit = function<K extends keyof ConnectEventMap>(event: K, ...args: ConnectEventArgs<K>) {
        logger.emit(event, ...args);
        return EventEmitter.prototype.emit.call(this, event, ...args);
      };
      this.oidcPlugin = createMongoDBOIDCPlugin({
        ...options.oidc,
        logger: proxyingLogger,
        redirectServerRequestHandler: oidcServerRequestHandler.bind(null, options)
      });
    }
  }

  async getStateShareServer(): Promise<string> {
    this.stateShareServer ??= await StateShareServer.create(this);
    return this.stateShareServer.handle;
  }

  async destroy(): Promise<void> {
    await this.stateShareServer?.close();
    await this.oidcPlugin?.destroy();
  }
}

export interface DevtoolsConnectOptions extends MongoClientOptions {
  /**
   * Whether to read the system certificate store and pass that as the `ca` option
   * to the driver for certificate validation.
   */
  useSystemCA?: boolean;
  /**
   * An URL that refers to the documentation for the current product.
   */
  productDocsLink: string;
  /**
   * A human-readable name for the current product (e.g. "MongoDB Compass").
   */
  productName: string;
  /**
   * A set of options to pass when creating the OIDC plugin. Ignored if `parentState` is set.
   */
  oidc?: Omit<MongoDBOIDCPluginOptions, 'logger' | 'redirectServerRequestHandler'>;
  /**
   * A `DevtoolsConnectionState` object that refers to the state resulting from another
   * `connectMongoClient()` call.
   */
  parentState?: DevtoolsConnectionState;
  /**
   * Similar to `parentState`, an opaque handle returned from `createShareStateServer()`
   * may be used to share state from another `DevtoolsConnectionState` instance, possibly
   * residing in another process. This handle should generally be considered a secret.
   *
   * In this case, the application needs to ensure that the lifetime of the top-level state
   * extends beyond the lifetime(s) of the respective dependent state instance(s).
   */
  parentHandle?: string;
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
  MongoClientClass: typeof MongoClient): Promise<{
    client: MongoClient,
    state: DevtoolsConnectionState
  }> {
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
      ca: ca.join('\n')
    };
  }

  // If PROVIDER_NAME was specified to the MongoClient options, adding callbacks would conflict
  // with that; we should omit them so that e.g. mongosh users can leverage the non-human OIDC
  // auth flows by specifying PROVIDER_NAME.
  const shouldAddOidcCallbacks = isHumanOidcFlow(uri, clientOptions);
  const state = clientOptions.parentState ?? new DevtoolsConnectionState(clientOptions, logger);
  const mongoClientOptions: MongoClientOptions & Partial<DevtoolsConnectOptions> =
    merge({}, clientOptions, shouldAddOidcCallbacks ? state.oidcPlugin.mongoClientOptions : {});
  delete mongoClientOptions.useSystemCA;
  delete mongoClientOptions.productDocsLink;
  delete mongoClientOptions.productName;
  delete mongoClientOptions.oidc;
  delete mongoClientOptions.parentState;
  delete mongoClientOptions.parentHandle;

  if (mongoClientOptions.autoEncryption !== undefined &&
    !mongoClientOptions.autoEncryption.bypassAutoEncryption &&
    !mongoClientOptions.autoEncryption.bypassQueryAnalysis) {
    // connect first without autoEncryption and serverApi options.
    const optionsWithoutFLE = { ...mongoClientOptions };
    delete optionsWithoutFLE.autoEncryption;
    delete optionsWithoutFLE.serverApi;
    const client = new MongoClientClass(uri, optionsWithoutFLE);
    state.oidcPlugin.logger.on('mongodb-oidc-plugin:auth-failed', () => client.close());
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
  const client = new MongoClientClass(uri, mongoClientOptions);
  state.oidcPlugin.logger.on('mongodb-oidc-plugin:auth-failed', () => client.close());
  await connectWithFailFast(uri, client, logger);
  if (client.autoEncrypter) {
    // Enable Devtools-specific CSFLE result decoration.
    (client.autoEncrypter as any)[Symbol.for('@@mdb.decorateDecryptionResult')] = true;
  }
  return { client, state };
}

export function isHumanOidcFlow(uri: string, clientOptions: MongoClientOptions): boolean {
  if (
    (clientOptions.authMechanism && clientOptions.authMechanism !== 'MONGODB-OIDC') ||
    clientOptions.authMechanismProperties?.PROVIDER_NAME
  ) {
    return false;
  }
  let cs: ConnectionString;
  try {
    cs = new ConnectionString(uri, { looseValidation: true });
  } catch {
    return false;
  }

  const sp = cs.typedSearchParams<MongoClientOptions>();
  const authMechanism = clientOptions.authMechanism ?? sp.get('authMechanism');
  return authMechanism === 'MONGODB-OIDC' && !new CommaAndColonSeparatedRecord(
    sp.get('authMechanismProperties')
  ).get('PROVIDER_NAME');
}
