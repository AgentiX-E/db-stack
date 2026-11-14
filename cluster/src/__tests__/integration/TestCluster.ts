// The harness now lives in src/testing so it can be published as
// `@agentix-e/db-cluster/testing`. This shim keeps the in-repo test imports
// stable.
export * from '../../testing/TestCluster';
