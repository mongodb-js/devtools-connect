export interface ConnectAttemptInitializedEvent {
  uri: string;
  driver: { name: string, version: string };
  devtoolsConnectVersion: string;
  host: string;
}

export interface ConnectHeartbeatFailureEvent {
  connectionId: string;
  failure: Error;
  isFailFast: boolean;
  isKnownServer: boolean;
}

export interface ConnectHeartbeatSucceededEvent {
  connectionId: string;
}

export interface ConnectDnsResolutionDetail {
  query: 'TXT' | 'SRV';
  hostname: string;
  error?: string;
  wasNativelyLookedUp?: boolean;
}

export interface ConnectResolveSrvErrorEvent {
  from: string;
  error: Error;
  duringLoad: boolean;
  resolutionDetails: ConnectDnsResolutionDetail[];
}

export interface ConnectResolveSrvSucceededEvent {
  from: string;
  to: string;
  resolutionDetails: ConnectDnsResolutionDetail[];
}

export interface ConnectMissingOptionalDependencyEvent {
  name: string;
  error: Error;
}

export interface ConnectUsedSystemCAEvent {
  caCount: number;
  asyncFallbackError: Error | undefined;
}

export interface ConnectEventMap {
  /** Signals that a connection attempt is about to be performed. */
  'devtools-connect:connect-attempt-initialized': (ev: ConnectAttemptInitializedEvent) => void;
  /** Signals that communicating to a specific server during connection did not succeed. */
  'devtools-connect:connect-heartbeat-failure': (ev: ConnectHeartbeatFailureEvent) => void;
  /** Signals that communicating to a specific server during connection succeeded. */
  'devtools-connect:connect-heartbeat-succeeded': (ev: ConnectHeartbeatSucceededEvent) => void;
  /** Signals that the service provider failed to connect because it deemed further attempts futile. */
  'devtools-connect:connect-fail-early': () => void;
  /** Signals that the service provider finished attempting to connect, regardless of success. */
  'devtools-connect:connect-attempt-finished': () => void;
  /** Signals that resolving an mongodb+srv:// URL failed. */
  'devtools-connect:resolve-srv-error': (ev: ConnectResolveSrvErrorEvent) => void;
  /** Signals that resolving an mongodb+srv:// URL succeeded. */
  'devtools-connect:resolve-srv-succeeded': (ev: ConnectResolveSrvSucceededEvent) => void;
  /** Signals that an optional dependency of the mongodb package is missing. */
  'devtools-connect:missing-optional-dependency': (ev: ConnectMissingOptionalDependencyEvent) => void;
  /** Signals that the list of system certificates has been loaded and used for connecting. */
  'devtools-connect:used-system-ca': (ev: ConnectUsedSystemCAEvent) => void;
}

export interface ConnectLogEmitter {
  // TypeScript uses something like this itself for its EventTarget definitions.
  on<K extends keyof ConnectEventMap>(event: K, listener: ConnectEventMap[K]): this;
  once<K extends keyof ConnectEventMap>(event: K, listener: ConnectEventMap[K]): this;
  emit<K extends keyof ConnectEventMap>(event: K, ...args: ConnectEventMap[K] extends (...args: infer P) => any ? P : never): unknown;
}
