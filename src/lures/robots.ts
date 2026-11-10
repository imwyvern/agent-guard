export function robotsLines(paths: string[]): string[] { return ['# agent-guard decoys', ...paths.map(p => 'Disallow: ' + p)]; }
export function appendRobots(body: string, lines: string[]): string { return body + (body.endsWith('\n') ? '' : '\n') + lines.join('\n') + '\n'; }
