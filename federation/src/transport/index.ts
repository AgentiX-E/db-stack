/**
 * @agentix-e/db-federation/transport — the TLS transport on its own.
 *
 * A barrel rather than a path to the module file, because the module also
 * exports `retryDelayMs`, marked `@internal` and read only by its own suite. A
 * subpath that points at a file publishes every module-level export of it, so
 * the `@internal` tag was a claim the package contradicted: the function was
 * importable from `@agentix-e/db-federation/transport` whether or not anyone
 * meant it to be. What is published here is what the module intends to publish.
 */

export { TcpSecureTransport } from './TcpSecureTransport';
export type {
  FederationEnvelope,
  IRaftTransport,
  TcpSecureTransportConfig,
  TcpSecureTransportPeer,
} from './TcpSecureTransport';
