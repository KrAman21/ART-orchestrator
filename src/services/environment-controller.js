export class EnvironmentController {
  constructor(env = process.env.NODE_ENV || 'local') {
    this.env = env;
    this.environments = {
      local: {
        name: 'Local Development',
        LSP: {
          baseUrl: process.env.LSP_URL_LOCAL || 'http://localhost:8080',
          name: 'LSP-Local',
          unixSocket: process.env.LSP_UNIX_SOCKET || null
        },
        GW: {
          baseUrl: process.env.GW_URL_LOCAL || 'http://localhost:8011',
          name: 'Gateway-Local',
          unixSocket: process.env.GW_UNIX_SOCKET || null
        },
        GATEWAY: {
          baseUrl: process.env.GW_URL_LOCAL || 'http://localhost:8011',
          name: 'Gateway-Local',
          unixSocket: process.env.GW_UNIX_SOCKET || null
        }
      },
      sbx: {
        name: 'Sandbox Environment',
        LSP: {
          baseUrl: process.env.LSP_URL_SBX || 'https://integ-expresscheckout-api.juspay.in/credit/',
          name: 'LSP-Sandbox',
          unixSocket: null
        },
        GW: {
          baseUrl: process.env.GW_URL_SBX || 'http://localhost:8011',
          name: 'Gateway-Sandbox',
          unixSocket: null
        },
        GATEWAY: {
          baseUrl: process.env.GW_URL_SBX || 'http://localhost:8011',
          name: 'Gateway-Sandbox',
          unixSocket: null
        }
      }
    };
  }

  setEnvironment(env) {
    if (!this.environments[env]) {
      throw new Error(`Invalid environment: ${env}. Valid options: local, sbx`);
    }
    this.env = env;
    return this.getConfig();
  }

  getConfig() {
    return this.environments[this.env];
  }

  getServiceBaseUrl(serviceName) {
    const config = this.getConfig();
    return config[serviceName]?.baseUrl;
  }

  getCurrentEnv() {
    return {
      name: this.env,
      displayName: this.environments[this.env].name
    };
  }

  updateServiceMap(serviceMap) {
    const config = this.getConfig();
    serviceMap.LSP.baseUrl = config.LSP.baseUrl;
    serviceMap.LSP.name = config.LSP.name;
    serviceMap.LSP.unixSocket = config.LSP.unixSocket;
    serviceMap.GW.baseUrl = config.GW.baseUrl;
    serviceMap.GW.name = config.GW.name;
    serviceMap.GW.unixSocket = config.GW.unixSocket;
    serviceMap.GATEWAY.baseUrl = config.GATEWAY.baseUrl;
    serviceMap.GATEWAY.name = config.GATEWAY.name;
    serviceMap.GATEWAY.unixSocket = config.GATEWAY.unixSocket;
  }
}

export function createEnvironmentController(env) {
  return new EnvironmentController(env);
}

export default EnvironmentController;
