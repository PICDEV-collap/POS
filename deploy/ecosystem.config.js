// PM2 ecosystem — runs both backend and customer-web Next.js as managed processes.
//
// Install:   npm install -g pm2 pm2-windows-service
// Start:     pm2 start deploy/ecosystem.config.js --env production
// Persist:   pm2 save && pm2-service-install -n PM2          (Windows service)
//            pm2 startup                                     (Linux systemd)
// Logs:      pm2 logs                       pm2 monit
// Restart:   pm2 restart pos-v2-backend     pm2 restart all

module.exports = {
  apps: [
    {
      name: 'pos-v2-backend',
      cwd: './backend',
      script: 'src/server.js',
      instances: 1,                  // single instance — print queue worker is in-process
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: '4000',
      },
      out_file: './backend/logs/out.log',
      error_file: './backend/logs/err.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'pos-v2-web',
      cwd: './customer-web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
      out_file: './customer-web/logs/out.log',
      error_file: './customer-web/logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
