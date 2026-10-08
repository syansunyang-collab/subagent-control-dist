import json
import tempfile
import unittest
from pathlib import Path
from inspect_web_access import inspect, read_json

class InspectionTests(unittest.TestCase):
    def test_redacts_credentials_and_does_not_mutate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent = root / 'agent'
            package = agent / 'npm/node_modules/pi-web-access'
            package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'name': 'pi-web-access', 'version': 'fixture'}))
            (package / 'feature-config.ts').write_text('export function getPageAnswerDefaults() {}')
            (agent / 'settings.json').write_text(json.dumps({'packages': ['npm:pi-web-access']}))
            cfg = root / 'web-search.json'
            cfg.write_text(json.dumps({'provider': 'openai', 'pageAnswer': {'model': 'provider/fixture', 'reasoning': 'low'},
                'openaiApiKey': 'SECRET_VALUE', 'jinaApiKey': '!MUST_NOT_RUN SECRET_COMMAND',
                'searxngHeaders': {'Authorization': 'SECRET_HEADER'},
                'openaiResponsesUrl': 'https://user:SECRET_PASSWORD@example.invalid/api?key=SECRET_QUERY'}))
            before = cfg.read_bytes()
            result = inspect(agent, cfg)
            rendered = json.dumps(result)
            self.assertNotIn('SECRET_', rendered)
            self.assertNotIn('MUST_NOT_RUN', rendered)
            self.assertEqual(result['credentialSources']['jinaApiKey'], 'command-reference')
            self.assertEqual(result['packages'][0]['version'], 'fixture')
            self.assertTrue(result['packages'][0]['localPageAnswerDefaultsPresent'])
            self.assertEqual(result['values']['pageAnswer']['reasoning'], 'low')
            self.assertEqual(before, cfg.read_bytes())

    def test_invalid_json_does_not_echo_secret(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'web-search.json'
            p.write_text('{SECRET_VALUE')
            with self.assertRaises(ValueError) as caught:
                read_json(p)
            self.assertNotIn('SECRET_VALUE', str(caught.exception))

if __name__ == '__main__':
    unittest.main()
