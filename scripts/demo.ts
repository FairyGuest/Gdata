/** Local demo: boots the service with the demo config and walks through the main flows. */
process.env.VAULT_CONFIG = process.env.VAULT_CONFIG ?? 'config/demo.json';
import('../src/index.js');
