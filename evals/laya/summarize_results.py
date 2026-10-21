"""Refresh classification metrics and attach the exact model provenance."""
import json
from pathlib import Path
from evaluate import summarize

root = Path(__file__).parent
manifest = json.loads((root / "model-manifest.json").read_text())
for filename in ["multilingual-cpu.json", "multilingual-atomic-cpu.json"]:
    path = root / "results" / filename
    run = json.loads(path.read_text())
    run["model_provenance"] = manifest
    for variant, groups in run["summary"].items():
        for group in groups:
            groups[group] = summarize([r for r in run["rows"] if r["variant"] == variant and r["group"] == group])
    path.write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n")
    print(filename)
    for group, metrics in run["summary"]["original"].items():
        print(group, metrics["correct"], '/', metrics["count"], 'balanced', round(metrics['balanced_accuracy'], 3),
              'A-recall', metrics['per_label']['A']['recall'])
