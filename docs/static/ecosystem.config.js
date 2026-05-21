// PM2 ecosystem file — reference production setup.
//
// One supervisor process (`ethos run-all`) spawns and watches:
//   • ethos gateway start          (Telegram + Slack + Discord + Email bots)
//   • ethos serve                    (web dashboard :3000, ACP server :3001)
//
// PM2's job here is reboot survival: it restarts `ethos run-all` if the
// supervisor itself dies, and `pm2 startup` wires it into your init system so
// it comes back after a reboot.
//
// Quickstart:
//
//   npm i -g @ethosagent/cli pm2
//   ethos setup
//   pm2 start ecosystem.config.js && pm2 save && pm2 startup
//
// Logs land in ~/.ethos/logs/{gateway,serve}.log (managed by ethos run-all)
// and ~/.pm2/logs/ethos.log (managed by PM2 — supervisor-level output).
//
// Full guide: https://ethosagent.ai/docs/using/how-to/deploy-in-production

module.exports = {
  apps: [
    {
      name: 'ethos',
      script: 'ethos',
      args: 'run-all',
      // Kill children on crash-restart; PM2 also restarts ethos run-all itself
      // if it exits non-zero (which run-all does after a 10-crash window).
      autorestart: true,
      max_restarts: 5,
      restart_delay: 2_000,
      // Supervisor-level log; child logs are handled inside ~/.ethos/logs/.
      out_file: '~/.pm2/logs/ethos-out.log',
      error_file: '~/.pm2/logs/ethos-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
