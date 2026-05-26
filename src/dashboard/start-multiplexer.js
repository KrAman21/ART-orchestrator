#!/usr/bin/env node
import { startMultiplexerServer } from './multiplexer.js';

const port = parseInt(process.env.MULTIPLEXER_PORT || process.env.PORT || '3001', 10);

try {
  startMultiplexerServer(port);
  console.log('');
  console.log('ART multiplexer available at: http://localhost:' + port);
  console.log('Press Ctrl+C to stop');
  console.log('');
} catch (error) {
  console.error('Failed to start multiplexer:', error);
  process.exit(1);
}
