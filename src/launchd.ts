export interface FoxclawLaunchdPlistOptions {
  label: string;
  nodePath: string;
  nodeArgs: string[];
  entryPoint: string;
  workingDirectory: string;
  pathValue: string;
  home: string;
  user: string;
  logname: string;
  envPath: string;
  proxyEnv: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

export function buildFoxclawLaunchdPlistText(options: FoxclawLaunchdPlistOptions): string {
  const nodeArgXml = options.nodeArgs.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  const proxyEnvXml = buildEnvironmentVariablesXml(options.proxyEnv, 4);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(options.nodePath)}</string>
${nodeArgXml ? `${nodeArgXml}\n` : ''}    <string>${xmlEscape(options.entryPoint)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(options.pathValue)}</string>
    <key>HOME</key>
    <string>${xmlEscape(options.home)}</string>
    <key>USER</key>
    <string>${xmlEscape(options.user)}</string>
    <key>LOGNAME</key>
    <string>${xmlEscape(options.logname)}</string>
    <key>FOXCLAW_ENV</key>
    <string>${xmlEscape(options.envPath)}</string>
${proxyEnvXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.stderrPath)}</string>
</dict>
</plist>
`;
}

export function extractNodePathFromLaunchdPlist(plistText: string): string {
  const programArguments = plistText.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const firstArgument = programArguments?.[1]?.match(/<string>([\s\S]*?)<\/string>/)?.[1] ?? '';
  return firstArgument ? xmlUnescape(firstArgument.trim()) : '';
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function buildEnvironmentVariablesXml(values: Record<string, string>, indent: number): string {
  const prefix = ' '.repeat(indent);
  const entries: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    entries.push(`${prefix}<key>${xmlEscape(key)}</key>`);
    entries.push(`${prefix}<string>${xmlEscape(value)}</string>`);
  }
  return entries.length > 0 ? `${entries.join('\n')}\n` : '';
}
