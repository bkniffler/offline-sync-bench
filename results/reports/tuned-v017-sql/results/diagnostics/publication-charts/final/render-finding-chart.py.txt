"""Render the validated chart export with Matplotlib. Writes SVG, PNG and a receipt.

python scripts/render-finding-chart.py INPUT.json OUTPUT.svg
Run after collection; include the input and receipt with the chart's evidence.
"""
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
import textwrap

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

source, output = map(Path, sys.argv[1:])
assert output.suffix == '.svg'
png, receipt_path = output.with_suffix('.png'), output.with_suffix('.json')
assert len({source.resolve(), output.resolve(), png.resolve(), receipt_path.resolve()}) == 4
assert not any(p.exists() for p in [output, png, receipt_path]), 'Refuse to overwrite a figure'
raw = source.read_bytes()
data = json.loads(raw)
assert data['kind'] == 'reviewed-three-attempt-chart' and data['version'] == 1
groups = data['groups']
assert groups and all(g['rows'] for g in groups)
columns = len(groups[0]['rows'][0]['metrics'])
assert 1 <= columns <= 3
spec = [(m['key'], m['label'], m['unit']) for m in groups[0]['rows'][0]['metrics']]
for group in groups:
    for row in group['rows']:
        assert row['attempted'] == 3 and 0 <= row['passed'] <= 3
        assert [(m['key'], m['label'], m['unit']) for m in row['metrics']] == spec
        for metric in row['metrics']:
            values, summary = metric['values'], metric['summary']
            assert len(values) <= 3 and all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in values)
            if summary is None:
                assert not values
            else:
                assert row['latestOutcome'] == 'completed' and len(values) == row['passed'] == summary['trials']
                assert summary['confidence95'] is None
                assert (min(values), statistics.median(values), max(values)) == (summary['min'], summary['median'], summary['max'])

plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'svg.fonttype': 'none',
                     'svg.hashsalt': hashlib.sha256(raw).hexdigest(), 'axes.spines.top': False,
                     'axes.spines.right': False, 'axes.spines.left': False})
# Dedicated header, profile and footer rows keep long text out of plot areas.
title_lines = textwrap.wrap(data['question'], 88)
subtitle_lines = textwrap.wrap(f"{data['workload']} Host: {data['host']}. Network: {data['network']['id']}.", 140)
header_height = len(title_lines) * 0.25 + len(subtitle_lines) * 0.18 + 0.20
heights = [header_height]
for group in groups:
    heights.extend([max(0.28, len(textwrap.wrap(group['profile'], 140)) * 0.17), max(2.0, len(group['rows']) * 0.60 + 0.8)])
heights.append(0.95)
fig = plt.figure(figsize=(max(8.5, columns * 4.3), sum(heights) + 0.3 * (len(heights) - 1)))
outer = fig.add_gridspec(len(heights), 1, height_ratios=heights, left=0.025, right=0.98, bottom=0.025, top=0.98, hspace=0.42)
header = fig.add_subplot(outer[0]); header.axis('off')
header.text(0, 1, '\n'.join(title_lines), fontsize=16, fontweight='bold', va='top')
header.text(0, (len(subtitle_lines) * 0.18) / header_height, '\n'.join(subtitle_lines), fontsize=9, va='top')
for i, group in enumerate(groups):
    profile_ax = fig.add_subplot(outer[1 + i * 2]); profile_ax.axis('off')
    profile_ax.text(0, 0.5, textwrap.fill(group['profile'], 140), fontsize=9, color='#444444', va='center')
    rows = group['rows']
    inner = outer[2 + i * 2].subgridspec(1, columns + 1, width_ratios=[2.7] + [3.6] * columns, wspace=0.30)
    labels_ax = fig.add_subplot(inner[0]); labels_ax.set_ylim(len(rows) - 0.35, -0.65); labels_ax.axis('off')
    for y, row in enumerate(rows):
        path = row['execution'] if row['execution'] != 'unspecified' else row['storage']
        detail = path if path == row['storage'] else f"{path}; {row['storage']}"
        label = f"{row['stack']}  {row['passed']}/{row['attempted']} passed\n" + textwrap.fill(detail, 38)
        labels_ax.text(0.98, y, label, transform=labels_ax.get_yaxis_transform(), ha='right', va='center', fontsize=8)
    for j, (key, label, unit) in enumerate(spec):
        ax = fig.add_subplot(inner[j + 1])
        values = [v for row in rows for v in row['metrics'][j]['values']]
        log = bool(values) and min(values) > 0 and max(values) / min(values) >= 100
        if log:
            ax.set_xscale('log')
        ax.set_title(label, loc='left', fontsize=12, pad=13)
        ax.set_xlabel(unit + (' · logarithmic scale' if log else ''))
        ax.grid(axis='x', alpha=0.18); ax.set_axisbelow(True)
        ax.set_ylim(len(rows) - 0.35, -0.65); ax.set_yticks([])
        for y, row in enumerate(rows):
            metric = row['metrics'][j]
            summary = metric['summary']
            if summary is None:
                ax.text(0.03, y, metric['status'], transform=ax.get_yaxis_transform(), color='#9f352c', va='center')
                continue
            low, middle, high = summary['min'], summary['median'], summary['max']
            ax.hlines(y, low, high, color='#246d8c', linewidth=2)
            # Deterministic vertical offsets reveal coincident trial values.
            n = len(metric['values'])
            for k, value in enumerate(metric['values']):
                ax.scatter(value, y + (k - (n - 1) / 2) * 0.11, s=25, color='#246d8c', alpha=0.65, zorder=3)
            ax.scatter(middle, y, marker='D', s=36, color='#173f51', zorder=4)
        if not values:
            # A failure is not a 0–1 ms measurement.
            ax.set_xticks([])
            ax.set_xlabel('No eligible timing')
            ax.spines['bottom'].set_visible(False)
        elif not log:
            ax.set_xlim(0, max(values) * 1.10 if max(values) else 1)
        else:
            ax.set_xlim(min(values) / 1.2, max(values) * 1.2)
        ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f'{x:g}'))
footer = fig.add_subplot(outer[-1]); footer.axis('off')
footer.text(0, 0.75, 'Dots: independent trial values. Diamond: median. Line: observed min–max, not a confidence interval.\n'
            'Operation percentiles summarize each trial. Failed latest attempts supply no timing estimate.\n'
            'Profiles and configured order are preserved; full evidence and source bindings accompany the chart.', fontsize=9, va='top')
fig.savefig(output, metadata={'Date': None}, bbox_inches='tight')
fig.savefig(png, dpi=160, metadata={'Software': 'Matplotlib ' + matplotlib.__version__}, bbox_inches='tight')
plt.close(fig)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
receipt_path.write_text(json.dumps({'input': str(source), 'inputSha256': sha(source),
    'rendererSha256': sha(Path(__file__)), 'matplotlibVersion': matplotlib.__version__,
    'campaignId': data['campaignId'], 'sourceHash': data['sourceHash'], 'annotationId': data['annotationId'],
    'outputs': {p.name: sha(p) for p in [output, png]},
    'review': 'Rendered from validated export; visual inspection is still required.'}, indent=2) + '\n')
