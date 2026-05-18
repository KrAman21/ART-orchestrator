import { mkdirSync, chmodSync, unlinkSync, existsSync } from 'fs';
import { dirname } from 'path';

export function setupUnixSocket(socketPath) {
  const socketDir = dirname(socketPath);
  if (socketDir && socketDir !== '.') {
    mkdirSync(socketDir, { recursive: true });
  }

  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch {}
  }

  return socketPath;
}

export function configureSocketPermissions(socketPath) {
  chmodSync(socketPath, 0o660);
}

export function cleanupSocket(socketPath) {
  if (socketPath && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch {}
  }
}