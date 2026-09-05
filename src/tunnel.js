const localtunnel = require('localtunnel');

(async () => {
  try {
    const tunnel = await localtunnel({ port: 5000, subdomain: 'autobill-savage' });
    console.log('\n======================================================');
    console.log('🚀 Public Live Web App Link (HTTPS):');
    console.log(tunnel.url);
    console.log('======================================================\n');

    tunnel.on('close', () => {
      console.log('Tunnel closed');
    });
  } catch (err) {
    console.error('Tunnel error:', err.message);
  }
})();
