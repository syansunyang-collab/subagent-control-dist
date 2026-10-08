"""Audit completed replay records and calculate observed input-cost break-even.

The counterfactual holds the final request content fixed. It does not estimate task
quality, refetch, actual subscription points, or future cache availability.
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path('test-results/cache-replay-20260927')
summary = []
capabilities = []
audit_failures = []
for file in sorted(ROOT.glob('*.jsonl')):
    rows = [json.loads(s) for s in file.read_text(encoding='utf-8').splitlines() if s.strip()]
    capability = next((r for r in rows if r['kind'] == 'capability_manifest'), None)
    if capability:
        complete = next((r for r in rows if r['kind'] == 'capability_complete'), None)
        trials = [r for r in rows if r['kind'] == 'capability_trial']
        checks = {
            'completed_and_counted': complete is not None and complete['calls'] == len(trials),
            'one_frame_per_request': all(len(t['wire']) == 1 for t in trials),
            'no_transport_errors': not any(r['kind'] in ['socket_error', 'probe_error', 'request'] for r in rows),
            'no_tool_calls': all(all(b['type'] != 'toolCall' for b in t['outputBlocks']) for t in trials),
            'usage_reconciles': all(
                t['rawUsage']['input_tokens'] == t['usage']['input'] + t['usage']['cacheRead']
                and t['rawUsage']['output_tokens'] == t['usage']['output']
                for t in trials if t['rawUsage']),
        }
        capability_rows = []
        for t in trials:
            raw = t['rawUsage']
            capability_rows.append({
                'variant': t['variant'], 'repeat': t['repeat'], 'success': t['success'],
                'inputTokens': raw['input_tokens'] if raw else None,
                'cachedTokens': raw.get('input_tokens_details', {}).get('cached_tokens') if raw else None,
                'outputTokens': raw['output_tokens'] if raw else None,
                'reportedUsageCatalogEstimate': t['usage']['cost']['total'] if raw else None,
                'wire': t['wire'],
                'errors': [{k: e.get(k) for k in ['code', 'param']} for e in t['serverErrors']],
            })
        capabilities.append({'run': file.stem, 'model': capability['model'], 'complete': complete is not None,
            'calls': len(trials), 'withUsage': sum(t['rawUsage'] is not None for t in trials),
            'withoutUsage': sum(t['rawUsage'] is None for t in trials),
            'reportedUsageCatalogEstimate': sum(t['usage']['cost']['total'] for t in trials if t['rawUsage']),
            'trials': capability_rows, 'validations': checks})
        failed = [k for k, v in checks.items() if not v]
        if failed:
            audit_failures.append((file.stem, failed))
        continue
    manifest = next((r for r in rows if r['kind'] == 'manifest'), None)
    complete = next((r for r in rows if r['kind'] == 'complete'), None)
    trials = {r['stage']: r for r in rows if r['kind'] == 'trial'}
    if not manifest or not complete:
        summary.append({'run': file.stem, 'complete': False})
        continue
    full, edit, repeat = [trials[k] for k in ['full-control', 'history-edit', 'edited-repeat']]
    def input_cost(row):
        c = row['usage']['cost']
        return c['input'] + c['cacheRead'] + c['cacheWrite']
    released = sum(full['usage'][k] - edit['usage'][k] for k in ['input', 'cacheRead', 'cacheWrite'])
    penalty = input_cost(edit) - input_cost(full)
    steady_saving = input_cost(full) - input_cost(repeat)
    late_seed_cost = trials['prefix-seed']['usage']['cost']['total'] if manifest['mode'] == 'late-seeded' else 0
    validations = {
        'all_success': all(t['success'] for t in trials.values()),
        'stable_request_settings': len({t['logical']['settingsSha'] for t in trials.values()}) == 1,
        'single_connection': len({t['wire']['connectionId'] for t in trials.values()}) == 1,
        'one_frame_per_request': all(t['wire']['frameCount'] == 1 for t in trials.values()),
        'cold_first_request': next(iter(trials.values()))['usage']['cacheRead'] == 0,
        'control_same_logical_input': full['logical']['firstDiff'] == full['logical']['inputItems'],
        'control_full_send': not full['wire']['hasPreviousResponseId'],
        'edit_full_send': not edit['wire']['hasPreviousResponseId'],
        'attribution_presence': all(t['wire']['hasTurnId'] == (manifest['patch'] == 'on') for t in trials.values()),
        'no_transport_errors': not any(r['kind'] in ['socket_error','probe_error'] for r in rows),
    }
    summary.append({'run': file.stem, 'complete': True, 'model': manifest['model'], 'effort': manifest['effort'],
        'patch': manifest['patch'], 'mode': manifest['mode'], 'scale': manifest['scale'],
        'calls': complete['calls'], 'firstDiff': edit['logical']['firstDiff'],
        'endingsFromDiff': edit['logical'].get('endingsFromDiff'),
        'contextBefore': full['usage']['input'] + full['usage']['cacheRead'],
        'contextAfter': edit['usage']['input'] + edit['usage']['cacheRead'],
        'cacheBefore': full['usage']['cacheRead'], 'cacheAfter': edit['usage']['cacheRead'],
        'uncachedAfter': edit['usage']['input'], 'recoveredCache': repeat['usage']['cacheRead'],
        'releasedProviderTokens': released, 'editInputCost': input_cost(edit),
        'unprunedControlInputCost': input_cost(full), 'repeatInputCost': input_cost(repeat),
        'editPenaltyAgainstUnprunedControl': penalty, 'steadySavingPerIdenticalRequest': steady_saving,
        'lateSeedTotalCost': late_seed_cost,
        'pruneInterventionTotalCost': edit['usage']['cost']['total'] + late_seed_cost,
        'subsequentIdenticalRequestsToBreakEven': max(0, math.ceil((penalty+late_seed_cost)/steady_saving)) if steady_saving > 0 else None,
        'runLocalCatalogCost': complete['totalLocalCost'], 'validations': validations})
ROOT.joinpath('summary.json').write_text(json.dumps({'runs': summary,
    'costBasis': 'Pi installed model catalog; not subscription-point billing.',
    'breakEvenBasis': 'One edit input penalty vs unpruned full control, including the full extra seed cost in late-seeded mode, then observed identical-request input savings. Earlier seeded-mode prefix cost is included in run totals only. No further edits, refetch, or background misses assumed.'}, indent=2), encoding='utf-8')
ROOT.joinpath('capability-summary.json').write_text(json.dumps({'runs': capabilities,
    'calls': sum(r['calls'] for r in capabilities),
    'withUsage': sum(r['withUsage'] for r in capabilities),
    'withoutUsage': sum(r['withoutUsage'] for r in capabilities),
    'reportedUsageCatalogEstimate': sum(r['reportedUsageCatalogEstimate'] for r in capabilities),
    'costBasis': 'Arithmetic conversion of reported token usage using the installed Pi catalog. In particular generate=false usage is not proven billable. Missing usage is unknown, not zero.'}, indent=2), encoding='utf-8')
for r in summary:
    if r['complete']:
        print(json.dumps({k:r[k] for k in ['run','cacheBefore','cacheAfter','releasedProviderTokens','subsequentIdenticalRequestsToBreakEven','runLocalCatalogCost']},ensure_ascii=False))
        failed = [k for k,v in r['validations'].items() if not v]
        if failed:
            print('AUDIT:', r['run'], failed)
            audit_failures.append((r['run'], failed))
print('Total completed calls:',sum(r.get('calls',0) for r in summary))
print('Total completed local cost:',sum(r.get('runLocalCatalogCost',0) for r in summary))
if audit_failures:
    sys.exit(1)
