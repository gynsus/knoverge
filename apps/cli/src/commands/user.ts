import { Command } from 'commander';

import { withServices } from '../run.ts';

/**
 * Regaining access to an account, for an installation with no mail server to
 * send a reset link through (ADR 0014).
 *
 * These exist for the case the web interface cannot cover: the last owner, who
 * by construction has nobody above them to reset their password. They grant
 * nothing new — whoever can run this can already read the ledger key and write
 * to the database — but the work goes through the domain service, so it is
 * validated and the password rules still apply.
 */
export function userCommand(): Command {
  const user = new Command('user').description('Accounts: reset a password, change an address');

  user
    .command('password-reset')
    .description('Set a new password for an account, without knowing the old one')
    .requiredOption('--email <email>')
    .option('--password <password>', 'read from KNOVERGE_NEW_PASSWORD when omitted')
    .action(async (opts: { email: string; password?: string }) => {
      const password = opts.password ?? process.env['KNOVERGE_NEW_PASSWORD'];
      if (!password) {
        console.error('provide --password or KNOVERGE_NEW_PASSWORD');
        process.exitCode = 1;
        return;
      }
      await withServices(async (services) => {
        const account = await services.users.findByEmail(opts.email);
        if (!account) {
          console.error(`no account for ${opts.email}`);
          process.exitCode = 1;
          return;
        }
        const revoked = await services.users.resetPasswordAsOperator(account.id, password);
        console.log(`password set for ${account.id}; ${revoked} session(s) revoked`);
      });
    });

  user
    .command('email')
    .description('Change the address an account signs in with')
    .requiredOption('--email <email>', 'the address now on the account')
    .requiredOption('--to <email>', 'the address to change it to')
    .action(async (opts: { email: string; to: string }) => {
      await withServices(async (services) => {
        const account = await services.users.findByEmail(opts.email);
        if (!account) {
          console.error(`no account for ${opts.email}`);
          process.exitCode = 1;
          return;
        }
        const revoked = await services.users.setEmailAsOperator(account.id, opts.to);
        console.log(`${account.id} now signs in as ${opts.to}; ${revoked} session(s) revoked`);
      });
    });

  return user;
}
