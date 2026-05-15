#!/usr/bin/env node
import DashboardServer from './src/dashboard/index.js';

const port = process.env.DASHBOARD_PORT || 3002;
const orchestratorPort = process.env.PORT || 3001;

const server = new DashboardServer({ port, orchestratorPort });

async function main() {
  try {
    await server.start();
    
    process.on('SIGINT', async () => {
      console.log('\nShutting down dashboard server...');
      await server.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      await server.stop();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Failed to start dashboard:', error);
    process.exit(1);
  }
}

main();
