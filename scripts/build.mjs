import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteSessionIcon, remoteSessionIcons } from '../src/icons.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'plugins/codex-remote-session');
const manifest = JSON.parse(await readFile(path.join(root, 'plugin/manifest.json'), 'utf8'));
await mkdir(path.join(output, '.codex-plugin'), { recursive: true });
await mkdir(path.join(output, 'assets'), { recursive: true });
await writeFile(path.join(output, 'assets/remote-session.svg'), remoteSessionIcon());
await writeFile(path.join(output, 'assets/remote-session-dark.svg'), remoteSessionIcon('dark'));
await mkdir(path.join(root, 'dist'), { recursive: true });
const views = [];
const definitions = { __REMOTE_ICONS__: JSON.stringify(remoteSessionIcons) };
for (const [name, placeholder, constant] of [
  ['connection-test', '__CONNECTION_TEST_SCRIPT__', '__CONNECTION_TEST_HTML__'],
  ['computers', '__COMPUTERS_SCRIPT__', '__COMPUTERS_HTML__'],
]) {
  const view = await build({
    entryPoints: [path.join(root, `src/${name}.jsx`)], bundle: true, write: false,
    platform: 'browser', format: 'iife', target: 'es2022', minify: true, metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const html = (await readFile(path.join(root, `src/${name}.html`), 'utf8'))
    .replaceAll('\r\n', '\n').replace(placeholder, () => view.outputFiles[0].text.replaceAll('</script', '<\\/script'));
  await writeFile(path.join(root, `dist/${name}.html`), html);
  definitions[constant] = JSON.stringify(html);
  views.push(view);
}
const options = {
  bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true,
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
};
const result = await build({
  ...options, entryPoints: [path.join(root, 'src/mcp.mjs')],
  outfile: path.join(output, 'server.mjs'), metafile: true,
  define: definitions,
});
await writeFile(path.join(output, '.codex-plugin/plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(path.join(root, 'plugin/skills'), path.join(output, 'skills'), { recursive: true });
await writeFile(path.join(output, '.mcp.json'), `${JSON.stringify({
  mcpServers: {
    codex_remote: {
      command: 'node', args: ['./server.mjs'], cwd: '.',
      startup_timeout_sec: 30, tool_timeout_sec: 90,
    },
  },
}, null, 2)}\n`);

// Include the license texts for packages incorporated into the server bundle.
const packages = new Set();
for (const input of [result, ...views].flatMap((build) => Object.keys(build.metafile.inputs))) {
  const normalized = input.replaceAll('\\', '/');
  const match = normalized.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(path.resolve(root, match[1]));
}
const notices = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenses = (await readdir(directory)).filter((name) => /^(license|copying)(\.|$)/i.test(name));
  for (const license of licenses) notices.push(`${pkg.name}@${pkg.version}\n${await readFile(path.join(directory, license), 'utf8')}`);
}
await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n--------------------\n\n'));

await mkdir(path.join(root, 'dist/plugin'), { recursive: true });
await cp(output, path.join(root, 'dist/plugin'), { recursive: true });
await cp(path.join(output, 'server.mjs'), path.join(root, `dist/plugin/server-${manifest.version}.mjs`));
for (const role of ['server', 'agent']) {
  await build({
    ...options, entryPoints: [path.join(root, `src/relay-${role}-main.mjs`)],
    outfile: path.join(root, `dist/relay/${role}.mjs`),
  });
}
console.log(`Portable Git marketplace package built: ${output}`);
