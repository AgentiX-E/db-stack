/**
 * Self-signed TLS certificate generation for integration tests.
 *
 * Uses node-forge to generate CA + server certs per node.
 * Compatible with Node.js v24+ without experimental APIs.
 *
 * CRITICAL NOTES (Node.js v24.14):
 *   1. CN MUST be `raft-node-N` — ConnectionPool._createTLSSocket
 *      checkServerIdentity validates CN against `raft-node-${peerId}`.
 *   2. SAN MUST include `DNS:raft-node-N` — same checkServerIdentity
 *      validates SAN includes this entry.
 *   3. extKeyUsage is OMITTED — Node.js v24 maps it as OID strings
 *      (e.g. "1.3.6.1.5.5.7.3.1") not friendly names ("serverAuth"),
 *      causing includes("serverAuth") check in ConnectionPool to fail.
 *   4. keyUsage IS included (digitalSignature + keyEncipherment).
 *   5. TLS 1.3 only, CA must have basicConstraints: cA=true.
 */

import forge from 'node-forge';

const pki = forge.pki;

export interface CertBundle {
  key: string;
  cert: string;
  ca: string;
}

function generateCA(): { key: forge.pki.rsa.PrivateKey; certPem: string } {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);

  const attrs = [{ name: 'commonName', value: 'Integration Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: keys.privateKey, certPem: pki.certificateToPem(cert) };
}

function generateNodeCert(caKey: forge.pki.rsa.PrivateKey, caPemCert: string, nodeName: string): CertBundle {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16) + Math.random().toString(16).slice(2);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);

  const attrs = [{ name: 'commonName', value: nodeName }];
  cert.setSubject(attrs);
  cert.setIssuer([{ name: 'commonName', value: 'Integration Test CA' }]);

  // IMPORTANT: Only include keyUsage, NOT extKeyUsage.
  // Node.js v24 maps extKeyUsage OIDs as raw OID strings
  // not friendly names, breaking ConnectionPool's checkServerIdentity.
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: nodeName }, // DNS:raft-node-N (required)
        { type: 2, value: 'localhost' }, // DNS:localhost
        { type: 7, value: '127.0.0.1' }, // IP:127.0.0.1
      ],
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return {
    key: pki.privateKeyToPem(keys.privateKey),
    cert: pki.certificateToPem(cert),
    ca: caPemCert,
  };
}

export interface TestClusterCerts {
  caPem: string;
  nodes: CertBundle[];
  rogue: CertBundle;
}

export function generateClusterCerts(nodeCount: number): TestClusterCerts {
  const ca = generateCA();

  const nodes: CertBundle[] = [];
  for (let i = 1; i <= nodeCount; i++) {
    nodes.push(generateNodeCert(ca.key, ca.certPem, `raft-node-${i}`));
  }

  // Generate a rogue CA + cert for rejection testing
  const rogueCA = generateCA();
  const rogue = generateNodeCert(rogueCA.key, rogueCA.certPem, 'rogue-node');

  return { caPem: ca.certPem, nodes, rogue };
}
