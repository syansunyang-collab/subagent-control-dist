"""Read-only package/config discovery; never resolve or print credential values."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

FIELDS = {
    'provider', 'searchProvider', 'searchRouting', 'fetchRouting', 'workflow',
    'summaryModel', 'summaryGenerationDeadlineMs', 'pageAnswer', 'searchModel',
    'openaiSearchModel', 'xaiSearchModel', 'serpdiveModel', 'curatorTimeoutSeconds',
    'autoOpenBrowser', 'allowBrowserCookies', 'chromeProfile', 'webSearch', 'tools',
    'toolNames', 'commands', 'image', 'githubClone', 'youtube', 'video', 'pdf',
    'fetchContent', 'ssrf', 'shortcuts', 'curatorRemote',
}
ENDPOINTS = {'openaiResponsesUrl', 'geminiBaseUrl', 'searxngBaseUrl', 'firecrawlBaseUrl'}
ENV_KEYS = ['OPENAI_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
            'TINYFISH_API_KEY', 'SEARCH1API_KEY', 'SEARCHINFINITY_API_KEY', 'QUERIT_API_KEY',
            'TAVILY_API_KEY', 'JINA_API_KEY', 'SERPDIVE_API_KEY', 'KAGI_API_KEY',
            'OLLAMA_API_KEY', 'SERPBASE_API_KEY', 'ANYSEARCH_API_KEY', 'XAI_API_KEY',
            'BRIGHTDATA_API_KEY', 'FIRECRAWL_API_KEY', 'PERPLEXITY_API_KEY',
            'GEMINI_API_KEY', 'DATALAB_API_KEY', 'CLOUDFLARE_API_KEY']

def read_json(path):
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        raise ValueError(f'Invalid JSON: {path.name}, line {exc.lineno}, column {exc.colno}') from None
    if not isinstance(value, dict):
        raise ValueError(f'Expected JSON object: {path.name}')
    return value

def credential_kind(value):
    if not isinstance(value, str) or not value:
        return 'unset'
    if value.startswith(('$$', '$!')):
        return 'literal-escaped'
    if value.startswith('$'):
        return 'environment-reference'
    if value.startswith('!'):
        return 'command-reference'
    return 'literal'

def redact_nested(value):
    if isinstance(value, dict):
        return {k: ('[redacted]' if k.lower().endswith(('apikey', 'password', 'secret')) or k.lower() in {'authorization', 'headers', 'token'} else redact_nested(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_nested(v) for v in value]
    return value

def sanitize(config):
    selected = {k: redact_nested(config[k]) for k in sorted(FIELDS) if k in config}
    credentials = {k: credential_kind(v) for k, v in config.items() if k.endswith('ApiKey')}
    endpoints = {}
    for k in ENDPOINTS:
        if k not in config:
            continue
        url = urlsplit(str(config[k]))
        endpoints[k] = {'configured': bool(config[k]), 'scheme': url.scheme, 'host': url.hostname}
    return {'values': selected, 'credentialSources': credentials, 'endpoints': endpoints,
            'searxngHeaderNames': list(config.get('searxngHeaders', {})) if isinstance(config.get('searxngHeaders'), dict) else []}

def inspect(agent, config, package=None):
    candidates = []
    if package:
        candidates.append(package)
    else:
        for item in read_json(agent / 'settings.json').get('packages', []):
            source = item if isinstance(item, str) else item.get('source', '')
            if source.startswith('npm:'):
                name = source[4:]
                if '@' in name[1:]:
                    name = name.rsplit('@', 1)[0]
                candidate = agent / 'npm/node_modules' / name
            else:
                candidate = Path(source)
                if not candidate.is_absolute():
                    candidate = agent / candidate
            meta = read_json(candidate / 'package.json')
            if meta.get('name') == 'pi-web-access':
                candidates.append(candidate)
    return {
        'diskSnapshotOnly': True, 'configPath': str(config), 'configExists': config.exists(),
        'packages': [{'path': str(p), 'version': read_json(p / 'package.json').get('version'),
                      'localPageAnswerDefaultsPresent': 'getPageAnswerDefaults' in (p / 'feature-config.ts').read_text(encoding='utf-8') if (p / 'feature-config.ts').exists() else False}
                     for p in candidates],
        **sanitize(read_json(config)),
        'environmentCredentialPresence': {k: bool(os.environ.get(k)) for k in ENV_KEYS},
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent-dir', type=Path)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--package-dir', type=Path)
    args = parser.parse_args()
    agent = args.agent_dir or Path(os.environ.get('PI_CODING_AGENT_DIR', Path.home() / '.pi/agent'))
    base = Path(os.environ['PI_CODING_AGENT_DIR']) if os.environ.get('PI_CODING_AGENT_DIR') else (Path(os.environ['XDG_CONFIG_HOME']) / 'pi' if os.environ.get('XDG_CONFIG_HOME') else Path.home() / '.pi')
    try:
        result = inspect(agent, args.config or base / 'web-search.json', args.package_dir)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'{exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
