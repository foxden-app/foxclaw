import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFoxclawLaunchdPlistText,
  extractNodePathFromLaunchdPlist,
} from './launchd.js';

test('buildFoxclawLaunchdPlistText writes node, proxy args, env, and log paths', () => {
  const plist = buildFoxclawLaunchdPlistText({
    label: 'app.foxden.foxclaw',
    nodePath: '/Users/alice/.nvm/versions/node/v24.12.0/bin/node',
    nodeArgs: ['--use-env-proxy'],
    entryPoint: '/Users/alice/.local/share/pnpm/global/5/node_modules/@foxden-app/foxclaw/dist/main.js',
    workingDirectory: '/Users/alice/.foxclaw',
    pathValue: '/Users/alice/.nvm/versions/node/v24.12.0/bin:/usr/local/bin:/usr/bin',
    home: '/Users/alice',
    user: 'alice',
    logname: 'alice',
    envPath: '/Users/alice/.foxclaw/.env',
    proxyEnv: {
      HTTP_PROXY: 'http://127.0.0.1:20171',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdoutPath: '/Users/alice/.foxclaw/logs/launchd.out.log',
    stderrPath: '/Users/alice/.foxclaw/logs/launchd.err.log',
  });

  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<string>\/Users\/alice\/\.nvm\/versions\/node\/v24\.12\.0\/bin\/node<\/string>/);
  assert.match(plist, /<string>--use-env-proxy<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<key>FOXCLAW_ENV<\/key>\n {4}<string>\/Users\/alice\/\.foxclaw\/\.env<\/string>/);
  assert.match(plist, /<key>HTTP_PROXY<\/key>\n {4}<string>http:\/\/127\.0\.0\.1:20171<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\n {2}<string>\/Users\/alice\/\.foxclaw\/logs\/launchd\.err\.log<\/string>/);
});

test('launchd plist generation escapes XML-sensitive values', () => {
  const plist = buildFoxclawLaunchdPlistText({
    label: 'app.foxden.foxclaw',
    nodePath: '/Users/a&b/node',
    nodeArgs: [],
    entryPoint: '/Users/a&b/Fox "Claw"/dist/main.js',
    workingDirectory: '/Users/a&b/.foxclaw',
    pathValue: '/usr/local/bin:/usr/bin',
    home: '/Users/a&b',
    user: 'a&b',
    logname: 'a&b',
    envPath: "/Users/a&b/.foxclaw/'env'",
    proxyEnv: { HTTPS_PROXY: 'http://proxy.local/?a=1&b=2' },
    stdoutPath: '/Users/a&b/.foxclaw/logs/out.log',
    stderrPath: '/Users/a&b/.foxclaw/logs/err.log',
  });

  assert.match(plist, /\/Users\/a&amp;b\/node/);
  assert.match(plist, /Fox &quot;Claw&quot;/);
  assert.match(plist, /&apos;env&apos;/);
  assert.match(plist, /http:\/\/proxy\.local\/\?a=1&amp;b=2/);
  assert.equal(extractNodePathFromLaunchdPlist(plist), '/Users/a&b/node');
});

test('extractNodePathFromLaunchdPlist returns empty string for non-FoxClaw plist text', () => {
  assert.equal(extractNodePathFromLaunchdPlist('<plist><dict></dict></plist>'), '');
});
